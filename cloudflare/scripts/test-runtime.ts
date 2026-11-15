import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { connectMcp } from "../agent/src/mcp-client";

// Real workerd + SQLite-backed DOs, without cloud credentials or launching Chromium.
// Run npm run build first. Browser binding is intentionally absent in this harness.
const token = "runtime-test-only-".repeat(3);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: "browser",
        modules: true,
        scriptPath: resolve("dist/browser/index.js"),
        compatibilityDate: "2026-11-13",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          MCP_API_TOKEN: token,
          ALLOWED_DOMAINS: "demo.playwright.dev",
          ASSET_DOMAINS: "",
        },
        durableObjects: {
          BROWSER_SESSION: { className: "BrowserSession", useSQLite: true },
        },
      },
      {
        name: "agent",
        modules: true,
        scriptPath: resolve("dist/agent/index.js"),
        compatibilityDate: "2026-11-13",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          AGENT_API_TOKEN: token,
          MCP_API_TOKEN: token,
          OPENAI_API_KEY: "runtime-test-not-a-real-key",
          BROWSER_WORKER_URL: "https://browser.example.com",
          OPENAI_MODEL: "gpt-4.1-mini",
        },
        durableObjects: {
          RUN_COORDINATOR: { className: "RunCoordinator", useSQLite: true },
        },
        serviceBindings: { MCP_BROWSER: "browser" },
        outboundService: "openai-stub",
      },
      {
        name: "openai-stub",
        modules: true,
        compatibilityDate: "2026-11-13",
        script: `export default { fetch() { return Response.json({
      id: 'resp_test', object: 'response', status: 'completed', usage: { total_tokens: 11 },
      output: [{ id: 'msg_test', type: 'message', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', annotations: [], text: JSON.stringify({ status: 'blocked', summary: 'Controlled runtime test.', evidence: [] }) }] }]
    }); } };`,
      },
    ],
  }),
);
try {
  const browser = await mf.getWorker("browser");
  const agent = await mf.getWorker("agent");
  const headers = { Authorization: `Bearer ${token}` };
  const bfetch = async (input: RequestInfo | URL, init?: RequestInit) =>
    browser.fetch(input as string, init as any) as unknown as Promise<Response>;
  const client = await connectMcp(
    "http://127.0.0.1/mcp",
    token,
    undefined,
    bfetch,
  );
  try {
    assert.equal((await client.listTools()).tools.length, 7);
  } finally {
    await client.close();
  }
  const lease = (await (
    await browser.fetch("https://runtime.example.com/sessions", {
      method: "POST",
      headers,
    })
  ).json()) as { session_id: string };
  assert.ok(lease.session_id);
  assert.equal(
    (
      await browser.fetch("https://runtime.example.com/sessions", {
        method: "POST",
        headers,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await browser.fetch("https://runtime.example.com/sessions", {
        method: "DELETE",
        headers: { ...headers, "X-AgentPilot-Session": lease.session_id },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await agent.fetch("https://runtime.example.com/agent/run", {
        method: "POST",
      })
    ).status,
    401,
  );
  const rejected = await agent.fetch("https://runtime.example.com/agent/run", {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Idempotency-Key": "runtime-test",
    },
    body: JSON.stringify({ instruction: "" }),
  });
  assert.equal(rejected.status, 400);
  const accepted = await agent.fetch("https://runtime.example.com/agent/run", {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Idempotency-Key": "runtime-test",
    },
    body: JSON.stringify({
      instruction: "Report blocked without opening a browser.",
    }),
  });
  assert.equal(accepted.status, 202);
  const { run_id } = (await accepted.json()) as { run_id: string };
  let record: { status: string; error_code?: string; error_type?: string };
  const deadline = Date.now() + 15000;
  do {
    await setTimeout(50);
    record = (await (
      await agent.fetch(`https://runtime.example.com/runs/${run_id}`, {
        headers,
      })
    ).json()) as typeof record;
    assert.ok(Date.now() < deadline, "Runtime alarm execution did not finish");
  } while (["queued", "running"].includes(record.status));
  assert.equal(
    record.status,
    "blocked",
    `Unexpected run error: ${record.error_code} (${record.error_type})`,
  );
  console.log(
    "PASS: real Workers runtime, MCP protocol/service binding, SQLite leases, RPC errors, background alarms, and agent execution with a stubbed model. No browser or paid OpenAI calls.",
  );
} finally {
  await mf.dispose();
}
