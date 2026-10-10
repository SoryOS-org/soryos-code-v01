import { test } from "node:test";
import assert from "node:assert/strict";

import { runAgentLoop, AgentLoopResult, AgentEvent } from "../agent-loop";
import { AIProvider, ChatRequest, ChatResult, ModelInfo, ProviderCapabilities, StreamEvent, ToolCall, TokenUsage, ToolDefinition } from "../types";
import { ToolExecutor, ExecutedToolResult } from "../tool-executor";
import { ProviderError, isProviderError } from "../errors";

/**
 * Scripted provider: returns a tool call on the first N calls, then plain text.
 */
class FakeProvider implements AIProvider {
  readonly id = "openrouter" as const;
  readonly label = "Fake";
  readonly defaultModel = "openrouter/free";
  toolCallsBeforeAnswer = 1;

  constructor(
    private readonly responses: Array<{ text: string; toolCalls: ToolCall[] }>
  ) {}

  isConfigured() {
    return true;
  }
  getCapabilities(_model: string): ProviderCapabilities {
    return { toolCalling: true, streaming: true };
  }
  listModels(): ModelInfo[] {
    return [];
  }
  async chat(request: ChatRequest, _signal?: AbortSignal): Promise<ChatResult> {
    const next = this.responses.shift() ?? { text: "", toolCalls: [] };
    const toolCalls = next.toolCalls ?? [];
    const usage: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    const text = next.text || (toolCalls.length ? "" : "final answer");
    return { text, toolCalls, usage, finishReason: toolCalls.length ? "tool_calls" : "stop", model: request.model, provider: this.id };
  }
  async stream(
    request: ChatRequest,
    onEvent: (event: StreamEvent) => void,
    _signal?: AbortSignal
  ): Promise<ChatResult> {
    const result = await this.chat(request);
    for (const delta of result.text) onEvent({ type: "text-delta", delta });
    if (result.toolCalls.length) {
      for (const call of result.toolCalls) onEvent({ type: "tool-call", toolCall: call });
    }
    onEvent({ type: "usage", usage: result.usage });
    onEvent({ type: "done", finishReason: result.finishReason, text: result.text, toolCalls: result.toolCalls, model: result.model });
    return result;
  }
}

/** Records calls without touching a sandbox. */
class RecordingExecutor implements ToolExecutor {
  readonly calls: ToolCall[] = [];
  constructor(private readonly failing = false) {}
  listTools(): ToolDefinition[] {
    return [
      { name: "read_file", description: "Read a file", parameters: { type: "object", properties: {}, required: [] } },
    ];
  }
  async execute(call: ToolCall): Promise<ExecutedToolResult> {
    this.calls.push(call);
    if (this.failing) return { id: call.id, name: call.name, content: "tool blew up", isError: true };
    return { id: call.id, name: call.name, content: "tool result ok", isError: false };
  }
}

function toolCall(name: string, args: Record<string, unknown>, id = "tc"): ToolCall {
  return { id, name, arguments: args, argumentsRaw: JSON.stringify(args) };
}

test("agent-loop: executes tool calls until the model stops requesting them", async () => {
  const provider = new FakeProvider([
    { text: "", toolCalls: [toolCall("read_file", { path: "a.ts" }), toolCall("read_file", { path: "b.ts" })] },
    { text: "done now", toolCalls: [] },
  ]);
  const executor = new RecordingExecutor();
  const events: AgentEvent[] = [];

  const result = await runAgentLoop({
    provider,
    model: "openrouter/free",
    systemPrompt: "sys",
    userMessage: "read the files",
    executor,
    onEvent: (event) => {
      events.push(event);
    },
    maxIterations: 5,
  });

  assert.equal(result.text, "done now");
  assert.equal(result.toolCallCount, 2);
  assert.equal(result.iterations, 2);
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  assert.equal(executor.calls.length, 2);
  assert.ok(events.some((e) => e.type === "tool-start"));
  assert.ok(events.some((e) => e.type === "tool-result"));
  assert.equal(events.filter((e) => e.type === "iteration-start").length, 2);
});

