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
  // Only normalize casing/whitespace. Never turn one Claude/GPT version into
  // another version: unsupported model IDs must fail explicitly.
  return model.trim().toLowerCase();
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
