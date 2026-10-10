/**
 * Shared implementation for providers that speak the OpenAI Chat Completions
 * wire format (OpenRouter and Mistral both do). Gemini has its own adapter.
 */

import {
  AIProvider,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ModelInfo,
  ProviderCapabilities,
  ProviderId,
  StreamEvent,
  ToolCall,
  ToolDefinition,
  TokenUsage,
} from "./types";
import {
  ProviderError,
  codeForStatus,
  looksLikeToolUnsupported,
} from "./errors";
import {
  extractErrorMessage,
  parseSSE,
  safeJsonParse,
  safeText,
} from "./http";

// ---- OpenAI wire-format helpers -------------------------------------------------

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChoiceMessage {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAIChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: OpenAIChoiceMessage & { tool_calls?: OpenAIToolCallDelta[] };
    message?: OpenAIChoiceMessage;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: number | string; type?: string };
}

export function toOpenAIMessages(messages: ChatMessage[]) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool" as const,
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    }
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: "assistant" as const,
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.name,
            arguments: call.argumentsRaw || JSON.stringify(call.arguments ?? {}),
          },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

export function toOpenAITools(tools?: ToolDefinition[]) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function normaliseUsage(usage: OpenAIChunk["usage"]): TokenUsage {
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage?.total_tokens ?? input + output,
  };
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  const parsed = safeJsonParse<Record<string, unknown>>(raw);
  if (parsed && typeof parsed === "object") return parsed;
  return {};
}

// ---- Base provider --------------------------------------------------------------

export interface OpenAICompatibleOptions {
  id: ProviderId;
  label: string;
  defaultModel: string;
  /** e.g. https://openrouter.ai/api/v1 */
  defaultBaseUrl: string;
  apiKey?: string;
  models: ModelInfo[];
  /** Whether to send `stream_options: { include_usage: true }`. */
  sendStreamOptions?: boolean;
  /** Extra headers merged into every request (attribution, etc). */
  defaultHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Resolve a capability when the model is not in the catalogue. */
  defaultToolCalling?: boolean | "unknown";
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly defaultModel: string;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly models: ModelInfo[];
  private readonly sendStreamOptions: boolean;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultToolCalling: boolean | "unknown";

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.label = options.label;
    this.defaultModel = options.defaultModel;
    this.baseUrl = (options.defaultBaseUrl || "").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.models = options.models;
    this.sendStreamOptions = options.sendStreamOptions ?? false;
    this.headers = options.defaultHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.defaultToolCalling = options.defaultToolCalling ?? "unknown";
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  listModels(): ModelInfo[] {
    return this.models;
  }

  getCapabilities(model: string): ProviderCapabilities {
    const known = this.models.find((m) => m.id === model);
    return {
      toolCalling: known ? known.toolCalling : this.defaultToolCalling,
      streaming: true,
    };
  }

  private ensureConfigured() {
    if (!this.apiKey) {
      throw new ProviderError({
        code: "missing_api_key",
        provider: this.id,
        message: `Missing API key for ${this.label}. Configure it server-side via environment variables.`,
      });
    }
  }

  private buildBody(request: ChatRequest, stream: boolean) {
    const body: Record<string, unknown> = {
      model: request.model || this.defaultModel,
      messages: toOpenAIMessages(request.messages),
      stream,
    };
    const tools = toOpenAITools(request.tools);
    if (tools) {
      body.tools = tools;
      body.tool_choice = request.toolChoice ?? "auto";
    }
    if (typeof request.temperature === "number") body.temperature = request.temperature;
    if (typeof request.maxTokens === "number") body.max_tokens = request.maxTokens;
    if (stream && this.sendStreamOptions) body.stream_options = { include_usage: true };
    return body;
  }

