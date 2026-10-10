/**
 * OpenRouter provider — uses OpenRouter's OpenAI-compatible endpoint.
 *
 * Default model id is `openrouter/free`, which routes to OpenRouter's free
 * model pool. The *actual* model that answered is read back from the API
 * response (`model` field) rather than assumed.
 *
 * Free models do NOT all support tool calling. When the selected model cannot
 * call tools, OpenRouter returns an explicit error which we surface as a
 * `tool_calling_unsupported` ProviderError instead of pretending it worked.
 */

import { ModelInfo, ProviderConfig } from "./types";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { ProviderError } from "./errors";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Curated catalogue of OpenRouter models with a working `:free` variant plus the
 * special `openrouter/free` router. `toolCalling` reflects the documented
 * capability; `"unknown"` means we verify at call time.
 */
export const OPENROUTER_MODELS: ModelInfo[] = [
  {
    id: "openrouter/free",
    name: "OpenRouter Free (auto)",
    description: "Routes to OpenRouter's free model pool. Tool support verified at runtime.",
    toolCalling: "unknown",
  },
  { id: "deepseek/deepseek-chat-v3.1:free", name: "DeepSeek V3.1", description: "Strong coding, free tier", toolCalling: true },
  { id: "qwen/qwen3-coder:free", name: "Qwen3 Coder", description: "Agentic coding model, free", toolCalling: true },
  { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B", description: "General purpose, free", toolCalling: true },
  { id: "mistralai/mistral-small-3.2-24b-instruct:free", name: "Mistral Small 3.2", description: "Fast instruction model, free", toolCalling: true },
  { id: "google/gemma-3-27b-it:free", name: "Gemma 3 27B", description: "Google open model, free", toolCalling: true },
  { id: "nvidia/nemotron-nano-9b-v2:free", name: "Nemotron Nano 9B", description: "Lightweight, free", toolCalling: true },
];

/**
 * Free models that historically do not support tool calling. Kept explicit so we
 * can refuse early instead of emitting a broken agent loop.
 */
const NON_TOOL_MODELS = new Set<string>();

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig = {}) {
    super({
      id: "openrouter",
      label: "OpenRouter",
      defaultModel: getEnv("OPENROUTER_DEFAULT_MODEL") || "openrouter/free",
      defaultBaseUrl: config.baseUrl || getEnv("OPENROUTER_BASE_URL") || OPENROUTER_BASE_URL,
      apiKey: config.apiKey ?? getEnv("OPENROUTER_API_KEY"),
      models: OPENROUTER_MODELS,
      defaultToolCalling: "unknown",
      fetchImpl: config.fetchImpl,
      // OpenRouter accepts stream_options include_usage for accurate accounting.
      sendStreamOptions: true,
      defaultHeaders: {
        ...(getEnv("OPENROUTER_SITE_URL") ? { "HTTP-Referer": getEnv("OPENROUTER_SITE_URL")! } : {}),
        ...(getEnv("OPENROUTER_APP_NAME") ? { "X-Title": getEnv("OPENROUTER_APP_NAME")! } : {}),
        ...config.headers,
      },
    });
  }

  /** Refuse known non-tool models up-front with a precise message. */
  assertToolSupport(model: string): void {
    if (NON_TOOL_MODELS.has(model)) {
      throw new ProviderError({
        code: "tool_calling_unsupported",
        provider: "openrouter",
        message: `The OpenRouter model "${model}" does not support tool calling, which the agent loop requires.`,
      });
    }
  }
}
