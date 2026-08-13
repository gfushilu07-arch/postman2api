import { Hono } from "hono";
import { handleChatCompletion } from "../proxy/index";
import {
  anthropicToOpenAI,
  openAIStreamToAnthropic,
  openAIToAnthropic,
  type AnthropicMessagesRequest,
} from "../proxy/transforms/anthropic";
import { resolveClientSessionId } from "./client-session";

export const chatRouter = new Hono();

chatRouter.post("/v1/chat/completions", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON body", type: "invalid_request" } }, 400);
  }

  if (!body.model) {
    return c.json({ error: { message: "Missing 'model' field", type: "invalid_request" } }, 400);
  }
  if (!body.messages || !Array.isArray(body.messages)) {
    return c.json({ error: { message: "Missing 'messages' field", type: "invalid_request" } }, 400);
  }

  body._sessionId = resolveClientSessionId(c.req.raw.headers, body, "openai");
  const signal = c.req.raw.signal;
  const response = await handleChatCompletion(body, signal);

  const headers = new Headers();
  response.headers.forEach((v, k) => headers.set(k, v));
  return new Response(response.body, { status: response.status, headers });
});

chatRouter.post("/v1/messages", async (c) => {
  let body: AnthropicMessagesRequest;
  try {
    body = await c.req.json<AnthropicMessagesRequest>();
  } catch {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }, 400);
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "messages is required" } }, 400);
  }
  if (!body.model) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "model is required" } }, 400);
  }

  const originalModel = body.model;
  body.model = normalizeModel(body.model);

  const openAIRequest = anthropicToOpenAI(body);
  openAIRequest._originalModel = originalModel;
  openAIRequest._sessionId = resolveClientSessionId(c.req.raw.headers, body, "anthropic");
  const signal = c.req.raw.signal;

  try {
    const response = await handleChatCompletion(openAIRequest, signal);

    if (!response.ok) {
      const message = await readErrorMessage(response);
      return c.json(
        { type: "error", error: { type: "api_error", message } },
        response.status as any,
      );
    }

    if (body.stream === true) {
      const stream = response.body;
      if (!stream) {
        return c.json({ type: "error", error: { type: "api_error", message: "No stream returned" } }, 500);
      }
      return new Response(openAIStreamToAnthropic(stream, body), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    const text = await response.text();
    const openAIResponse = JSON.parse(text);

    const result = openAIToAnthropic(openAIResponse, body);
    result.model = originalModel;
    return c.json(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return c.json({ type: "error", error: { type: "api_error", message: errorMessage } }, 500);
  }
});

function normalizeModel(model: string): string {
  const m = model.toLowerCase().trim();
  // Already normalized: claude-opus-4-8 → pass through
  if (/^(claude|gpt|auto)-/.test(m)) return m;
  // Anthropic official IDs with dates → strip to base
  if (m === "claude-sonnet-4-20250514" || m.startsWith("claude-sonnet-4.5")) return "claude-sonnet-4-5";
  if (m === "claude-opus-4-20250514" || m.startsWith("claude-opus-4.8")) return "claude-opus-4-8";
  if (m.startsWith("claude-opus-4.7")) return "claude-opus-4-7";
  if (m.startsWith("claude-opus-4.6")) return "claude-opus-4-6";
  if (m.startsWith("claude-opus-4.5")) return "claude-opus-4-5";
  if (m.startsWith("claude-haiku-4.5")) return "claude-haiku-4-5";
  if (m === "claude-3-5-sonnet-20241022" || m === "claude-3-5-sonnet-latest") return "claude-sonnet-4-5";
  if (m === "claude-3-opus-20240229") return "claude-opus-4-5";
  if (m === "claude-3-sonnet-20240229") return "claude-sonnet-4-5";
  if (m === "claude-3-haiku-20240307") return "claude-haiku-4-5";
  if (m.startsWith("claude-")) return "claude-sonnet-4-5";
  if (m.startsWith("gpt-")) return m;
  return m;
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    return String(body?.error?.message || body?.error || text || `HTTP ${response.status}`);
  } catch {
    return text || `HTTP ${response.status}`;
  }
}
