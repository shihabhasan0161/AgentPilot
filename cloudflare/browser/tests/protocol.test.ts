import { describe, expect, it, vi } from "vitest";
vi.mock("@cloudflare/playwright", () => ({
  launch: vi.fn(),
  connect: vi.fn(),
}));
import worker from "../src/index";
import type { BrowserEnv } from "../src/browser-session";
import { connectMcp } from "../../agent/src/mcp-client";

describe("MCP HTTP protocol", () => {
  it("initializes, discovers all interfaces without allocating, and invokes a leased tool", async () => {
    const execute = vi.fn().mockResolvedValue('- checkbox "Task" [checked]');
    const acquire = vi.fn();
    const env = {
      MCP_API_TOKEN: "x".repeat(40),
      ALLOWED_DOMAINS: "demo.playwright.dev",
      ASSET_DOMAINS: "",
      BROWSER_SESSION: { getByName: () => ({ execute, acquire }) },
    } as unknown as BrowserEnv;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      req.headers.set("Host", new URL(req.url).host); // Supplied by the real HTTP/service-binding runtime.
      return worker.fetch(req, env, ctx);
    };
    const client = await connectMcp(
      "https://browser.example.com/mcp",
      env.MCP_API_TOKEN,
      "lease",
      fetcher,
    );
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          "open_page",
          "fill",
          "click",
          "page_snapshot",
          "press_key",
          "screenshot",
          "close_browser",
        ]),
      );
      expect((await client.listResources()).resources[0].uri).toBe(
        "browser://current-page",
      );
      expect((await client.listPrompts()).prompts[0].name).toBe(
        "test_user_flow",
      );
      const prompt = await client.getPrompt({
        name: "test_user_flow",
        arguments: { url: "https://page.example.com", goal: "inspect the page" },
      });
      expect(prompt.messages[0]).toMatchObject({
        role: "user",
        content: {
          type: "text",
          text: "Open https://page.example.com and try to: inspect the page. Inspect snapshots, verify the final state, and report observations.",
        },
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      const result = await client.callTool({
        name: "page_snapshot",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(execute).toHaveBeenCalledWith("lease", "page_snapshot", {});
      execute.mockRejectedValueOnce(new Error("destination_not_allowed"));
      expect(
        await client.callTool({
          name: "open_page",
          arguments: { url: "https://blocked.org" },
        }),
      ).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "destination_not_allowed" }],
      });
      execute.mockRejectedValueOnce(new Error("private runtime details"));
      expect(
        await client.callTool({ name: "page_snapshot", arguments: {} }),
      ).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "browser_action_failed" }],
      });
    } finally {
      await client.close();
    }
    expect(
      (await fetcher("https://browser.example.com/mcp", { method: "POST" }))
        .status,
    ).toBe(401);
  });
});
