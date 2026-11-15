import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryState } from "../../shared/test-storage";
const fake = vi.hoisted(() => ({ launch: vi.fn(), connect: vi.fn() }));
vi.mock("@cloudflare/playwright", () => fake);
import { BrowserSession, type BrowserEnv } from "../src/browser-session";

function setup(state = memoryState()) {
  const session = new BrowserSession(state.ctx, {
    ALLOWED_DOMAINS: "demo.playwright.dev",
    ASSET_DOMAINS: "",
  } as BrowserEnv);
  return { session, state };
}
beforeEach(() => vi.resetAllMocks());
describe("exclusive browser leases", () => {
  it("reserves ownership without launching, prevents overlap, and closes idempotently", async () => {
    const { session } = setup();
    const lease = await session.acquire();
    expect(fake.launch).not.toHaveBeenCalled();
    await expect(session.acquire()).rejects.toThrow("busy");
    await expect(session.execute("wrong", "page_snapshot")).rejects.toThrow(
      "invalid_session",
    );
    await session.release(lease.session_id);
    await session.release(lease.session_id);
    expect((await session.acquire()).session_id).not.toBe(lease.session_id);
  });
  it("rejects invalid destinations before browser allocation", async () => {
    const { session } = setup();
    const lease = await session.acquire();
    await expect(
      session.execute(lease.session_id, "open_page", {
        url: "http://localhost",
      }),
    ).rejects.toThrow("destination_not_allowed");
    expect(fake.launch).not.toHaveBeenCalled();
  });
  it("fails closed after eviction instead of recreating the browser", async () => {
    const { session, state } = setup();
    const lease = await session.acquire();
    state.data.set("lease", {
      id: lease.session_id,
      expires: Date.now() + 10000,
      started: true,
      cloudId: "remote",
    });
    const restored = setup(state).session;
    await expect(
      restored.execute(lease.session_id, "page_snapshot"),
    ).rejects.toThrow("browser_session_lost");
    expect(fake.launch).not.toHaveBeenCalled();
    fake.connect.mockRejectedValue(new Error("network failure"));
    await expect(restored.release(lease.session_id)).rejects.toThrow(
      "cleanup_unconfirmed",
    );
  });
  it("expires abandoned unstarted leases", async () => {
    const { session, state } = setup();
    const lease = await session.acquire();
    state.data.set("lease", { id: lease.session_id, expires: Date.now() - 1 });
    await session.alarm();
    expect(state.data.has("lease")).toBe(false);
  });
});
