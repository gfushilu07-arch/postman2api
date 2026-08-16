import path from "node:path";
import { parseLoginBrowserBackend } from "./auth/browser-launcher";

// Resolve relative runtime paths from the launch directory, not import.meta.dir.
// Compiled entry points live at dist/index.js and dist/db/migrate.js, so using
// their module directories made migration and server processes open different
// SQLite files. Package scripts and Docker both launch from the project/app root.
const projectRoot = process.cwd();
const runtimeEnvironment = process.env.NODE_ENV === "production"
  ? "production"
  : process.env.NODE_ENV === "test"
    ? "test"
    : "development";

function resolveFromRoot(value: string | undefined, fallback: string): string {
  const raw = value && value.length > 0 ? value : fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  return Math.max(1, Math.floor(positiveNumber(value, fallback)));
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : fallback;
}

const streamReadTimeoutMs = positiveNumber(process.env.STREAM_READ_TIMEOUT_MS, 300_000);
const providerRequestTimeoutMs = positiveNumber(process.env.PROVIDER_REQUEST_TIMEOUT_MS, 480_000);
const ttfbTimeoutMs = positiveNumber(process.env.TTFB_TIMEOUT_MS, 480_000);
const quotaSafeStreamBufferBytes = positiveNumber(
  process.env.QUOTA_SAFE_STREAM_BUFFER_BYTES,
  16 * 1024 * 1024,
);
const streamKeepaliveIntervalMs = positiveNumber(process.env.STREAM_KEEPALIVE_INTERVAL_MS, 10_000);
const postmanFetchVerbose = /^(1|true|yes)$/i.test(process.env.POSTMAN_FETCH_VERBOSE || "");
const accountMaxConcurrency = positiveInteger(process.env.ACCOUNT_MAX_CONCURRENCY, 2);
const accountCapacityWaitMs = positiveInteger(process.env.ACCOUNT_CAPACITY_WAIT_MS, 60_000);
const sessionRebalanceIdleMs = positiveInteger(process.env.SESSION_REBALANCE_IDLE_MS, 10 * 60 * 1000);
const requestLogRetainCount = positiveInteger(process.env.REQUEST_LOG_RETAIN_COUNT, 50);
const requestLogCleanupThreshold = Math.max(
  requestLogRetainCount + 1,
  positiveInteger(process.env.REQUEST_LOG_CLEANUP_THRESHOLD, 100),
);
const productionDatabasePath = resolveFromRoot(
  process.env.DATABASE_PATH,
  "data/postman2api.db",
);
const databasePath = runtimeEnvironment === "production"
  ? resolveFromRoot(process.env.DATABASE_PATH, "data/postman2api.db")
  : runtimeEnvironment === "test"
    ? resolveFromRoot(process.env.TEST_DATABASE_PATH, "data/postman2api.test.db")
    : resolveFromRoot(process.env.DEV_DATABASE_PATH, "data/postman2api.dev.db");

if (runtimeEnvironment !== "production" && databasePath === productionDatabasePath) {
  throw new Error(
    `[config] Refusing to use the production database in ${runtimeEnvironment} mode: ${databasePath}`,
  );
}

export const config = {
  runtimeEnvironment,
  port: Number(process.env.PORT) || 1930,
  dashboardPort: Number(process.env.DASHBOARD_PORT) || 1931,
  apiKey: process.env.API_KEY || "postman2api-secret-key",
  databasePath,
  encryptionKey: process.env.ENCRYPTION_KEY || "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  streamReadTimeoutMs,
  providerRequestTimeoutMs,
  ttfbTimeoutMs,
  quotaSafeStreamBufferBytes,
  streamKeepaliveIntervalMs,
  postmanFetchVerbose,
  accountMaxConcurrency,
  accountCapacityWaitMs,
  sessionRebalanceIdleMs,
  requestLogRetainCount,
  requestLogCleanupThreshold,
  requestLogCleanupIntervalMs: positiveInteger(
    process.env.REQUEST_LOG_CLEANUP_INTERVAL_MS,
    10 * 60 * 1000,
  ),
  sqliteBusyTimeoutMs: positiveInteger(process.env.SQLITE_BUSY_TIMEOUT_MS, 30_000),
  sessionRetentionDays: positiveInteger(process.env.SESSION_RETENTION_DAYS, 30),
  // Estimated input-token budget. 0 disables local context trimming.
  contextMaxTokens: nonNegativeInteger(process.env.CONTEXT_MAX_TOKENS, 500_000),
  loginBrowserBackend: parseLoginBrowserBackend(process.env.LOGIN_BROWSER_BACKEND),
  // Bun.serve expects seconds and supports at most 255. Prefer the longer
  // provider/stream timeout, capped to Bun's supported range.
  serverIdleTimeoutSeconds: Math.min(
    255,
    Math.max(1, Math.ceil(Math.max(streamReadTimeoutMs, providerRequestTimeoutMs) / 1000)),
  ),
} as const;

export type Config = typeof config;
