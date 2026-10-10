/**
 * Provider-agnostic agent loop.
 *
 * Drives any AIProvider through multiple tool-calling cycles until the task is
 * finished, the model stops requesting tools, the iteration budget is reached,
 * or an error occurs. All events are surfaced through a single `onEvent`
 * callback so the caller can keep the existing chat UI updated.
 */

import {
  AIProvider,
  ChatMessage,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from "./types";
import { ProviderError, isProviderError } from "./errors";
import { ExecutedToolResult, ToolExecutor } from "./tool-executor";

export type AgentEvent =
  | { type: "iteration-start"; iteration: number }
  | { type: "text-delta"; delta: string }
  | { type: "text"; text: string }
  | { type: "tool-start"; toolCall: ToolCall }
  | { type: "tool-result"; result: ExecutedToolResult }
  | { type: "usage"; usage: TokenUsage }
  | { type: "model"; model: string }
  | { type: "error"; error: ProviderError | Error; fatal: boolean }
  | { type: "done"; finishReason: string; iterations: number; text: string };

export interface AgentLoopLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface AgentLoopOptions {
  provider: AIProvider;
  model: string;
  systemPrompt: string;
  userMessage: string;
  /** Prior turns (user/assistant) to provide context. */
  history?: ChatMessage[];
  tools?: ToolDefinition[];
  executor: ToolExecutor;
  maxIterations?: number;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  signal?: AbortSignal;
  logger?: AgentLoopLogger;
  temperature?: number;
  maxTokens?: number;
}

export interface AgentLoopResult {
  text: string;
  toolCallCount: number;
  iterations: number;
  usage: TokenUsage;
  finishReason: string;
  model: string;
  provider: string;
  errors: string[];
}

const DEFAULT_MAX_ITERATIONS = 40;

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

const NOOP_LOGGER: AgentLoopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    provider,
    executor,
    signal,
    logger = NOOP_LOGGER,
  } = options;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tools = options.tools ?? executor.listTools();

  const emit = async (event: AgentEvent) => {
    if (options.onEvent) await options.onEvent(event);
  };

  const capabilities = provider.getCapabilities(options.model);
  if (capabilities.toolCalling === false) {
    const error = new ProviderError({
      code: "tool_calling_unsupported",
      provider: provider.id,
      message: `The model "${options.model}" does not support tool calling, which the agent requires. Pick a different model.`,
    });
    await emit({ type: "error", error, fatal: true });
    return {
      text: "",
      toolCallCount: 0,
      iterations: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: "error",
      model: options.model,
      provider: provider.id,
      errors: [error.message],
    };
  }

  const messages: ChatMessage[] = [];
  if (options.systemPrompt.trim()) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  if (options.history && options.history.length > 0) {
    messages.push(...options.history);
  }
  messages.push({ role: "user", content: options.userMessage });

  let aggregatedText = "";
  let toolCallCount = 0;
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let finishReason = "stop";
  let resolvedModel = options.model;
  const errors: string[] = [];
  let iterations = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    iterations = iteration;
    if (signal?.aborted) {
      const error = new ProviderError({ code: "aborted", provider: provider.id, message: "Agent loop aborted" });
      await emit({ type: "error", error, fatal: true });
      errors.push(error.message);
      finishReason = "aborted";
      break;
    }

    await emit({ type: "iteration-start", iteration });
    logger.info(`[agent-loop] iteration ${iteration}/${maxIterations} using ${provider.id}:${resolvedModel}`);

    let assistantText = "";
    let toolCalls: ToolCall[] = [];

    try {
      const result = await provider.stream(
        {
          model: resolvedModel,
          messages,
          tools,
          temperature: options.temperature,
          maxTokens: options.maxTokens,
        },
        (event) => {
          if (event.type === "text-delta") {
            assistantText += event.delta;
            void emit({ type: "text-delta", delta: event.delta });
          }
          // usage + tool-call events are finalised below from the result
        },
        signal
      );

      // Prefer the provider's authoritative final text/calls over local counters.
      assistantText = result.text || assistantText;
      toolCalls = result.toolCalls;
      if (result.model) resolvedModel = result.model;
      if (result.finishReason) finishReason = result.finishReason;
      if (result.usage.totalTokens > 0 || result.usage.inputTokens > 0) {
        usage = addUsage(usage, result.usage);
        await emit({ type: "usage", usage: result.usage });
      }
      if (result.model) await emit({ type: "model", model: result.model });
    } catch (error) {
      const providerError = isProviderError(error)
        ? error
        : new ProviderError({
            code: "provider_error",
            provider: provider.id,
            message: error instanceof Error ? error.message : String(error),
          });
      logger.error(`[agent-loop] provider error`, providerError.toJSON());
      await emit({ type: "error", error: providerError, fatal: true });
      errors.push(providerError.message);
      finishReason = "error";
      break;
    }

    if (assistantText.trim()) {
      aggregatedText += (aggregatedText ? "\n\n" : "") + assistantText;
      await emit({ type: "text", text: assistantText });
    }

    messages.push({ role: "assistant", content: assistantText, toolCalls });

    if (toolCalls.length === 0) {
      await emit({ type: "done", finishReason, iterations, text: aggregatedText });
      break;
    }

    // Surface tool-start events and execute each call in order.
    for (const call of toolCalls) {
      toolCallCount += 1;
      await emit({ type: "tool-start", toolCall: call });
      const result = await executor.execute(call, signal);
      await emit({ type: "tool-result", result });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.content,
      });
    }

    if (iteration === maxIterations) {
      const error = new ProviderError({
        code: "provider_error",
        provider: provider.id,
        message: `Agent reached the maximum of ${maxIterations} tool iterations without finishing.`,
      });
      errors.push(error.message);
      await emit({ type: "error", error, fatal: false });
    }
  }

  return {
    text: aggregatedText,
    toolCallCount,
    iterations,
    usage,
    finishReason,
    model: resolvedModel,
    provider: provider.id,
    errors,
  };
}
