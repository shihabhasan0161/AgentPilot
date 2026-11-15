import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { AppError, type BrowserEvidence } from "../../shared/contracts";

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
export function browserEndpoint(baseUrl: string, path: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AppError("browser_url_not_configured", 503);
  }
  const localHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new AppError("invalid_browser_url", 503);
  return new URL(path, url.origin).href;
}
export function browserApi(fetcher: FetchLike, token: string, baseUrl: string) {
  return async (
    path: string,
    method = "GET",
    session?: string,
  ): Promise<Response> => {
    const response = await fetcher(
      browserEndpoint(baseUrl, path),
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(session ? { "X-AgentPilot-Session": session } : {}),
        },
      },
    );
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      throw new AppError(
        body.error ?? "browser_request_failed",
        response.status,
      );
    }
    return response;
  };
}
export async function connectMcp(
  url: string,
  token: string,
  session?: string,
  fetcher?: FetchLike,
): Promise<Client> {
  // The CF validator avoids Ajv's runtime code generation, which Workers forbids.
  const client = new Client(
    { name: "AgentPilot Runner", version: "1.0.0" },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(session ? { "X-AgentPilot-Session": session } : {}),
      },
    },
    ...(fetcher ? { fetch: fetcher as typeof fetch } : {}),
  });
  try {
    await client.connect(transport, { timeout: 15_000 });
    return client;
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
}
export async function captureEvidence(
  fetcher: FetchLike,
  token: string,
  session: string,
  baseUrl: string,
): Promise<BrowserEvidence> {
  return (
    await browserApi(fetcher, token, baseUrl)("/sessions/evidence", "GET", session)
  ).json() as Promise<BrowserEvidence>;
}
