/**
 * Small transport helpers shared by every provider adapter:
 *  - safe JSON/text error extraction
 *  - a Server-Sent-Events (SSE) line parser that works with fetch Response bodies
 */

import { ProviderConfig } from "./types";

export function resolveFetch(config: ProviderConfig): typeof fetch {
  return config.fetchImpl ?? globalThis.fetch;
}

/** Read a response body as text without throwing (used for error reporting). */
export async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** Best-effort extraction of a human readable message from an error body. */
export function extractErrorMessage(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body);
    // OpenAI / OpenRouter / Mistral
    if (parsed?.error) {
      if (typeof parsed.error === "string") return parsed.error;
      if (typeof parsed.error?.message === "string") return parsed.error.message;
    }
    // Google
    if (parsed?.error?.message) return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON
  }
  return body.slice(0, 800);
}

/**
 * Parse an SSE stream. Yields the raw `data:` payload strings (excluding the
 * `data: ` prefix). Stops at `[DONE]`. Handles multi-line `data:` per the spec.
 */
export async function* parseSSE(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushEvents = function* (chunk: string): Generator<string> {
    const events = chunk.split("\n\n");
    // keep the trailing partial event in the buffer
    buffer = events.pop() ?? "";
    for (const event of events) {
      const dataLines: string[] = [];
      for (const line of event.split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      if (dataLines.length === 0) continue;
      const data = dataLines.join("\n");
      if (data === "[DONE]") return;
      yield data;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalise CRLF so the split works for all providers.
      const normalised = buffer.replace(/\r\n/g, "\n");
      buffer = "";
      for (const data of flushEvents(normalised)) {
        yield data;
        if (data === "[DONE]") return;
      }
    }
    // Flush any remaining event.
    const remaining = buffer.trim();
    if (remaining) {
      for (const data of flushEvents(remaining + "\n\n")) {
        yield data;
        if (data === "[DONE]") return;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

/** Parse a JSON string, returning `undefined` instead of throwing. */
export function safeJsonParse<T = unknown>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