  private async request(request: ChatRequest, stream: boolean, signal?: AbortSignal): Promise<Response> {
    this.ensureConfigured();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...this.headers,
        },
        body: JSON.stringify(this.buildBody(request, stream)),
        signal,
      });
    } catch (error: any) {
      if (error?.name === "AbortError") {
        throw new ProviderError({ code: "aborted", provider: this.id, message: "Request aborted" });
      }
      throw new ProviderError({
        code: "network",
        provider: this.id,
        message: `Network error contacting ${this.label}: ${error?.message ?? "unknown"}`,
      });
    }

    if (!response.ok) {
      const text = await safeText(response);
      const message = extractErrorMessage(text) || `${this.label} error ${response.status}`;
      throw new ProviderError({
        code: looksLikeToolUnsupported(message) ? "tool_calling_unsupported" : codeForStatus(response.status),
        provider: this.id,
        status: response.status,
        message,
        details: text.slice(0, 500),
      });
    }
    return response;
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const response = await this.request(request, false, signal);
    const text = await safeText(response);
    const parsed = safeJsonParse<OpenAIChunk>(text);
    if (!parsed) {
      throw new ProviderError({
        code: "provider_error",
        provider: this.id,
        message: `Invalid JSON response from ${this.label}`,
        details: text.slice(0, 500),
      });
    }
    if (parsed.error) {
      throw new ProviderError({
        code: "provider_error",
        provider: this.id,
        message: parsed.error.message ?? "Provider error",
      });
    }
    const choice = parsed.choices?.[0];
    const message = choice?.message;
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((call, index) => ({
      id: call.id || `call_${index}`,
      name: call.function?.name || "",
      arguments: parseArguments(call.function?.arguments),
      argumentsRaw: call.function?.arguments || "{}",
    }));
    return {
      text: message?.content ?? "",
      toolCalls,
      usage: normaliseUsage(parsed.usage),
      finishReason: choice?.finish_reason ?? "stop",
      model: parsed.model || request.model || this.defaultModel,
      provider: this.id,
    };
  }

  async stream(
    request: ChatRequest,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<ChatResult> {
    const response = await this.request(request, true, signal);

    let text = "";
    let finishReason = "stop";
    let resolvedModel = request.model || this.defaultModel;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    // Assemble streamed tool calls keyed by OpenAI `index`.
    const toolAccumulator = new Map<number, { id: string; name: string; args: string }>();
    const emitted = new Set<number>();

    for await (const data of parseSSE(response)) {
      const chunk = safeJsonParse<OpenAIChunk>(data);
      if (!chunk) continue;
      if (chunk.error) {
        throw new ProviderError({
          code: "provider_error",
          provider: this.id,
          message: chunk.error.message ?? "Provider stream error",
        });
      }
      if (chunk.model) resolvedModel = chunk.model;
      if (chunk.usage) usage = normaliseUsage(chunk.usage);

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const contentDelta = choice.delta?.content;
      if (typeof contentDelta === "string" && contentDelta.length > 0) {
        text += contentDelta;
        onEvent({ type: "text-delta", delta: contentDelta });
      }

      const toolDeltas = choice.delta?.tool_calls;
      if (toolDeltas) {
        for (const delta of toolDeltas) {
          const index = delta.index ?? 0;
          const current = toolAccumulator.get(index) ?? { id: "", name: "", args: "" };
          if (delta.id) current.id = delta.id;
          if (delta.function?.name) current.name = delta.function.name;
          if (delta.function?.arguments) current.args += delta.function.arguments;
          toolAccumulator.set(index, current);
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const toolCalls: ToolCall[] = [];
    for (const [index, value] of [...toolAccumulator.entries()].sort((a, b) => a[0] - b[0])) {
      const call: ToolCall = {
        id: value.id || `call_${index}`,
        name: value.name || "",
        arguments: parseArguments(value.args),
        argumentsRaw: value.args || "{}",
      };
      toolCalls.push(call);
      if (!emitted.has(index)) {
        emitted.add(index);
        onEvent({ type: "tool-call", toolCall: call });
      }
    }

    onEvent({ type: "usage", usage });
    onEvent({ type: "done", finishReason, text, toolCalls, model: resolvedModel });

    return {
      text,
      toolCalls,
      usage,
      finishReason,
      model: resolvedModel,
      provider: this.id,
    };
  }
}
