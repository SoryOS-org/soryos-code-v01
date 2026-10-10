/**
 * Bridges the provider engine to Vibra's existing Convex sessions + E2B sandbox.
 *
 * Responsibilities:
 *  - connect/reconnect to the session's E2B sandbox (E2B stays provider-agnostic)
 *  - build the system prompt + conversation history exactly like the old CLI agent
 *  - run the shared agent loop while writing events into Convex messages so the
 *    existing iOS/web chat UI keeps rendering (message/edit/read/bash/todos/status)
 *  - bill usage through the existing credit system
 *  - auto-push to GitHub when the session has a repository
 */

import { Id } from "@/convex/_generated/dataModel";
import { fetchMutation, fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getSystemPrompt } from "@/lib/prompts";
import { E2BManager } from "@/lib/e2b/config";
import { Template } from "@/config";
import { AIProvider, ChatMessage, ProviderId } from "./types";
import { AgentEvent, runAgentLoop } from "./agent-loop";
import { E2BToolExecutor, SandboxLike } from "./tool-executor";
import { getProviderForModel } from "./registry";
import { ProviderError, isProviderError } from "./errors";

export interface ProviderSecrets {
  openrouter?: string;
  mistral?: string;
  gemini?: string;
}

export interface RunProviderAgentInput {
  id: Id<"sessions">;
  sandboxId: string;
  message: string;
  template?: Template;
  model?: string;
  /**
   * Optional per-user API keys read from `convex/providerSettings.ts`.
   * When a provider has no user key here, its adapter falls back to the
   * deployment env vars (OPENROUTER_API_KEY / MISTRAL_API_KEY / GEMINI_API_KEY).
   */
  secrets?: ProviderSecrets;
}

// Per-provider pricing used only to *estimate* user credit consumption.
// Roughly follows published public pricing; OpenRouter free models are $0.
const PRICING_PER_1M: Record<string, { input: number; output: number }> = {
  mistral: { input: 0.3, output: 1.0 },
  gemini: { input: 0.3, output: 2.5 },
  openrouter: { input: 0, output: 0 },
};

type SessionStatus =
  | "IN_PROGRESS"
  | "CLONING_REPO"
  | "INSTALLING_DEPENDENCIES"
  | "STARTING_DEV_SERVER"
  | "CREATING_TUNNEL"
  | "CUSTOM"
  | "RUNNING"
  | "CREATING_GITHUB_REPO"
  | "SETTING_UP_SANDBOX";

const HISTORY_LIMIT = 40;
const STREAM_FLUSH_CHARS = 140;
const STREAM_FLUSH_MS = 600;

