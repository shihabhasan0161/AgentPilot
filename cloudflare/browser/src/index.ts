import {
  authorize,
  AppError,
  errorResponse,
  json,
  readJson,
} from "../../shared/contracts";
import { BrowserSession, type BrowserEnv } from "./browser-session";
import { mcpHandler } from "./mcp";
import { policy } from "./policy";
export { BrowserSession };
export default {
  async fetch(
    request: Request,
    env: BrowserEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/health" && request.method === "GET")
        return json({ status: "ok", revision: env.VERSION?.id ?? "local" });
      await authorize(request, env.MCP_API_TOKEN);
      policy(env.ALLOWED_DOMAINS, env.ASSET_DOMAINS);
      const browser = env.BROWSER_SESSION.getByName("personal");
      const session = request.headers.get("X-AgentPilot-Session") ?? "";
      if (path === "/sessions" && request.method === "POST")
        return json(await browser.acquire(), 201);
      if (path === "/sessions" && request.method === "DELETE") {
        await browser.release(session);
        return json({ status: "closed" });
      }
      if (path === "/sessions/evidence" && request.method === "GET")
        return json(await browser.capture(session));
      if (path === "/mcp") {
        if (request.method === "POST") {
          const body = JSON.stringify(await readJson(request));
          const headers = new Headers(request.headers);
          headers.delete("Content-Length");
          request = new Request(request.url, { method: "POST", headers, body });
        }
        return await mcpHandler(env, session)(request, env, ctx);
      }
      throw new AppError("not_found", 404);
    } catch (e) {
      return errorResponse(e);
    }
  },
} satisfies ExportedHandler<BrowserEnv>;
