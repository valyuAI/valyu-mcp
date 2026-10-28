import asyncio
import importlib.util
import json
import os
import sys
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import create_autospec, patch

import requests
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.server.fastmcp.exceptions import ToolError
from valyu import SearchResponse, Valyu

SERVER = Path(__file__).with_name("valyu-mcp.py")


def search_response(*, success=True, error=None, results=None):
    return SearchResponse(
        success=success,
        error=error,
        tx_id="test-transaction",
        query="test",
        results=[] if results is None else results,
        results_by_source={"web": 0, "proprietary": 0},
        total_deduction_dollars=0,
        total_characters=0,
    )


def search_result(content="Evidence", description=None):
    return {
        "title": "Example",
        "url": "https://example.com",
        "content": content,
        "description": description,
        "source": "web",
        "price": 0,
        "length": 0,
    }


class GlamaStartupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("valyu_server", SERVER)
        self.server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.server)
        self.client = create_autospec(Valyu, instance=True)
        self.client.search.return_value = search_response(results=[search_result()])
        self.server.valyu = self.client

    async def test_introspection_without_credentials(self):
        parameters = StdioServerParameters(
            command=sys.executable,
            args=[str(SERVER)],
            env={"VALYU_API_KEY": ""},
        )
        await asyncio.wait_for(self.assert_introspection(parameters), timeout=30)

    @unittest.skipUnless(
        os.getenv("VALYU_MCP_TEST_IMAGE"), "Docker image not specified"
    )
    async def test_container_introspection_without_credentials_or_network(self):
        parameters = StdioServerParameters(
            command="docker",
            args=[
                "run",
                "--rm",
                "-i",
                "--network=none",
                "-e",
                "VALYU_API_KEY=",
                os.environ["VALYU_MCP_TEST_IMAGE"],
            ],
        )
        await asyncio.wait_for(self.assert_introspection(parameters), timeout=30)

    async def assert_introspection(self, parameters):
        async with stdio_client(parameters) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = await session.list_tools()
                self.assertEqual([tool.name for tool in tools.tools], ["valyu_context"])
                schema = tools.tools[0].inputSchema
                self.assertIn("query", schema["required"])
                self.assertEqual(schema["properties"]["max_num_results"]["default"], 5)
                result = await session.call_tool("valyu_context", {"query": "test"})
                self.assertTrue(result.isError)
                self.assertIn("VALYU_API_KEY", result.content[0].text)

    async def test_current_sdk_search_signature_and_result_format(self):
        result = await self.server.valyu_context("test", max_num_results=10)
        self.client.search.assert_called_once_with(
            query="test", search_type="all", max_num_results=5, max_price=10
        )
        self.assertEqual(
            result, "Title: Example\nContent: Evidence\nURL: https://example.com"
        )

    async def test_real_sdk_http_request_contract(self):
        response = requests.Response()
        response.status_code = 200
        response._content = self.client.search.return_value.model_dump_json().encode()
        with (
            patch(
                "socket.socket.connect", side_effect=AssertionError("Network disabled")
            ),
            patch.object(
                requests.sessions.Session, "request", return_value=response
            ) as send,
        ):
            self.server.valyu = Valyu(api_key=uuid.uuid4().hex)
            result = await self.server.valyu_context("test")
        self.assertEqual(send.call_count, 1)
        self.assertEqual(
            send.call_args.args[:2], ("POST", "https://api.valyu.ai/v1/search")
        )
        payload = send.call_args.kwargs["json"]
        self.assertEqual(payload["query"], "test")
        self.assertEqual(payload["max_num_results"], 5)
        self.assertEqual(payload["max_price"], 10)
        self.assertNotIn("query_rewrite", payload)
        self.assertIn("Content: Evidence", result)

    async def test_unsuccessful_responses_raise_tool_errors(self):
        for error in (
            "Invalid API key",
            "Insufficient balance",
            "Rate limited",
            "Service unavailable",
        ):
            with self.subTest(error=error):
                self.client.search.return_value = search_response(
                    success=False, error=error
                )
                with self.assertRaisesRegex(ToolError, "Valyu search failed"):
                    await self.server.valyu_context("test")

    async def test_missing_response_raises_tool_error(self):
        self.client.search.return_value = None
        with self.assertRaises(ToolError):
            await self.server.valyu_context("test")

    async def test_empty_success_is_not_an_error(self):
        self.client.search.return_value = search_response()
        self.assertEqual(await self.server.valyu_context("test"), "No results found.")

    async def test_missing_credentials_raise_tool_error(self):
        self.server.valyu = None
        with self.assertRaisesRegex(ToolError, "VALYU_API_KEY"):
            await self.server.valyu_context("test")
        self.client.search.assert_not_called()

    async def test_blank_query_does_not_call_sdk(self):
        with self.assertRaisesRegex(ToolError, "must not be empty"):
            await self.server.valyu_context(" \t\n")
        self.client.search.assert_not_called()

    async def test_result_counts_are_bounded(self):
        for requested, expected in ((-1, 1), (0, 1), (3, 3), (100, 5)):
            with self.subTest(requested=requested):
                await self.server.valyu_context("test", max_num_results=requested)
                self.assertEqual(
                    self.client.search.call_args.kwargs["max_num_results"], expected
                )

    async def test_structured_content_is_valid_json(self):
        for content in ({"active": True, "value": None}, [{"value": 1}], {}, []):
            with self.subTest(content=content):
                self.client.search.return_value = search_response(
                    results=[search_result(content)]
                )
                result = await self.server.valyu_context("test")
                serialized = result.split("Content: ", 1)[1].split("\nURL:", 1)[0]
                self.assertEqual(json.loads(serialized), content)

    async def test_empty_content_uses_description_or_empty_string(self):
        for description, expected in (("Summary", "Summary"), (None, "")):
            with self.subTest(description=description):
                self.client.search.return_value = search_response(
                    results=[search_result("", description)]
                )
                result = await self.server.valyu_context("test")
                self.assertIn(f"Content: {expected}\nURL:", result)

    async def test_logs_exclude_queries_and_result_content(self):
        with self.assertLogs(self.server.logger, level="INFO") as captured:
            await self.server.valyu_context("private-query-sentinel")
        logs = "\n".join(captured.output)
        self.assertNotIn("private-query-sentinel", logs)
        self.assertNotIn("Evidence", logs)

    async def test_exception_details_are_not_exposed(self):
        self.client.search.side_effect = RuntimeError("private-error-sentinel")
        with self.assertLogs(self.server.logger, level="ERROR") as captured:
            with self.assertRaises(ToolError) as error:
                await self.server.valyu_context("test")
        self.assertNotIn("private-error-sentinel", str(error.exception))
        self.assertNotIn("private-error-sentinel", "\n".join(captured.output))

    async def test_sdk_call_does_not_block_event_loop(self):
        started = threading.Event()
        release = threading.Event()
        worker_threads = []

        def slow_search(**kwargs):
            worker_threads.append(threading.get_ident())
            started.set()
            release.wait(timeout=3)
            return search_response()

        self.client.search.side_effect = slow_search
        task = asyncio.create_task(self.server.valyu_context("test"))
        try:
            self.assertTrue(await asyncio.to_thread(started.wait, 1))
            self.assertFalse(task.done())
            self.assertNotEqual(worker_threads[0], threading.get_ident())
        finally:
            release.set()
            await task


if __name__ == "__main__":
    unittest.main()
