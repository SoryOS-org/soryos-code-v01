/**
 * Multi-provider engine — public API.
 *
 * Replace-Anthropic: providers run natively in the Next.js backend instead of
 * spawning the Claude Code / Gemini CLIs inside the E2B sandbox. The sandbox
 * remains — it hosts the app and executes the agent's tool calls (read/write
 * files, run commands) via `E2BToolExecutor`.
 */

export * from "./types";
export * from "./errors";
export * from "./http";
export * from "./openai-compatible";
export * from "./openrouter";
export * from "./mistral";
export * from "./gemini";
export * from "./registry";
export * from "./tools";
export * from "./tool-executor";
export * from "./agent-loop";
export * from "./engine";