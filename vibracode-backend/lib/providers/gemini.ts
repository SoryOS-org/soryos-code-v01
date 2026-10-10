/**
 * Google Gemini provider — official Generative Language API.
 *
 * Gemini's wire format differs from OpenAI: system prompts live in
 * `systemInstruction`, roles are `user`/`model`, tool calls are `functionCall`
 * parts and tool results are `functionResponse` parts (matched by *name*, not by
 * id). This adapter converts both directions to/from the internal format.
 */

import {
  AIProvider,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ModelInfo,
  ProviderCapabilities,
  ProviderConfig,
  StreamEvent,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from "./types";
import { ProviderError, codeForStatus, looksLikeToolUnsupported } from "./errors";
import { extractErrorMessage, parseSSE, safeJsonParse, safeText } from "./http";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export const GEMINI_MODELS: ModelInfo[] = [
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "Best price/performance for agents", toolCalling: true, contextLength: 1048576 },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Most capable reasoning", toolCalling: true, contextLength: 1048576 },
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite", description: "Lowest latency and cost", toolCalling: true, contextLength: 1048576 },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", description: "Fast, widely available", toolCalling: true, contextLength: 1048576 },
  { id: "gemini-2.0-flash-lite", name: "Gemini 2.0 Flash-Lite", description: "Compact and fast", toolCalling: true, contextLength: 1048576 },
  { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", description: "Stable older model", toolCalling: true, contextLength: 1048576 },
  { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", description: "Stable older pro model", toolCalling: true, contextLength: 2097152 },
];

// ---- Wire-format types ----------------------------------------------------------

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string; response?: Record<string, unknown> };
}

interface GeminiContent {
  role?: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string };
}

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

/** Uppercase schema `type` values and drop keys Gemini rejects. */
export function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const input = schema as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "additionalProperties" || key === "$schema" || key === "title") continue;
    if (key === "type" && typeof value === "string") {
      output.type = value.toUpperCase();
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [propKey, propValue] of Object.entries(value as Record<string, unknown>)) {
        props[propKey] = sanitizeGeminiSchema(propValue);
      }
      output.properties = props;
      continue;
    }
    if (key === "items") {
      output.items = sanitizeGeminiSchema(value);
      continue;
    }
    output[key] = value;
  }
  return output;
}

function buildContents(messages: ChatMessage[]): {
  systemInstruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
} {
  const systemParts: GeminiPart[] = [];
  const contents: GeminiContent[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content.trim()) systemParts.push({ text: message.content });
      continue;
    }

    if (message.role === "tool") {
      const part: GeminiPart = {
        functionResponse: {
          name: message.name || "tool",
          response: { result: message.content },
        },
      };
      // Group consecutive tool responses into a single user turn.
      const last = contents[contents.length - 1];
      if (last && last.role === "user" && last.parts.every((p) => p.functionResponse)) {
        last.parts.push(part);
      } else {
        contents.push({ role: "user", parts: [part] });
      }
      continue;
    }

    if (message.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (message.content.trim()) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.arguments } });
      }
      if (parts.length === 0) parts.push({ text: "" });
      contents.push({ role: "model", parts });
      continue;
    }

    // user
    contents.push({ role: "user", parts: [{ text: message.content }] });
  }

  return {
    systemInstruction: systemParts.length ? { parts: systemParts } : undefined,
    contents,
  };
}

function buildTools(tools?: ToolDefinition[]) {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: sanitizeGeminiSchema(tool.parameters),
      })),
    },
  ];
}

function normaliseUsage(usage: GeminiResponse["usageMetadata"]): TokenUsage {
  const input = usage?.promptTokenCount ?? 0;
  const output = usage?.candidatesTokenCount ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage?.totalTokenCount ?? input + output,
  };
}

const FINISH_REASON_MAP: Record<string, string> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  OTHER: "stop",
};

