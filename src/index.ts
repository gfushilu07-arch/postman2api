import { Hono } from "hono";
import { config } from "./config";
import { chatRouter } from "./api/chat";
import { modelsRouter } from "./api/models";
import { accountsRouter } from "./api/accounts";
import { statsRouter } from "./api/stats";
import { settingsRouter } from "./api/settings";
import { sessionsRouter } from "./api/sessions";
import { addClient, removeClient } from "./ws";
import { startWarmupScheduler, stopWarmupScheduler } from "./auth/warmup";
import { db } from "./db/index";
import { settings } from "./db/schema";
import { eq } from "drizzle-orm";
import { isDefaultEncryptionKey } from "./utils/crypto";
import { acceptsApiKey } from "./auth/api-key";
import { startRetentionScheduler, stopRetentionScheduler } from "./db/retention";
import {
  closeDatabaseWriteQueue,
  initializeDatabaseWriteQueue,
} from "./db/write-queue";
import { APP_VERSION } from "./version";

const app = new Hono();

// Health check
app.get("/health", (c) => c.json({ status: "ok", version: APP_VERSION, uptime: process.uptime() }));

// API key auth middleware for /v1/* routes (API consumers)
app.use("/v1/*", async (c, next) => {
  const apiKey = await getApiKey();
  if (!acceptsApiKey(apiKey, c.req.header("Authorization"), c.req.header("x-api-key"))) {
    return c.json({ error: { message: "Invalid API key", type: "invalid_api_key" } }, 401);
  }
  await next();
});

// Routes
app.route("/", chatRouter);
app.route("/", modelsRouter);
app.route("/api/accounts", accountsRouter);
app.route("/api/stats", statsRouter);
app.route("/api/settings", settingsRouter);
app.route("/api/sessions", sessionsRouter);

app.get("/docs/postman-account-token.md", async () => {
  const file = Bun.file("docs/postman-account-token.md");
  if (!(await file.exists())) return new Response("Document not found", { status: 404 });
  return new Response(file, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
});

// Serve dashboard static files
app.get("*", async (c) => {
  const path = c.req.path;
  if (path === "/" || path === "/index.html") {
    const file = Bun.file("dashboard/dist/index.html");
    if (await file.exists()) return new Response(file);
    return c.text("Dashboard not built. Run: cd dashboard && bun install && bun run build", 404);
  }
  const file = Bun.file(`dashboard/dist${path}`);
  if (await file.exists()) return new Response(file);
  // SPA fallback
  const index = Bun.file("dashboard/dist/index.html");
  if (await index.exists()) return new Response(index);
  return c.text("Not found", 404);
});

async function getApiKey(): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "api_key")).limit(1);
  return row?.value || config.apiKey;
}

// Fail fast if the compiled SQLite worker is missing or cannot open the
// configured database. This also makes Docker's startup health check cover the
// asynchronous write path used by proxy requests.
await initializeDatabaseWriteQueue();

// Start server
const server = Bun.serve({
  port: config.port,
  idleTimeout: config.serverIdleTimeoutSeconds,
  fetch(request, bunServer) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected a WebSocket upgrade request", { status: 426 });
      }
      if (bunServer.upgrade(request)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return app.fetch(request);
  },
  websocket: {
    open(ws) {
      addClient(ws);
    },
    message(ws, message) {
      // Ignore client messages — server-push only
    },
    close(ws) {
      removeClient(ws);
    },
  },
});

// Start warmup scheduler
startWarmupScheduler();
startRetentionScheduler();

if (isDefaultEncryptionKey()) {
  console.warn("[postman2api] WARNING: Using default encryption key. Set ENCRYPTION_KEY in .env!");
}

console.log(`[postman2api] Server running on http://localhost:${config.port}`);
console.log(`[postman2api] Version: ${APP_VERSION}`);
console.log(`[postman2api] OpenAI:  http://localhost:${config.port}/v1/chat/completions`);
console.log(`[postman2api] Anthropic: http://localhost:${config.port}/v1/messages`);
console.log(`[postman2api] Dashboard: http://localhost:${config.port}/`);
console.log(`[postman2api] WebSocket: ws://localhost:${config.port}/ws`);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[postman2api] Received ${signal}, shutting down...`);
  stopWarmupScheduler();
  stopRetentionScheduler();
  server.stop();
  await closeDatabaseWriteQueue();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export { app, server };
