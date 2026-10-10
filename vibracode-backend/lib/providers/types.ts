/**
 * Common multi-provider AI interface.
 *
 * The engine no longer relies on the Anthropic/Claude tooling that used to run
 * inside the E2B sandbox. Instead each provider (OpenRouter, Mistral, Gemini)
 * exposes the same small surface so the shared agent loop can drive any of them.
 *
 * All shapes below are provider-agnostic. Adapters are responsible for
 * translating them to/from their native wire format.
 */

export type ProviderId = "openrouter" | "mistral" | "gemini";

/** Minimal JSON-Schema subset used to describe tool parameters. */
export interface JsonSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  /** Provider-specific id when available; generated otherwise (Gemini). */
  id: string;
  name: string;
  /** Parsed arguments (best effort). */
  arguments: Record<string, unknown>;
  /** Raw JSON string exactly as returned by the provider. */
  argumentsRaw: string;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Assistant messages may carry tool calls. */
  toolCalls?: ToolCall[];
  /** Tool result messages reference the originating call. */
  toolCallId?: string;
  /** Tool name (required by Gemini functionResponse). */
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none";
  temperature?: number;
  maxTokens?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: string;
  /** The model actually used, as reported by the provider API. */
  model: string;
  provider: ProviderId;
}

export type StreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; toolCall: ToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "error"; error: import("./errors").ProviderError }
  | {
      type: "done";
      finishReason: string;
      text: string;
      toolCalls: ToolCall[];
      model: string;
    };

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  /** `true`, `false`, or `"unknown"` when the provider cannot declare it upfront. */
  toolCalling: boolean | "unknown";
  contextLength?: number;
}

export interface ProviderCapabilities {
  toolCalling: boolean | "unknown";
  streaming: boolean;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional extra headers (e.g. OpenRouter attribution). */
  headers?: Record<string, string>;
}

/**
 * The single interface every AI provider implements.
 */
export interface AIProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly defaultModel: string;
  /** True when the required API key is present. */
  isConfigured(): boolean;
  getCapabilities(model: string): ProviderCapabilities;
  listModels(): ModelInfo[];
  /** Non-streaming completion. */
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
  /** Streaming completion; emits incremental events and returns the final result. */
  stream(
    request: ChatRequest,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<ChatResult>;
}