function parseResult(parsed: GeminiResponse, fallbackModel: string): ChatResult {
  const candidate = parsed.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  let text = "";
  const toolCalls: ToolCall[] = [];
  let callIndex = 0;
  for (const part of parts) {
    if (typeof part.text === "string") text += part.text;
    if (part.functionCall?.name) {
      toolCalls.push({
        id: `gemini_call_${callIndex++}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args ?? {},
        argumentsRaw: JSON.stringify(part.functionCall.args ?? {}),
      });
    }
  }
  return {
    text,
    toolCalls,
    usage: normaliseUsage(parsed.usageMetadata),
    finishReason: FINISH_REASON_MAP[candidate?.finishReason ?? "STOP"] ?? "stop",
    model: parsed.modelVersion || fallbackModel,
    provider: "gemini",
  };
}

export class GeminiProvider implements AIProvider {
  readonly id = "gemini" as const;
  readonly label = "Google Gemini";
  readonly defaultModel: string;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly models: ModelInfo[];

  constructor(config: ProviderConfig = {}) {
    this.defaultModel = getEnv("GEMINI_DEFAULT_MODEL") || "gemini-2.5-flash";
    this.baseUrl = (config.baseUrl || getEnv("GEMINI_BASE_URL") || GEMINI_BASE_URL).replace(/\/+$/, "");
    this.apiKey = config.apiKey ?? getEnv("GEMINI_API_KEY");
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.models = GEMINI_MODELS;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  listModels(): ModelInfo[] {
    return this.models;
  }

  getCapabilities(model: string): ProviderCapabilities {
    const known = this.models.find((m) => m.id === model);
    return { toolCalling: known ? known.toolCalling : "unknown", streaming: true };
  }

  private ensureConfigured() {
    if (!this.apiKey) {
      throw new ProviderError({
        code: "missing_api_key",
        provider: "gemini",
        message: "Missing GEMINI_API_KEY. Configure it server-side.",
      });
    }
  }

  private buildBody(request: ChatRequest) {
    const { systemInstruction, contents } = buildContents(request.messages);
    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    const tools = buildTools(request.tools);
    if (tools) {
      body.tools = tools;
      body.toolConfig = { functionCallingConfig: { mode: request.toolChoice === "none" ? "NONE" : "AUTO" } };
    }
    const generationConfig: Record<string, unknown> = {};
    if (typeof request.temperature === "number") generationConfig.temperature = request.temperature;
    if (typeof request.maxTokens === "number") generationConfig.maxOutputTokens = request.maxTokens;
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    return body;
  }

  private async request(
    request: ChatRequest,
    stream: boolean,
    signal?: AbortSignal
  ): Promise<Response> {
    this.ensureConfigured();
    const model = request.model || this.defaultModel;
    const method = stream ? "streamGenerateContent" : "generateContent";
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:${method}${stream ? "?alt=sse" : ""}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey as string,
        },
        body: JSON.stringify(this.buildBody(request)),
        signal,
      });
    } catch (error: any) {
      if (error?.name === "AbortError") {
        throw new ProviderError({ code: "aborted", provider: "gemini", message: "Request aborted" });
      }
      throw new ProviderError({
        code: "network",
        provider: "gemini",
        message: `Network error contacting Gemini: ${error?.message ?? "unknown"}`,
      });
    }

    if (!response.ok) {
      const text = await safeText(response);
      const message = extractErrorMessage(text) || `Gemini error ${response.status}`;
      throw new ProviderError({
        code: looksLikeToolUnsupported(message) ? "tool_calling_unsupported" : codeForStatus(response.status),
        provider: "gemini",
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
    const parsed = safeJsonParse<GeminiResponse>(text);
    if (!parsed) {
      throw new ProviderError({
        code: "provider_error",
        provider: "gemini",
        message: "Invalid JSON response from Gemini",
        details: text.slice(0, 500),
      });
    }
    if (parsed.error) {
      throw new ProviderError({
        code: "provider_error",
        provider: "gemini",
        message: parsed.error.message ?? "Gemini error",
      });
    }
    return parseResult(parsed, request.model || this.defaultModel);
  }

  async stream(
    request: ChatRequest,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<ChatResult> {
    const response = await this.request(request, true, signal);

    let text = "";
    let resolvedModel = request.model || this.defaultModel;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let finishReason = "stop";
    const toolCalls: ToolCall[] = [];
    let callIndex = 0;

    for await (const data of parseSSE(response)) {
      const chunk = safeJsonParse<GeminiResponse>(data);
      if (!chunk) continue;
      if (chunk.error) {
        throw new ProviderError({
          code: "provider_error",
          provider: "gemini",
          message: chunk.error.message ?? "Gemini stream error",
        });
      }
      if (chunk.modelVersion) resolvedModel = chunk.modelVersion;
      if (chunk.usageMetadata) usage = normaliseUsage(chunk.usageMetadata);

      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;
      for (const part of candidate.content?.parts ?? []) {
        if (typeof part.text === "string" && part.text.length > 0) {
          text += part.text;
          onEvent({ type: "text-delta", delta: part.text });
        }
        if (part.functionCall?.name) {
          const call: ToolCall = {
            id: `gemini_call_${callIndex++}`,
            name: part.functionCall.name,
            arguments: part.functionCall.args ?? {},
            argumentsRaw: JSON.stringify(part.functionCall.args ?? {}),
          };
          toolCalls.push(call);
          onEvent({ type: "tool-call", toolCall: call });
        }
      }
      if (candidate.finishReason) {
        finishReason = FINISH_REASON_MAP[candidate.finishReason] ?? "stop";
      }
    }

    onEvent({ type: "usage", usage });
    onEvent({ type: "done", finishReason, text, toolCalls, model: resolvedModel });

    return { text, toolCalls, usage, finishReason, model: resolvedModel, provider: "gemini" };
  }
}
