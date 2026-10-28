import importlib.util
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import create_autospec

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from valyu import Valyu


SERVER = Path(__file__).with_name("valyu-mcp.py")


class GlamaStartupTests(unittest.IsolatedAsyncioTestCase):
    async def test_introspection_without_credentials(self):
        env = dict(os.environ)
        env.pop("VALYU_API_KEY", None)
        parameters = StdioServerParameters(
            command=sys.executable, args=[str(SERVER)], env=env
        )
        await self.assert_introspection(parameters)

    @unittest.skipUnless(os.getenv("VALYU_MCP_TEST_IMAGE"), "Docker image not specified")
    async def test_container_introspection_without_credentials_or_network(self):
        parameters = StdioServerParameters(
            command="docker",
            args=["run", "--rm", "-i", "--network=none", os.environ["VALYU_MCP_TEST_IMAGE"]],
        )
        await self.assert_introspection(parameters)

    async def assert_introspection(self, parameters):
        async with stdio_client(parameters) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = await session.list_tools()
                self.assertEqual([tool.name for tool in tools.tools], ["valyu_context"])
                self.assertIn("query", tools.tools[0].inputSchema["required"])
                result = await session.call_tool("valyu_context", {"query": "test"})
                self.assertIn("VALYU_API_KEY", result.content[0].text)

    async def test_current_sdk_search_signature_and_result_format(self):
        spec = importlib.util.spec_from_file_location("valyu_server", SERVER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.valyu = create_autospec(Valyu, instance=True)
        module.valyu.search.return_value = SimpleNamespace(
            results=[SimpleNamespace(title="Example", content="Evidence", url="https://example.com")]
        )
        result = await module.valyu_context("test", max_num_results=10)
        module.valyu.search.assert_called_once_with(
            query="test", search_type="all", max_num_results=5, max_price=10
        )
        self.assertEqual(result, "Title: Example\nContent: Evidence\nURL: https://example.com")


if __name__ == "__main__":
    unittest.main()
