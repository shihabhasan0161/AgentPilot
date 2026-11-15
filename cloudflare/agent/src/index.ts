import { authorize, errorResponse, json } from "../../shared/contracts";
import { RunCoordinator, type AgentEnv } from "./run-coordinator";
export { RunCoordinator };
export default {
  async fetch(request: Request, env: AgentEnv): Promise<Response> {
    try {
      if (
        new URL(request.url).pathname === "/health" &&
        request.method === "GET"
      )
        return json({ status: "ok", revision: env.VERSION?.id ?? "local" });
      await authorize(request, env.AGENT_API_TOKEN);
      return await env.RUN_COORDINATOR.getByName("personal").fetch(request);
    } catch (e) {
      return errorResponse(e);
    }
  },
} satisfies ExportedHandler<AgentEnv>;
