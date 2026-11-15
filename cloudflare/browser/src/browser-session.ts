import { DurableObject } from "cloudflare:workers";
import {
  launch,
  connect,
  type Browser,
  type Page,
} from "@cloudflare/playwright";
import {
  AppError,
  LIMITS,
  boundedText,
  type BrowserEvidence,
} from "../../shared/contracts";
import { policy, validateUrl } from "./policy";

export interface BrowserEnv {
  BROWSER: BrowserRun;
  BROWSER_SESSION: DurableObjectNamespace<BrowserSession>;
  MCP_API_TOKEN: string;
  ALLOWED_DOMAINS: string;
  ASSET_DOMAINS: string;
  VERSION?: { id: string };
}
interface Lease {
  id: string;
  expires: number;
  cloudId?: string;
  started?: boolean;
}
export type BrowserAction =
  | "open_page"
  | "page_snapshot"
  | "click"
  | "fill"
  | "press_key"
  | "screenshot"
  | "current_page";
export class BrowserSession extends DurableObject<BrowserEnv> {
  private browser?: Browser;
  private page?: Page;
  private pending: Promise<unknown> = Promise.resolve();
  private violation = false;
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.pending.then(fn);
    this.pending = result.catch(() => {});
    return result;
  }
  acquire(): Promise<{ session_id: string; expires_at: number }> {
    return this.exclusive(async () => {
      policy(this.env.ALLOWED_DOMAINS, this.env.ASSET_DOMAINS);
      const current = await this.ctx.storage.get<Lease>("lease");
      if (current) {
        if (current.expires > Date.now()) throw new AppError("busy", 409);
        await this.releaseUnlocked(current.id);
      }
      const lease: Lease = {
        id: crypto.randomUUID(),
        expires: Date.now() + LIMITS.leaseMs,
      };
      await this.ctx.storage.put("lease", lease);
      await this.ctx.storage.setAlarm(lease.expires);
      return { session_id: lease.id, expires_at: lease.expires };
    });
  }
  private async lease(id: string): Promise<Lease> {
    const lease = await this.ctx.storage.get<Lease>("lease");
    if (!lease || lease.id !== id) throw new AppError("invalid_session", 403);
    if (Date.now() >= lease.expires) throw new AppError("session_expired", 410);
    return lease;
  }
  private async getPage(lease: Lease): Promise<Page> {
    if (this.browser?.isConnected() && this.page && !this.page.isClosed())
      return this.page;
    if (lease.started) throw new AppError("browser_session_lost", 410);
    const last = (await this.ctx.storage.get<number>("lastLaunch")) ?? 0;
    if (Date.now() - last < LIMITS.sessionSpacingMs)
      throw new AppError("browser_rate_limit", 429);
    const allowed = policy(this.env.ALLOWED_DOMAINS, this.env.ASSET_DOMAINS);
    // Persist before side effects: a crash must never trigger a second browser launch.
    lease.started = true;
    await this.ctx.storage.put({ lease, lastLaunch: Date.now() });
    this.browser = await launch(this.env.BROWSER, {
      keep_alive: LIMITS.idleMs,
      guardrails: { allowedDomains: allowed.requests },
    });
    lease.cloudId = this.browser.sessionId();
    await this.ctx.storage.put("lease", lease);
    const context = await this.browser.newContext({ serviceWorkers: "block" });
    this.violation = false;
    await context.route("**/*", async (route) => {
      const request = route.request();
      try {
        validateUrl(request.url(), allowed.requests);
        if (
          request.isNavigationRequest() &&
          request.frame().parentFrame() === null
        ) {
          validateUrl(request.url(), allowed.navigate);
        }
        await route.continue();
      } catch {
        if (
          request.isNavigationRequest() &&
          request.frame().parentFrame() === null
        )
          this.violation = true;
        await route.abort("blockedbyclient");
      }
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    // Never allow an uncontrolled second tab to become the automation target.
    context.on("page", (page) => {
      if (this.page && page !== this.page) void page.close().catch(() => {});
    });
    this.page = await context.newPage();
    this.page.setDefaultTimeout(15_000);
    this.page.setDefaultNavigationTimeout(30_000);
    this.page.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => {});
    });
    return this.page;
  }
  private assertPage(page: Page): void {
    if (this.violation) throw new AppError("navigation_blocked", 403);
    validateUrl(
      page.url(),
      policy(this.env.ALLOWED_DOMAINS, this.env.ASSET_DOMAINS).navigate,
    );
  }
  private async snapshot(page: Page): Promise<string> {
    this.assertPage(page);
    return boundedText(await page.locator("body").ariaSnapshot());
  }
  execute(
    id: string,
    name: BrowserAction,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.exclusive(async () => {
      const lease = await this.lease(id);
      if (name !== "open_page" && !lease.started)
        throw new AppError("browser_not_open", 409);
      // Validate before allocating a browser.
      if (name === "open_page")
        validateUrl(
          String(args.url),
          policy(this.env.ALLOWED_DOMAINS, this.env.ASSET_DOMAINS).navigate,
        );
      const page = await this.getPage(lease);
      if (name !== "open_page") this.assertPage(page);
      switch (name) {
        case "open_page":
          await page.goto(String(args.url), { waitUntil: "domcontentloaded" });
          try {
            await page
              .getByRole("textbox", { disabled: true })
              .first()
              .waitFor({ state: "hidden", timeout: 15_000 });
          } catch {
            /* A legitimately disabled field must remain visible in the snapshot. */
          }
          return {
            url: page.url(),
            title: await page.title(),
            snapshot: await this.snapshot(page),
          };
        case "page_snapshot":
          if (args.wait_for_text) {
            try {
              await page
                .getByText(String(args.wait_for_text), { exact: false })
                .first()
                .waitFor({
                  state: "visible",
                  timeout: Number(args.timeout_ms ?? 15000),
                });
            } catch (error) {
              if (error instanceof Error && error.name === "TimeoutError")
                throw new AppError("verification_timeout", 408);
              throw error;
            }
          }
          return this.snapshot(page);
        case "current_page":
          return { url: page.url(), title: await page.title() };
        case "click":
          await page
            .getByRole(args.role as Parameters<Page["getByRole"]>[0], {
              name: String(args.name),
              exact: true,
            })
            .first()
            .click({ timeout: 5000 });
          await page.waitForLoadState("domcontentloaded");
          return this.snapshot(page);
        case "fill": {
          const label = String(args.label);
          await page
            .getByLabel(label, { exact: true })
            .or(page.getByRole("textbox", { name: label, exact: true }))
            .or(page.getByPlaceholder(label, { exact: true }))
            .first()
            .fill(String(args.value));
          this.assertPage(page);
          return `Filled '${label}'.`;
        }
        case "press_key":
          await page.keyboard.press(String(args.key));
          return this.snapshot(page);
        case "screenshot": {
          const bytes = await page.screenshot({
            type: "jpeg",
            quality: 60,
            fullPage: args.full_page === true,
          });
          if (bytes.length > LIMITS.screenshotBytes)
            throw new AppError("screenshot_too_large", 413);
          return {
            data: Buffer.from(bytes).toString("base64"),
            mimeType: "image/jpeg",
          };
        }
      }
    });
  }
  capture(id: string): Promise<BrowserEvidence> {
    return this.exclusive(async () => {
      const lease = await this.lease(id);
      if (!lease.started) throw new AppError("browser_not_open", 409);
      const page = await this.getPage(lease);
      this.assertPage(page);
      const raw = await page.locator("body").ariaSnapshot();
      const evidence: BrowserEvidence = {
        url: page.url(),
        title: await page.title(),
        snapshot: boundedText(raw),
        truncated: raw.length > LIMITS.snapshotChars,
        captured_at: new Date().toISOString(),
        // Fixed read-only oracle for the first acceptance site, not model-supplied JavaScript.
        todos: await page.locator(".todo-list li").evaluateAll((items) =>
          items.slice(0, 100).map((item) => ({
            text: (
              item.querySelector("label")?.textContent?.trim() ?? ""
            ).slice(0, 500),
            completed: item.classList.contains("completed"),
          })),
        ),
      };
      try {
        const bytes = await page.screenshot({ type: "jpeg", quality: 60 });
        if (bytes.length <= LIMITS.screenshotBytes)
          evidence.screenshot = {
            data: Buffer.from(bytes).toString("base64"),
            mimeType: "image/jpeg",
          };
        else evidence.screenshot_error = "screenshot_too_large";
      } catch {
        evidence.screenshot_error = "screenshot_failed";
      }
      return evidence;
    });
  }
  release(id: string): Promise<void> {
    return this.exclusive(() => this.releaseUnlocked(id));
  }
  private async releaseUnlocked(id: string): Promise<void> {
    const lease = await this.ctx.storage.get<Lease>("lease");
    if (!lease) {
      if ((await this.ctx.storage.get("lastClosed")) === id) return;
      throw new AppError("invalid_session", 403);
    }
    if (lease.id !== id) throw new AppError("invalid_session", 403);
    if (
      lease.started &&
      !lease.cloudId &&
      Date.now() < lease.expires + LIMITS.idleMs
    )
      throw new AppError("cleanup_unconfirmed", 503);
    if (!this.browser?.isConnected() && lease.cloudId) {
      try {
        this.browser = await connect(this.env.BROWSER, lease.cloudId);
      } catch {
        // Reconnect failure is not proof that the remote browser stopped.
        if (Date.now() < lease.expires + LIMITS.idleMs)
          throw new AppError("cleanup_unconfirmed", 503);
      }
    }
    if (this.browser?.isConnected()) await this.browser.close();
    this.browser = undefined;
    this.page = undefined;
    await this.ctx.storage.delete("lease");
    await this.ctx.storage.put("lastClosed", id);
    await this.ctx.storage.deleteAlarm();
  }
  async alarm(): Promise<void> {
    await this.exclusive(async () => {
      const lease = await this.ctx.storage.get<Lease>("lease");
      if (!lease) return;
      try {
        await this.releaseUnlocked(lease.id);
      } catch {
        await this.ctx.storage.setAlarm(Date.now() + LIMITS.idleMs);
      }
    });
  }
}
