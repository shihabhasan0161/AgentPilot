import { describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ launch: vi.fn(), connect: vi.fn() }));
vi.mock("@cloudflare/playwright", () => fake);
import { BrowserSession, type BrowserEnv } from "../src/browser-session";
import { memoryState } from "../../shared/test-storage";

describe("browser tool adapter", () => {
  it("uses guarded cloud sessions, exact locators, snapshots, and verified cleanup", async () => {
    let routeHandler: (route: unknown) => Promise<void>;
    const snapshot = vi
      .fn()
      .mockResolvedValue('- textbox "What needs to be done?"');
    const locator: Record<string, any> = {
      first: () => locator,
      or: () => locator,
      waitFor: vi.fn().mockResolvedValue(undefined),
      ariaSnapshot: snapshot,
      click: vi.fn(),
      fill: vi.fn(),
    };
    const page = {
      isClosed: () => false,
      goto: vi.fn(),
      url: () => "https://demo.playwright.dev/todomvc",
      title: async () => "TodoMVC",
      locator: () => locator,
      getByRole: vi.fn(() => locator),
      getByText: vi.fn(() => locator),
      getByLabel: () => locator,
      getByPlaceholder: () => locator,
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      on: vi.fn(),
      keyboard: { press: vi.fn() },
      waitForLoadState: vi.fn(),
    };
    const context = {
      route: vi.fn(async (_: string, handler: any) => {
        routeHandler = handler;
      }),
      routeWebSocket: vi.fn(),
      on: vi.fn(),
      newPage: async () => page,
    };
    const browser = {
      isConnected: () => true,
      sessionId: () => "cloud-id",
      newContext: async () => context,
      close: vi.fn(),
    };
    fake.launch.mockResolvedValue(browser);
    const session = new BrowserSession(memoryState().ctx, {
      ALLOWED_DOMAINS: "demo.playwright.dev",
      ASSET_DOMAINS: "www.gstatic.com,forms.guest.usercontent.microsoft",
    } as BrowserEnv);
    const lease = await session.acquire();
    await session.execute(lease.session_id, "open_page", {
      url: "https://demo.playwright.dev/todomvc",
    });
    expect(fake.launch).toHaveBeenCalledWith(undefined, {
      keep_alive: 60000,
      guardrails: {
        allowedDomains: [
          "demo.playwright.dev",
          "www.gstatic.com",
          "forms.guest.usercontent.microsoft",
        ],
      },
    });
    await session.execute(lease.session_id, "click", {
      role: "checkbox",
      name: "Task",
    });
    expect(page.getByRole).toHaveBeenCalledWith("checkbox", {
      name: "Task",
      exact: true,
    });
    await session.execute(lease.session_id, "page_snapshot", {
      wait_for_text: "Your response was submitted.",
      timeout_ms: 30000,
    });
    expect(page.getByText).toHaveBeenCalledWith(
      "Your response was submitted.",
      { exact: false },
    );
    expect(locator.waitFor).toHaveBeenLastCalledWith({
      state: "visible",
      timeout: 30000,
    });
    locator.waitFor.mockRejectedValueOnce(
      Object.assign(new Error("not visible"), { name: "TimeoutError" }),
    );
    await expect(
      session.execute(lease.session_id, "page_snapshot", {
        wait_for_text: "Confirmation",
      }),
    ).rejects.toThrow("verification_timeout");
    expect(locator.click).toHaveBeenCalledOnce();
    const proceed = vi.fn();
    await routeHandler!({
      request: () => ({
        url: () => "https://www.gstatic.com/forms/script.js",
        isNavigationRequest: () => false,
      }),
      continue: proceed,
    });
    expect(proceed).toHaveBeenCalledOnce();
    await routeHandler!({
      request: () => ({
        url: () =>
          "https://forms.guest.usercontent.microsoft/formapi/responses",
        isNavigationRequest: () => false,
      }),
      continue: proceed,
    });
    expect(proceed).toHaveBeenCalledTimes(2);
    const assetNavigationAbort = vi.fn();
    await routeHandler!({
      request: () => ({
        url: () => "https://www.gstatic.com/",
        isNavigationRequest: () => true,
        frame: () => ({ parentFrame: () => null }),
      }),
      abort: assetNavigationAbort,
    });
    expect(assetNavigationAbort).toHaveBeenCalledWith("blockedbyclient");
    const abort = vi.fn();
    await routeHandler!({
      request: () => ({
        url: () => "https://evil.org",
        isNavigationRequest: () => true,
        frame: () => ({ parentFrame: () => null }),
      }),
      abort,
    });
    expect(abort).toHaveBeenCalledWith("blockedbyclient");
    await expect(
      session.execute(lease.session_id, "page_snapshot"),
    ).rejects.toThrow("navigation_blocked");
    await session.release(lease.session_id);
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
