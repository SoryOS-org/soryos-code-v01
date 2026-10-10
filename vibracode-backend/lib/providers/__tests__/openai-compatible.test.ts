import { test } from "node:test";
import assert from "node:assert/strict";

import { OpenAICompatibleProvider, toOpenAIMessages, toOpenAITools } from "../openai-compatible";
import { ProviderError, isProviderError } from "../errors";
import { ChatMessage, ToolDefinition, StreamEvent } from "../types";

function makeProvider(fetchImpl: typeof fetch, apiKey = "test-key") {
  return new OpenAICompatibleProvider({
    id: "openrouter",
    label: "Test",
    defaultModel: "model-x",
    defaultBaseUrl: "https://api.example.io/v1/",
    apiKey,
    models: [{ id: "model-x", name: "Model X", toolCalling: true }],
    fetchImpl,
    sendStreamOptions: true,
  });
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("toOpenAIMessages: encodes tool results and assistant tool calls", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "/a.ts" }, argumentsRaw: '{"path":"/a.ts"}' }],
    },
    { role: "tool", toolCallId: "c1", name: "read_file", content: "file body" },
  ];
  const out = toOpenAIMessages(messages);
  assert.equal(out[0].role, "system");
  const assistant = (out[2] as { tool_calls: Array<{ function: { name: string } }> }).tool_calls;
  assert.equal(assistant[0].function.name, "read_file");
  assert.equal(out[3].role, "tool");
  assert.equal((out[3] as { tool_call_id: string }).tool_call_id, "c1");
});

test("toOpenAITools: returns undefined when empty, function tools otherwise", () => {
  assert.equal(toOpenAITools([]), undefined);
  assert.equal(toOpenAITools(undefined), undefined);
  const tools: ToolDefinition[] = [
    { name: "run_command", description: "Run a command", parameters: { type: "object", properties: {} } },
  ];
  const out = toOpenAITools(tools);
  assert.equal(out?.[0].type, "function");
  assert.equal(out?.[0].function.name, "run_command");
});

test("openai-compatible: chat() calls the endpoint and parses the result", async () => {
  let captured: CapturedRequest | undefined;
  const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    captured = {
      url,
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    };
    return jsonResponse({
      id: "x",
      model: "model-y",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
  };

  const provider = makeProvider(fetchImpl);
  const result = await provider.chat({ model: "model-x", messages: [{ role: "user", content: "hi" }] });

  assert.equal(result.text, "hello");
  assert.equal(result.model, "model-y");
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 3, totalTokens: 8 });
  assert.equal(result.finishReason, "stop");

  assert.equal(captured?.url, "https://api.example.io/v1/chat/completions");
  assert.equal(captured?.headers["Authorization"], "Bearer test-key");
  assert.equal(captured?.body["model"], "model-x");
  assert.equal(captured?.body["stream"], false);
});

test("openai-compatible: chat() maps HTTP 429 to a rate_limited ProviderError", async () => {
  const fetchImpl: typeof fetch = async () =>
    jsonResponse({ error: { message: "Rate limited, slow down" } }, 429);
  const provider = makeProvider(fetchImpl);
  await assert.rejects(
    () => provider.chat({ model: "model-x", messages: [{ role: "user", content: "hi" }] }),
    (error: unknown) => {
      assert.ok(isProviderError(error));
      assert.equal((error as ProviderError).code, "rate_limited");
      assert.equal((error as ProviderError).retryable, true);
      assert.equal((error as ProviderError).message, "Rate limited, slow down");
      return true;
    }
  );
});

test("openai-compatible: chat() refuses without an API key before calling fetch", async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => {
    called = true;
    return jsonResponse({ choices: [] });
  };
  const provider = new OpenAICompatibleProvider({
    id: "openrouter",
    label: "Test",
    defaultModel: "model-x",
    defaultBaseUrl: "https://api.example.io/v1",
    models: [],
    fetchImpl,
  });
  await assert.rejects(
    () => provider.chat({ model: "model-x", messages: [] }),
    (error: unknown) => (error as ProviderError).code === "missing_api_key"
  );
  assert.equal(called, false);
});

test("openai-compatible: stream() assembles text and tool-call deltas", async () => {
  const sseBody = [
    'data: {"model":"model-y","choices":[{"delta":{"role":"assistant","content":"Hel"}}]}' + "\n\n",
    'data: {"choices":[{"delta":{"content":"lo"}}]}' + "\n\n",
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc1","function":{"name":"read_file","arguments":"{\\"path\\":\\"/a.ts\\"}"}}]}}]}' + "\n\n",
    'data: {"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}' + "\n\n",
    'data: [DONE]' + "\n\n",
  ].join("");

  const fetchImpl: typeof fetch = async () =>
    new Response(sseBody, { headers: { "Content-Type": "text/event-stream" } });

  const provider = makeProvider(fetchImpl, "k");
  const events: StreamEvent[] = [];
  // sendStreamOptions must be emitted for OpenRouter accounting.
  let capturedBody: Record<string, unknown> | undefined;
  const capturingProvider = new OpenAICompatibleProvider({
    id: "openrouter",
    label: "Test",
    defaultModel: "model-x",
    defaultBaseUrl: "https://api.example.io/v1",
    apiKey: "k",
    models: [],
    sendStreamOptions: true,
    fetchImpl: async (input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(sseBody, { headers: { "Content-Type": "text/event-stream" } });
    },
  });

  const result = await capturingProvider.stream(
    { model: "model-x", messages: [{ role: "user", content: "hi" }] },
    (event) => events.push(event)
  );

  assert.equal(result.text, "Hello");
  assert.equal(result.model, "model-y");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "read_file");
  assert.deepEqual(result.toolCalls[0].arguments, { path: "/a.ts" });
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 6, totalTokens: 10 });

  assert.deepEqual(capturedBody?.["stream_options"], { include_usage: true });
  assert.equal(capturedBody?.["stream"], true);

  const deltas = events.filter((e) => e.type === "text-delta").map((e) => (e as any).delta);
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.ok(events.some((e) => e.type === "tool-call"));
});

test("openai-compatible: stream() maps tool-unsupported errors explicitly", async () => {
  const fetchImpl: typeof fetch = async () =>
    jsonResponse(
      { error: { message: "This model does not support tool calling." } },
      400
    );
  const provider = makeProvider(fetchImpl);
  const events: StreamEvent[] = [];
  await assert.rejects(
    () =>
      provider.stream(
        { model: "model-x", messages: [{ role: "user", content: "hi" }] },
        (event) => events.push(event)
      ),
    (error: unknown) => (error as ProviderError).code === "tool_calling_unsupported"
  );
});