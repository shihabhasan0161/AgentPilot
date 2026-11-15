import { describe, expect, it, vi } from "vitest";
import { runTask, type RunnerOptions } from "../src/runner";

function setup(outputs: unknown[]) {
  const create = vi
    .fn()
    .mockImplementation(async () => ({
      usage: { total_tokens: 20 },
      status: "completed",
      ...outputs.shift()!,
    }));
  const callTool = vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "- task Test" }] });
  const onProgress = vi.fn();
  const options = {
    instruction: "test",
    model: "gpt-4.1-mini",
    signal: new AbortController().signal,
    onProgress,
    openai: { responses: { create } },
    client: {
      listTools: async () => ({
        tools: ["page_snapshot", "fill", "click"].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      }),
      callTool,
    },
  } as unknown as RunnerOptions;
  return { options, create, callTool, onProgress };
}
const call = (name: string) => ({
  output: [{ type: "function_call", name, call_id: "id", arguments: "{}" }],
});
const finish = {
  output: [],
  output_text: JSON.stringify({
    status: "completed",
    summary: "Done",
    evidence: ["Test present"],
  }),
};
describe("agent execution", () => {
  it("executes real MCP calls sequentially and returns structured output", async () => {
    const s = setup([call("page_snapshot"), finish]);
    expect((await runTask(s.options)).status).toBe("completed");
    expect(s.callTool).toHaveBeenCalledOnce();
    expect(s.create.mock.calls[0][0]).toMatchObject({
      parallel_tool_calls: false,
      store: false,
    });
    expect(s.onProgress).toHaveBeenCalled();
  });
  it("rejects claimed success without any browser action", async () => {
    await expect(runTask(setup([finish]).options)).rejects.toThrow(
      "verification_missing",
    );
  });
  it("captures omitted final verification and reassesses without replaying actions", async () => {
    const s = setup([call("fill"), call("click"), finish, finish]);
    s.callTool
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Filled" }] })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Clicked Submit" }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Your response has been recorded." }],
      });
    expect((await runTask(s.options)).status).toBe("completed");
    expect(s.callTool.mock.calls.map((c) => c[0].name)).toEqual([
      "fill",
      "click",
      "page_snapshot",
    ]);
    expect(s.create.mock.calls.at(-1)![0].tool_choice).toBe("none");
    expect(JSON.stringify(s.create.mock.calls.at(-1)![0].input)).toContain(
      "Your response has been recorded.",
    );
  });
  it("allows verification to report an unconfirmed outcome without retrying actions", async () => {
    const s = setup([
      call("fill"),
      finish,
      {
        output: [],
        output_text: JSON.stringify({
          status: "failed",
          summary: "Submission not confirmed",
          evidence: [],
        }),
      },
    ]);
    expect((await runTask(s.options)).status).toBe("failed");
    expect(s.callTool.mock.calls.map((c) => c[0].name)).toEqual([
      "fill",
      "page_snapshot",
    ]);
  });
  it("rejects success after a failed verification and never loops or replays actions", async () => {
    const s = setup([call("fill"), finish, finish]);
    s.callTool
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Filled" }] })
      .mockResolvedValueOnce({
        isError: true,
        content: [{ type: "text", text: "Snapshot unavailable" }],
      });
    await expect(runTask(s.options)).rejects.toThrow("verification_missing");
    expect(s.callTool).toHaveBeenCalledTimes(2);
    const replay = setup([call("fill"), finish, call("fill")]);
    await expect(runTask(replay.options)).rejects.toThrow(
      "verification_missing",
    );
    expect(replay.callTool.mock.calls.map((c) => c[0].name)).toEqual([
      "fill",
      "page_snapshot",
    ]);
  });
  it("does not retry MCP actions on transport failure", async () => {
    const s = setup([call("fill")]);
    s.callTool.mockRejectedValue(new Error("network"));
    await expect(runTask(s.options)).rejects.toThrow("network");
    expect(s.callTool).toHaveBeenCalledOnce();
  });
  it("enforces token budget, cancellation, and tool names", async () => {
    const s = setup([
      { ...call("page_snapshot"), usage: { total_tokens: 60000 } },
    ]);
    await expect(runTask(s.options)).rejects.toThrow("token_limit");
    await expect(runTask(setup([call("unknown")]).options)).rejects.toThrow(
      "unknown_model_tool",
    );
    const cancelled = setup([]);
    cancelled.options.signal = AbortSignal.abort();
    await expect(runTask(cancelled.options)).rejects.toThrow();
    expect(cancelled.create).not.toHaveBeenCalled();
  });
  it("stops at the turn limit and propagates MCP tool errors to the model", async () => {
    const limited = setup(Array.from({ length: 20 }, () => call("fill")));
    await expect(runTask(limited.options)).rejects.toThrow("turn_limit");
    expect(limited.callTool).toHaveBeenCalledTimes(20);
    const failed = setup([
      call("fill"),
      {
        output: [],
        output_text: JSON.stringify({
          status: "blocked",
          summary: "Field missing",
          evidence: [],
        }),
      },
    ]);
    failed.callTool.mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "destination_not_allowed" }],
    });
    expect((await runTask(failed.options)).status).toBe("blocked");
    expect(failed.create.mock.calls.at(-1)![0].input.at(-1).output).toContain(
      '"isError":true',
    );
    expect(failed.onProgress.mock.calls.at(-1)![0].tools[0].error_code).toBe(
      "destination_not_allowed",
    );
  });
});
