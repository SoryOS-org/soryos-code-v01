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
 * special `openrouter/free` router (queried live 2026-10-10). `toolCalling`
 * reflects the documented capability; `"unknown"` means we verify at call time.
 * Keep in sync with `OPENROUTER_FREE_MODELS` in `lib/models.ts`.
 */
export const OPENROUTER_MODELS: ModelInfo[] = [
  {
    id: "openrouter/free",
    name: "OpenRouter Free (auto)",
    description: "Routes to OpenRouter's free model pool. Tool support verified at runtime.",
    toolCalling: "unknown",
  },
  { id: "cohere/north-mini-code:free", name: "North Mini Code", description: "Coding model, 256k context", toolCalling: true },
  { id: "thinkingmachines/inkling:free", name: "Inkling", description: "Frontier model, 1M context", toolCalling: true },
  { id: "thinkingmachines/inkling-small:free", name: "Inkling Small", description: "Fast, 1M context", toolCalling: true },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super", description: "120B, strong reasoning", toolCalling: true },
  { id: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5 Lightning", description: "Fast and lightweight", toolCalling: true },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "Nemotron 3 Nano Omni", description: "30B reasoning, multimodal", toolCalling: true },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra", description: "550B MoE, 1M context", toolCalling: true },
  { id: "poolside/laguna-s-2.1:free", name: "Laguna S 2.1", description: "Software engineering model", toolCalling: true },
  { id: "poolside/laguna-xs-2.1:free", name: "Laguna XS 2.1", description: "Small software engineering model", toolCalling: true },
  { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B", description: "Google open model, 262k context", toolCalling: true },
  { id: "google/gemma-4-26b-a4b-it:free", name: "Gemma 4 26B", description: "Google open model, efficient MoE", toolCalling: true },
  { id: "apodex/apodex-1.1-mini:free", name: "Apodex 1.1 Mini", description: "Compact general model", toolCalling: true },
  { id: "dots-studio/dots-3-note-preview:free", name: "Dots 3 Note", description: "Multimodal preview model", toolCalling: true },
  { id: "liquid/lfm-2.5-2.6b:free", name: "LFM 2.5 2.6B", description: "Ultra-small on-device model", toolCalling: true },
];

/**
 * Free models that do not support tool calling. Kept explicit so we can refuse
 * early instead of emitting a broken agent loop.
 */
const NON_TOOL_MODELS = new Set<string>(["nvidia/nemotron-3.5-content-safety:free"]);

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig = {}) {
    super({
      id: "openrouter",
      label: "OpenRouter",
      defaultModel: getEnv("OPENROUTER_DEFAULT_MODEL") || "cohere/north-mini-code:free",
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
