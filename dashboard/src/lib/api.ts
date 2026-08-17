const API_BASE = "";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
  });
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface Account {
  id: number;
  email: string;
  status: string;
  enabled: boolean;
  quotaLimit?: number | null;
  quotaRemaining?: number | null;
  lastUsedAt?: string | null;
  lastLoginAt?: string | null;
  errorMessage?: string | null;
  hasTokens: boolean;
  workspaceSubdomain?: string | null;
  createdAt?: string;
}

export interface AccountTestLogEntry {
  step: string;
  message: string;
  level: "info" | "success" | "warn" | "error";
  ts: number;
  elapsedMs: number;
}

export interface AccountTestResult {
  success: boolean;
  available: boolean;
  accountId: number;
  email?: string;
  model: string;
  prompt: string;
  response?: string;
  error?: string;
  durationMs: number;
  matchedExpectedResponse?: boolean;
  logs: AccountTestLogEntry[];
}

export interface AccountImportResult {
  index: number;
  email?: string;
  status: "created" | "updated" | "failed";
  accountId?: number;
  error?: string;
}

export interface AccountImportResponse {
  success: boolean;
  summary: {
    total: number;
    created: number;
    updated: number;
    failed: number;
  };
  results: AccountImportResult[];
}

export interface RecentRequest {
  id: number;
  accountId: number | null;
  accountEmail?: string | null;
  sessionId?: string | null;
  model: string | null;
  reasoningEffort?: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  tokenSource?: "upstream" | "estimated" | "mixed" | null;
  status: string;
  ttfbMs?: number | null;
  durationMs?: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface RequestDetail extends RecentRequest {
  requestMessages: unknown;
  responseMessage: unknown;
}

export interface Stats {
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalAccounts: number;
  activeAccounts: number;
  recentRequestTotal: number;
  recentRequests: RecentRequest[];
}

export interface SessionBinding {
  sessionId: string;
  accountId: number | null;
  accountEmail: string | null;
  accountStatus: string | null;
  accountEnabled: boolean | null;
  revision: number;
  turnCount: number;
  estimatedTokens: number;
  messageChars: number;
  createdAt: string;
  updatedAt: string;
  isInFlight: boolean;
  hasConversation: boolean;
  conversationUpdatedAt?: string | null;
  abnormal: boolean;
}

export interface SessionBindingSummary {
  total: number;
  active30m: number;
  boundAccounts: number;
  abnormal: number;
  recoverable: number;
}

export interface SessionBindingsResponse {
  data: SessionBinding[];
  summary: SessionBindingSummary;
}

export async function fetchAccounts(): Promise<{ data: Account[] }> {
  return api("/api/accounts");
}

export async function loginAccount(
  email: string,
  flow: "login" | "signup" = "login",
  confirmationId?: string,
  signupAutomation?: { username?: string; password: string },
): Promise<{ success: boolean; accountId?: number; imported?: boolean }> {
  return api("/api/accounts/login", {
    method: "POST",
    body: JSON.stringify({ email, flow, confirmationId, signupAutomation }),
  });
}

export async function confirmSignup(confirmationId: string): Promise<{ success: boolean }> {
  return api("/api/accounts/signup/confirm", {
    method: "POST",
    body: JSON.stringify({ confirmationId }),
  });
}

export async function addAccountManual(email: string, tokens: any): Promise<{ success: boolean }> {
  return api("/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email, tokens }),
  });
}

export async function importAccounts(payload: unknown): Promise<AccountImportResponse> {
  return api("/api/accounts/import", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function deleteAccount(id: number): Promise<{ success: boolean }> {
  return api(`/api/accounts/${id}`, { method: "DELETE" });
}

export async function warmupAccount(id: number): Promise<{ success: boolean; error?: string; pending?: boolean; account: Account }> {
  return api(`/api/accounts/${id}/warmup`, { method: "POST" });
}

export async function testAccount(id: number): Promise<AccountTestResult> {
  return api(`/api/accounts/${id}/test`, { method: "POST" });
}

export async function toggleAccount(id: number, enabled: boolean): Promise<{ success: boolean }> {
  return api(`/api/accounts/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export async function fetchStats(requestSearch = ""): Promise<{ data: Stats }> {
  const params = new URLSearchParams();
  if (requestSearch.trim()) params.set("q", requestSearch.trim());
  const query = params.toString();
  return api(`/api/stats${query ? `?${query}` : ""}`);
}

export async function fetchRequestDetail(id: number): Promise<{ data: RequestDetail }> {
  return api(`/api/stats/requests/${id}`);
}

export async function fetchSessionBindings(): Promise<SessionBindingsResponse> {
  return api("/api/sessions");
}

export async function releaseSessionBindings(sessionIds: string[]): Promise<{ success: boolean; count: number }> {
  return api(sessionIds.length > 1 ? "/api/sessions/batch-release" : "/api/sessions/release", {
    method: "POST",
    body: JSON.stringify({ sessionIds }),
  });
}

export async function recoverSessionConversation(sessionId: string): Promise<{
  success: boolean;
  recovered: boolean;
  alreadyBound?: boolean;
  conversationId?: string;
  score?: number;
  scanned?: number;
}> {
  return api("/api/sessions/recover", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

export async function deleteSessionBindings(sessionIds: string[]): Promise<{ success: boolean; count: number }> {
  return api("/api/sessions/delete", {
    method: "POST",
    body: JSON.stringify({ sessionIds }),
  });
}

export async function fetchSettings(): Promise<{ data: Record<string, string> }> {
  return api("/api/settings");
}

export async function updateSettings(settings: Record<string, string>): Promise<{ success: boolean }> {
  return api("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}