test("agent-loop: feeds tool results back as tool messages", async () => {
  const provider = new FakeProvider([
    { text: "", toolCalls: [toolCall("read_file", { path: "a.ts" })] },
    { text: "understood", toolCalls: [] },
  ]);
  const executor = new RecordingExecutor();

  let sawAllMessages = false;
  const originalStream = provider.stream.bind(provider);
  provider.stream = async (request, onEvent, signal) => {
    if (request.messages.some((m) => m.role === "tool" && m.content === "tool result ok")) {
      sawAllMessages = true;
    }
    return originalStream(request as ChatRequest, onEvent, signal);
  };

  await runAgentLoop({ provider, model: "openrouter/free", systemPrompt: "", userMessage: "go", executor });
  assert.equal(sawAllMessages, true);
});

test("agent-loop: refuses models without tool calling support", async () => {
  class NoToolProvider extends FakeProvider {
    getCapabilities(): ProviderCapabilities {
      return { toolCalling: false, streaming: true };
    }
  }
  const provider = new NoToolProvider([{ text: "ignored", toolCalls: [] }]);
  const executor = new RecordingExecutor();
  const events: AgentEvent[] = [];

  const result = await runAgentLoop({
    provider,
    model: "openrouter/free",
    systemPrompt: "",
    userMessage: "go",
    executor,
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.finishReason, "error");
  assert.equal(result.iterations, 0);
  assert.equal(result.toolCallCount, 0);
  assert.match(result.errors[0], /does not support tool calling/);
  const fatal = events.find((e) => e.type === "error");
  assert.ok(fatal);
  assert.equal((fatal as any).fatal, true);
});

test("agent-loop: aborts when the signal is already aborted", async () => {
  const provider = new FakeProvider([{ text: "x", toolCalls: [] }]);
  const executor = new RecordingExecutor();
  const controller = new AbortController();
  controller.abort();

  const result = await runAgentLoop({
    provider,
    model: "openrouter/free",
    systemPrompt: "",
    userMessage: "go",
    executor,
    signal: controller.signal,
  });

  assert.equal(result.finishReason, "aborted");
  assert.match(result.errors[0], /aborted/i);
});

test("agent-loop: surfaces provider fatal errors", async () => {
  class ThrowingProvider extends FakeProvider {
    async chat(): Promise<ChatResult> {
      throw new ProviderError({ code: "rate_limited", provider: "openrouter", message: "slow down", status: 429 });
    }
  }
  const provider = new ThrowingProvider([]);
  const executor = new RecordingExecutor();
  const events: AgentEvent[] = [];

  const result = await runAgentLoop({
    provider,
    model: "openrouter/free",
    systemPrompt: "",
    userMessage: "go",
    executor,
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.finishReason, "error");
  const errorEvent = events.find((e) => e.type === "error") as any;
  assert.equal(errorEvent.fatal, true);
  assert.equal(errorEvent.error.code, "rate_limited");
  assert.ok(isProviderError(errorEvent.error));
});

test("agent-loop: caps at maxIterations and reports it non-fatally", async () => {
  // Provider that ALWAYS requests tools -> loop must hit the cap.
  class InfiniteProvider extends FakeProvider {
    async chat(request: ChatRequest): Promise<ChatResult> {
      const usage: TokenUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      return {
        text: "",
        toolCalls: [toolCall("read_file", { path: "x" })],
        usage,
        finishReason: "tool_calls",
        model: request.model,
        provider: this.id,
      };
    }
  }
  const provider = new InfiniteProvider([]);
  const executor = new RecordingExecutor();
  const events: AgentEvent[] = [];

  const result = await runAgentLoop({
    provider,
    model: "openrouter/free",
    systemPrompt: "",
    userMessage: "go",
    executor,
    onEvent: (event) => {
      events.push(event);
    },
    maxIterations: 3,
  });

  assert.equal(result.iterations, 3);
  assert.equal(result.toolCallCount, 3);
  const errorEvent = events.find((e) => e.type === "error") as any;
  assert.equal(errorEvent.fatal, false);
  assert.match(result.errors[0], /maximum of 3 tool iterations/);
});