function sanitizeErrorText(message: string): string {
  const patterns = [
    /sk-ant-[a-zA-Z0-9-]+/g,
    /sk-[a-zA-Z0-9-]{20,}/g,
    /ghp_[a-zA-Z0-9]+/g,
    /xai-[a-zA-Z0-9-]+/g,
    /Bearer\s+[a-zA-Z0-9._-]+/gi,
    /Authorization:\s*[^\s,}]+/gi,
    /api[_-]?key["\s:=]+[a-zA-Z0-9._-]+/gi,
    /token["\s:=]+[a-zA-Z0-9._-]+/gi,
    /secret["\s:=]+[a-zA-Z0-9._-]+/gi,
    /password["\s:=]+[^\s,}]+/gi,
  ];
  let result = message;
  for (const pattern of patterns) result = result.replace(pattern, "[REDACTED]");
  return result;
}

export function estimateCostUSD(providerId: string, usage: { inputTokens: number; outputTokens: number }): number {
  const pricing = PRICING_PER_1M[providerId] ?? PRICING_PER_1M.openrouter;
  if (!pricing) return 0;
  const cost =
    (usage.inputTokens / 1_000_000) * pricing.input +
    (usage.outputTokens / 1_000_000) * pricing.output;
  // A tiny floor so a real request always costs something (preserves the
  // existing "users always pay a minimum" behaviour).
  return Number((cost > 0 && cost < 0.002 ? 0.002 : cost).toFixed(6));
}

interface SessionLike {
  createdBy?: string;
  agentStopped?: boolean;
  githubRepository?: string;
  githubPushStatus?: string;
}

export async function runProviderAgent(input: RunProviderAgentInput): Promise<{
  text: string;
  iterations: number;
  toolCallCount: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  finishReason: string;
  model: string;
  provider: string;
  errors: string[];
}> {
  const { id, message, template, model } = input;

  // 1. Reset the stop flag like the old path did.
  await fetchMutation(api.sessions.update, { id, agentStopped: false });

  // 2. Resolve provider + connect the sandbox (provider-agnostic).
  const providers = await getProviders(input.secrets);
  const { provider, model: resolvedModel } = getProviderForModel(model, providers);
  console.log(`[engine] provider=${provider.id} model=${resolvedModel || provider.defaultModel}`);

  const webModel = resolvedModel || provider.defaultModel;
  const e2bManager = new E2BManager({
    templateId: template?.image || "YOUR_E2B_TEMPLATE_ID",
    envVars: template?.secrets || {},
  });
  await e2bManager.connectToSandbox(input.sandboxId);
  const sandbox = e2bManager.getSandbox() as unknown as SandboxLike | null;
  if (!sandbox) throw new Error(`Could not connect to sandbox ${input.sandboxId}`);

  const executor = new E2BToolExecutor(sandbox);

  // 3. Build system prompt + history (mirrors the CLI agent's rules).
  const sessionMessages = await fetchSessionMessages(id);
  const assistantMessages = sessionMessages.filter((m) => m.role === "assistant");
  const isFirstMessage = assistantMessages.length === 0;

  let systemPrompt = "";
  if (isFirstMessage) {
    systemPrompt = template?.systemPrompt || "";
    if (systemPrompt.startsWith("FILE:")) {
      systemPrompt = getSystemPrompt(systemPrompt.replace("FILE:", ""));
    }
  }

  const history = buildHistory(sessionMessages);
  const fileInfo = buildFileInfo(sessionMessages);
  const userMessage = fileInfo ? `${message}\n${fileInfo}` : message;

  // 4. Stream events into Convex so the existing chat UI updates live.
  let streamingMessageId: Id<"messages"> | null = null;
  let streamingText = "";
  let lastFlushAt = 0;

  const flushStreaming = async (force: boolean) => {
    if (!streamingText) return;
    const now = Date.now();
    // Throttle deltas to one Convex write every STREAM_FLUSH_MS; force on
    // per-iteration `text` events and before tool results / completion.
    if (!force && now - lastFlushAt < STREAM_FLUSH_MS && streamingText.length < STREAM_FLUSH_CHARS * 2) return;
    try {
      if (streamingMessageId) {
        await fetchMutation(api.messages.update, { id: streamingMessageId, content: streamingText });
      } else {
        streamingMessageId = await fetchMutation(api.messages.add, {
          sessionId: id,
          content: streamingText,
          role: "assistant",
          createdAt: Date.now(),
        });
      }
    } catch (error) {
      console.warn("[engine] failed to flush streaming message:", error);
    }
    lastFlushAt = now;
  };

  const handleEvent = async (event: AgentEvent) => {
    switch (event.type) {
      case "iteration-start": {
        const stopped = await isAgentStopped(id);
        if (stopped) {
          throw new ProviderError({ code: "aborted", provider: provider.id, message: "Agent stopped by user" });
        }
        await flushStreaming(false);
        break;
      }
      case "text-delta":
        streamingText += event.delta;
        if (streamingText.length >= STREAM_FLUSH_CHARS) await flushStreaming(false);
        break;
      case "text":
        streamingText = streamingText || event.text;
        await flushStreaming(true);
        break;
      case "tool-result": {
        await flushStreaming(true);
        await writeToolMessage(id, event.result);
        break;
      }
      case "error":
        await flushStreaming(true);
        if (event.fatal) {
          const friendly = isProviderError(event.error)
            ? `⚠️ **${provider.label} error**\n\n${sanitizeErrorText(event.error.message)}`
            : `⚠️ **Agent error**\n\n${sanitizeErrorText(event.error.message)}`;
          await addMessage(id, friendly, "assistant");
        }
        break;
      default:
        break;
    }
  };

  // 5. Run the loop.
  const result = await runAgentLoop({
    provider,
    model: webModel,
    systemPrompt,
    userMessage,
    history,
    executor,
    onEvent: handleEvent,
    maxIterations: 40,
  });

  await flushStreaming(true);

  // 6. Bill credits (native providers are always credit-mode).
  const session = await getSessionData(id);
  if (session?.createdBy && result.usage.totalTokens > 0) {
    const cost = estimateCostUSD(provider.id, result.usage);
    if (cost > 0) {
      try {
        await fetchMutation(api.billingSwitch.consumeResource, {
          clerkId: session.createdBy,
          messageCostUSD: cost,
        });
        console.log(`[engine] billed $${cost.toFixed(6)} (${provider.id}, model ${result.model})`);
      } catch (error) {
        console.warn("[engine] billing failed:", error);
      }
    }
  }

  // 7. Final status + auto-push to GitHub.
  await updateSessionStatusSafe(id, "RUNNING");
  if (session?.githubRepository && session.githubPushStatus !== "in_progress") {
    await triggerGitHubPush(id, session.githubRepository);
  }

  return {
    text: result.text,
    iterations: result.iterations,
    toolCallCount: result.toolCallCount,
    usage: result.usage,
    finishReason: result.finishReason,
    model: result.model,
    provider: result.provider,
    errors: result.errors,
  };
}

// ---- helpers -------------------------------------------------------------------

async function getProviders(secrets: ProviderSecrets = {}): Promise<Record<ProviderId, AIProvider>> {
  const { createProvider } = await import("./registry");
  return {
    openrouter: createProvider("openrouter", { apiKey: secrets.openrouter }),
    mistral: createProvider("mistral", { apiKey: secrets.mistral }),
    gemini: createProvider("gemini", { apiKey: secrets.gemini }),
  };
}

async function getSessionData(id: Id<"sessions">): Promise<SessionLike | null> {
  try {
    const data = await fetchQuery(api.sessions.getByIdInternal, { id });
    return data as SessionLike | null;
  } catch {
    return null;
  }
}

async function isAgentStopped(id: Id<"sessions">): Promise<boolean> {
  const session = await getSessionData(id);
  return Boolean(session?.agentStopped);
}

interface SessionMessageLike {
  role: string;
  content?: string;
  images?: Array<{ fileName?: string; path?: string; type?: string }>;
  audios?: Array<{ fileName?: string; path?: string }>;
  videos?: Array<{ fileName?: string; path?: string }>;
}

async function fetchSessionMessages(id: Id<"sessions">): Promise<SessionMessageLike[]> {
  try {
    const messages = await fetchQuery(api.messages.getBySession, { sessionId: id });
    return (messages as unknown as SessionMessageLike[]).slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function buildHistory(messages: SessionMessageLike[]): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (const message of messages) {
    const content = message.content?.trim();
    if (!content) continue;
    if (message.role === "user" || message.role === "assistant") {
      history.push({ role: message.role === "user" ? "user" : "assistant", content });
    }
  }
  return history;
}

function buildFileInfo(messages: SessionMessageLike[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  const sections: string[] = [];

  const images = (lastUser.images ?? []).filter((m) => !m.type || m.type === "image");
  const audios = lastUser.audios ?? [];
  const videos = lastUser.videos ?? [];

  if (images.length > 0) {
    sections.push(
      "# IMAGES AVAILABLE\n" +
        images.map((img) => `- File: ${img.fileName} Path: ${img.path}`).join("\n") +
        "\nUse the Read tool to analyze these images (located in /vibe0/assets/)"
    );
  }
  if (audios.length > 0) {
    sections.push(
      "# AUDIO FILES AVAILABLE\n" +
        audios.map((a) => `- File: ${a.fileName} Path: ${a.path}`).join("\n") +
        "\nThese audio files can be used in your app (located in /vibe0/assets/)"
    );
  }
  if (videos.length > 0) {
    sections.push(
      "# VIDEO FILES AVAILABLE\n" +
        videos.map((v) => `- File: ${v.fileName} Path: ${v.path}`).join("\n") +
        "\nThese video files can be used in your app (located in /vibe0/assets/)"
    );
  }
  return sections.join("\n\n");
}

async function writeToolMessage(
  id: Id<"sessions">,
  result: { name: string; data?: Record<string, unknown>; content: string; isError: boolean }
): Promise<void> {
  if (!result.data) return;
  const data = { ...result.data };
  if (result.isError && data.bash) {
    (data.bash as Record<string, unknown>).exitCode = 1;
  }
  await addMessage(id, "", "assistant", data);
}

async function addMessage(
  id: Id<"sessions">,
  content: string,
  role: "user" | "assistant",
  additionalData?: Record<string, unknown>,
  createdAt?: number
): Promise<void> {
  try {
    await fetchMutation(api.messages.add, {
      sessionId: id,
      content,
      role,
      createdAt: createdAt ?? Date.now(),
      ...additionalData,
    });
  } catch (error) {
    console.warn("[engine] failed to add message:", error);
  }
}

async function updateSessionStatusSafe(id: Id<"sessions">, status: SessionStatus): Promise<void> {
  try {
    await fetchMutation(api.sessions.update, { id, status });
  } catch (error) {
    console.warn("[engine] failed to update session status:", error);
  }
}

async function triggerGitHubPush(id: Id<"sessions">, repository: string): Promise<void> {
  try {
    const { inngest } = await import("@/lib/inngest");
    await inngest.send({
      name: "vibracode/push.github",
      data: { sessionId: String(id), convexId: id, repository, isInitialPush: false },
    });
  } catch (error) {
    console.warn("[engine] auto GitHub push failed:", error);
  }
}