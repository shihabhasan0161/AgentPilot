import { describe, expect, it } from "vitest";
import { domains, policy, validateUrl } from "../src/policy";
import {
  authorize,
  boundedText,
  errorResponse,
  readJson,
} from "../../shared/contracts";

describe("destination policy", () => {
  it("requires a nonempty public exact-host allowlist", () => {
    for (const value of [
      "",
      "localhost",
      "127.0.0.1",
      "[::1]",
      "*.example.com",
      "demo.playwright.dev:443",
      "host.internal",
      "demo.playwright.dev/",
    ])
      expect(() => domains(value)).toThrow();
    expect(domains("Demo.Playwright.Dev,demo.playwright.dev")).toEqual([
      "demo.playwright.dev",
    ]);
  });
  it("separates navigation from asset access", () => {
    const p = policy("demo.playwright.dev", "cdn.jsdelivr.net");
    expect(
      validateUrl("https://cdn.jsdelivr.net/a.js", p.requests).hostname,
    ).toBe("cdn.jsdelivr.net");
    expect(() => validateUrl("https://cdn.jsdelivr.net", p.navigate)).toThrow();
  });
  it("rejects schemes, credentials, ports, subdomains and lookalikes", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pass@demo.playwright.dev",
      "https://demo.playwright.dev:8080",
      "https://demo.playwright.dev.evil.org",
      "https://sub.demo.playwright.dev",
      "https://demo.playwright.dev./",
    ])
      expect(() => validateUrl(url, ["demo.playwright.dev"])).toThrow();
    expect(
      validateUrl("https://demo.playwright.dev/todomvc", [
        "demo.playwright.dev",
      ]).pathname,
    ).toBe("/todomvc");
  });
});
describe("HTTP boundaries", () => {
  const token = "x".repeat(40);
  it("requires configured secrets and exact bearer authorization", async () => {
    await expect(
      authorize(new Request("https://test"), undefined),
    ).rejects.toThrow("secret_not_configured");
    await expect(authorize(new Request("https://test"), token)).rejects.toThrow(
      "unauthorized",
    );
    await expect(
      authorize(
        new Request("https://test", {
          headers: { Authorization: `Bearer ${token}` },
        }),
        token,
      ),
    ).resolves.toBeUndefined();
  });
  it("bounds streamed JSON even without content length", async () => {
    const req = (body: string) =>
      new Request("https://test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    await expect(
      readJson(req(JSON.stringify({ value: "x".repeat(9000) }))),
    ).rejects.toThrow("body_too_large");
    await expect(readJson(req("{"))).rejects.toThrow("invalid_json");
    expect(boundedText("123456", 3)).toContain("TRUNCATED");
  });
  it("preserves known RPC error statuses and hides raw errors", async () => {
    expect(errorResponse(new Error("busy")).status).toBe(409);
    expect(
      await errorResponse(new Error("secret contents")).text(),
    ).not.toContain("secret contents");
  });
});
