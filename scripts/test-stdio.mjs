/**
 * The stdio entry point starts without a key, speaks clean JSON-RPC on stdout,
 * lists the same six tools as the HTTP endpoint, and reports a missing key as
 * a tool error rather than crashing. Needs no network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TOOLS = [
  "valyu_contents",
  "valyu_datasources",
  "valyu_deepresearch",
  "valyu_deepresearch_control",
  "valyu_deepresearch_status",
  "valyu_search",
];

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["node_modules/tsx/dist/cli.mjs", "stdio.ts"],
    // An unreachable base URL keeps the test offline and deterministic.
    env: { PATH: process.env.PATH ?? "", VALYU_BASE_URL: "http://127.0.0.1:9", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "1" });
  await client.connect(transport);
  return client;
}

test("starts without a key and lists the six public tools", async () => {
  const client = await connect({});
  try {
    const info = client.getServerVersion();
    assert.equal(info?.name, "valyu-mcp");
    assert.match(client.getInstructions() ?? "", /valyu_search/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOLS);
    for (const tool of tools) assert.ok(tool.annotations?.title, `${tool.name} has no title`);
  } finally {
    await client.close();
  }
});

test("a tool call that cannot reach the API returns a tool error", async () => {
  const client = await connect({ VALYU_API_KEY: "test-only" });
  try {
    const result = await client.callTool({
      name: "valyu_contents",
      arguments: { urls: ["https://example.com"] },
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.length > 0);
  } finally {
    await client.close();
  }
});
