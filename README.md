> **Educational use only.** This project is provided as-is for research and educational purposes. Only connect Postman accounts you own or are authorized to use, and keep session tokens and API keys private.

# postman2api

`postman2api` is a self-hosted Bun service that exposes a Postman-backed AI chat workflow through OpenAI-compatible and Anthropic-compatible APIs. It includes a local dashboard for account management, multi-account pooling, session-aware routing, and streamed responses.

## Features

- OpenAI-compatible `POST /v1/chat/completions`
- Anthropic-compatible `POST /v1/messages`
- OpenAI-style `GET /v1/models` model discovery
- Browser login and manual JSON import for Postman accounts
- Session-sticky, least-in-flight account selection with quota and rate-limit failover
- Quota-safe streaming, SQLite-backed state, and dashboard updates over WebSocket

## Requirements

- Bun
- Node.js 22 or later for the default Camoufox login backend
- A desktop display when using browser login

Camoufox is installed by the root `postinstall` script. Its browser download may take longer during the first `bun install`.

## Quick Start

```bash
bun install
cd dashboard && bun install && cd ..
cp .env.example .env
bun run build
bun run migrate
bun start
```

Open the dashboard at <http://localhost:1930>.

| Purpose | URL |
| --- | --- |
| Dashboard | `http://localhost:1930/` |
| Health check | `http://localhost:1930/health` |
| Models | `http://localhost:1930/v1/models` |
| OpenAI chat completions | `http://localhost:1930/v1/chat/completions` |
| Anthropic messages | `http://localhost:1930/v1/messages` |

Before using the API, replace the example `API_KEY` and `ENCRYPTION_KEY` in `.env`. Do not expose this service to an untrusted network; the dashboard and management endpoints are intended for a trusted local or private environment.

## Connect Accounts

At least one active Postman account is required before the service can handle a chat request.

### Browser Login

1. Open the dashboard and go to the account tab.
2. Enter an existing account email and choose the login flow.
3. Select **Open Login Browser** and complete sign-in in the visible browser window.
4. Leave the window open while the service retrieves the session and workspace identity.

The service does not read or persist an account password. Browser login waits for completion for up to five minutes. It is intended for existing accounts and does not complete signup onboarding.

### Import Accounts as JSON

Use the dashboard import action for one account or a batch. Each record needs an email and four token values:

```json
{
  "version": 1,
  "accounts": [
    {
      "email": "name@example.com",
      "enabled": true,
      "tokens": {
        "postman_sid": "SESSION_VALUE",
        "user_id": "USER_ID",
        "workspace_id": "WORKSPACE_ID",
        "workspace_subdomain": "TEAM_SUBDOMAIN"
      }
    }
  ]
}
```

The import accepts either this versioned batch object or a single account object. Existing records with the same email are updated. See [the token acquisition and import guide](docs/postman-account-token.md) for where to obtain each value. Never commit, log, or share a real `postman_sid`.

## API Usage

All `/v1/*` endpoints require the key configured in dashboard settings or `API_KEY`. Send it as `Authorization: Bearer ...`; the Anthropic endpoint also accepts `x-api-key`.

### OpenAI-Compatible Chat

```bash
curl http://localhost:1930/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Anthropic-Compatible Messages

```bash
curl http://localhost:1930/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

Anthropic model aliases are normalized where possible. For example, `claude-sonnet-4-20250514` maps to `claude-sonnet-4-5`.

### List Models

```bash
curl http://localhost:1930/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Current model IDs include `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`, and `auto`. Model availability ultimately depends on the connected Postman account and workspace.

## Sessions, Load Balancing, and Streams

Accounts are selected with least-in-flight load balancing. A stable conversation identifier keeps a conversation on its active Postman account, including after a service restart, preserving upstream conversation state.

- OpenAI/Codex clients: `session_id` in the body or `x-session-id` header is recognized.
- Anthropic-compatible clients: native session metadata or headers are recognized.
- Other clients: send a unique `x-session-id` for every conversation.

Do not reuse one session ID for every end user. Requests without a recognized session remain stateless and are balanced per request. Cache-routing values such as `prompt_cache_key` are not conversation identifiers.

An account that is rate-limited enters an account-specific cooldown using the upstream `Retry-After` value, and another eligible account is tried. If quota exhaustion is reported during an SSE response, the service buffers upstream output, discards incomplete content, and retries before model content reaches the client. SSE comment heartbeats are sent while buffering or retrying.

## Configuration

Copy `.env.example` to `.env` and adjust values for your deployment.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `1930` | HTTP service and dashboard port. |
| `DASHBOARD_PORT` | `1931` | Reserved dashboard development setting; production assets are served from `PORT`. |
| `API_KEY` | example value | Key required by `/v1/*` unless changed through dashboard settings. |
| `ENCRYPTION_KEY` | example value | Key used to protect stored sensitive account data. Set a strong unique value. |
| `DATABASE_PATH` | `./data/postman2api.db` | SQLite database path. |
| `TTFB_TIMEOUT_MS` | `45000` | Maximum wait for upstream response headers. |
| `STREAM_READ_TIMEOUT_MS` | `300000` | Maximum idle time between upstream stream chunks. |
| `PROVIDER_REQUEST_TIMEOUT_MS` | `120000` | Fallback timeout for provider calls. |
| `QUOTA_SAFE_STREAM_BUFFER_BYTES` | `16777216` | Maximum bytes buffered for quota-safe streaming. |
| `STREAM_KEEPALIVE_INTERVAL_MS` | `10000` | SSE comment heartbeat interval while buffering or retrying. |
| `POSTMAN_FETCH_VERBOSE` | `false` | Logs lifecycle diagnostics without auth headers or request/response bodies. |
| `BATCHER_PROXY_URL` | unset | Optional proxy for browser automation. |
| `LOGIN_BROWSER_BACKEND` | `camoufox` | Login browser backend: `camoufox` or `playwright`. |

Dashboard settings, including the API key, are stored in SQLite and override the corresponding environment default.

## Browser Backends

Camoufox is the default login backend. Repair or prefetch its browser cache with:

```bash
bun run browser:camoufox:fetch
```

For CI or image builds where browser login is deliberately unavailable, explicitly skip the download:

```bash
CAMOUFOX_SKIP_BROWSER_DOWNLOAD=1 bun install
```

Run the fetch command later, without the skip variable, before using Camoufox login.

To use Playwright Chromium instead:

```bash
bunx playwright install chromium
LOGIN_BROWSER_BACKEND=playwright bun start
```

Backend selection is explicit: an unavailable Camoufox installation does not silently switch to Playwright.

## Development and Validation

```bash
# Run the API with automatic reload
bun run dev

# Build production dashboard assets
bun run build

# Check TypeScript
bun run typecheck

# Run tests
bun test

# Run streaming cancellation tests only
bun run test:stream
```

The browser smoke checks do not sign in or persist a session:

```bash
bun run browser:camoufox:smoke
bun run browser:camoufox:smoke:node
# Optional network check against the public Postman login page
bun run browser:camoufox:smoke:postman
```

## Architecture

```text
API client
    |
    v
Hono API --> session-aware account pool --> Postman provider
    |                  |                         |
    |                  v                         v
    |             SQLite storage             Postman API
    v
React dashboard <------ WebSocket updates
```

The stack is Bun, TypeScript, Hono, Drizzle with SQLite, React/Vite, and Camoufox or Playwright. No Python runtime is required.

## Related Documentation

- [Postman account token acquisition and JSON import](docs/postman-account-token.md)
- [Postman account registration skill](docs/postman-register-skill.md)
- [Camoufox automation example](examples/camoufox-automation/README.md)
