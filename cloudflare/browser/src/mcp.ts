import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { AppError, errorResponse } from "../../shared/contracts";
import type { BrowserEnv, BrowserAction } from "./browser-session";

const roles = z.enum([
  "button",
  "link",
  "textbox",
  "checkbox",
  "combobox",
  "tab",
  "menuitem",
  "form",
]);
export const tools = {
  open_page: {
    description:
      "Open an allowed URL; wait for initially disabled textboxes; return accessibility snapshot.",
    schema: z.object({ url: z.string().max(2048) }),
  },
  page_snapshot: {
    description:
      "Inspect current accessibility tree. Optionally wait for confirmation text to become visible before capturing it; never repeats actions.",
    schema: z.object({
      wait_for_text: z.string().trim().min(1).max(1000).optional(),
      timeout_ms: z.number().int().min(100).max(30000).optional(),
    }),
  },
  click: {
    description:
      "Click by exact accessible role and name, then return snapshot.",
    schema: z.object({ role: roles, name: z.string().max(1000) }),
  },
  fill: {
    description:
      "Fill by label, textbox name, or placeholder; waits up to 15 seconds.",
    schema: z.object({
      label: z.string().max(1000),
      value: z.string().max(4000),
    }),
  },
  press_key: {
    description: "Press a keyboard key and return current snapshot.",
    schema: z.object({
      key: z.enum(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"]),
    }),
  },
  screenshot: {
    description: "Capture a bounded JPEG; use when visual layout matters.",
    schema: z.object({ full_page: z.boolean().default(false) }),
  },
  close_browser: {
    description:
      "Close this leased browser and release ownership. Safe to repeat.",
    schema: z.object({}),
  },
} as const;

export function mcpHandler(env: BrowserEnv, session: string) {
  const browser = env.BROWSER_SESSION.getByName("personal");
  const text = (value: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  });
  return createMcpHandler(
    () => {
      const server = new McpServer({
        name: "AgentPilot Browser",
        version: "1.0.0",
      });
      for (const [name, definition] of Object.entries(tools)) {
        server.registerTool(
          name,
          {
            description: definition.description,
            inputSchema: definition.schema,
            annotations: {
              readOnlyHint: ["page_snapshot", "screenshot"].includes(name),
            },
          },
          async (args: Record<string, unknown>) => {
            try {
              if (!session) throw new AppError("session_required", 403);
              if (name === "close_browser") {
                await browser.release(session);
                return text("Browser closed.");
              }
              const result = await browser.execute(
                session,
                name as BrowserAction,
                args as Record<string, unknown>,
              );
              if (name === "screenshot")
                return {
                  content: [
                    {
                      type: "image" as const,
                      ...(result as { data: string; mimeType: string }),
                    },
                  ],
                };
              return text(result);
            } catch (e) {
              // DO RPC preserves Error.message, but strips the AppError class/fields.
              // Return only recognized codes, never raw exceptions or page data.
              const { error } = (await errorResponse(e).json()) as {
                error: string;
              };
              return {
                ...text(
                  error === "internal_error" ? "browser_action_failed" : error,
                ),
                isError: true,
              };
            }
          },
        );
      }
      server.registerResource(
        "current_page",
        "browser://current-page",
        { mimeType: "application/json" },
        async (uri) => ({
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                await browser.execute(session, "current_page"),
              ),
            },
          ],
        }),
      );
      server.registerPrompt(
        "test_user_flow",
        {
          description: "Explore an allowed demo flow.",
          argsSchema: z.object({ url: z.string(), goal: z.string() }),
        },
        ({ url, goal }) => ({
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Open ${url} and try to: ${goal}. Inspect snapshots, verify the final state, and report observations.`,
              },
            },
          ],
        }),
      );
      return server;
    },
    { route: "/mcp", corsOptions: false },
  );
}
