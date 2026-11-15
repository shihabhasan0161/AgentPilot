import assert from "node:assert/strict";
import { connectMcp } from "../agent/src/mcp-client";
import { cli } from "./common";
const { url, token } = cli("MCP_API_TOKEN");
const endpoint = new URL("/mcp", url.origin).href;
const denied = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(denied.status, 401, "Unauthenticated MCP access must fail");
const invalid = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer invalid",
  },
  body: "{}",
});
assert.equal(invalid.status, 401, "Invalid MCP credentials must fail");
const client = await connectMcp(endpoint, token);
try {
  const tools = (await client.listTools()).tools;
  for (const name of [
    "open_page",
    "page_snapshot",
    "click",
    "fill",
    "press_key",
    "screenshot",
    "close_browser",
  ]) {
    assert.ok(
      tools.some(
        (tool) => tool.name === name && tool.inputSchema.type === "object",
      ),
      `Missing tool/schema: ${name}`,
    );
  }
  assert.ok(
    (await client.listResources()).resources.some(
      (r) => r.uri === "browser://current-page",
    ),
  );
  assert.ok(
    (await client.listPrompts()).prompts.some(
      (p) => p.name === "test_user_flow",
    ),
  );
  console.log(
    "PASS: authentication, MCP initialization, tools, resource, and prompt. No browser or model calls.",
  );
} finally {
  await client.close();
}
