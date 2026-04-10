# Remote Vaultwarden MCP Server — Design Spec

**Date:** 2026-04-10
**Status:** Draft
**Goal:** Make the vaultwarden-mcp-server accessible remotely via HTTP transport, fix auth bugs, and Dockerize for deployment on Schrombus.

---

## Problem

The MCP server currently uses stdio transport, requiring Node.js, the Bitwarden CLI, and the source code installed on every machine that wants to use it. The login/auth flow also has bugs that prevent reliable operation.

## Solution

1. Switch to HTTP-based MCP transport (StreamableHTTPServerTransport)
2. Add bearer token authentication
3. Fix auth bugs in the Bitwarden CLI wrapper
4. Dockerize and deploy on Schrombus behind Traefik

---

## 1. Transport & Auth

### HTTP Transport

Replace `StdioServerTransport` with `StreamableHTTPServerTransport` from the MCP SDK. This uses a single HTTP endpoint (`/mcp`) that clients POST to. The MCP SDK handles the JSON-RPC protocol internally.

The HTTP server uses Node's built-in `http` module — no Express or other framework needed.

### Dual Transport Support

An environment variable `MCP_TRANSPORT` controls the transport mode:
- `http` (default) — StreamableHTTPServerTransport on a configurable port
- `stdio` — StdioServerTransport, for local development

### Bearer Token Auth

Every HTTP request is checked for `Authorization: Bearer <token>`. The expected token is read from the `MCP_AUTH_TOKEN` environment variable. Invalid or missing tokens receive a 401 response. This check happens before the request reaches the MCP transport layer.

### Port

Configurable via `MCP_PORT`, default `3000`. Traefik on Schrombus handles TLS termination and routes traffic to this port.

---

## 2. Auth Bug Fixes

### Bug: `loginWithApiKey` missing "locked" state handling

**File:** `src/bw-client.ts`, `loginWithApiKey` method

**Current behavior:** The method handles `"unlocked"` and `"unauthenticated"` states, but when the vault is `"locked"`, it falls through to the unlock step without checking if the locked session belongs to the correct user. If a different user was logged in from a previous run, it unlocks the wrong account.

**Fix:** When status is `"locked"`, check `status.userEmail` against the expected user. If it doesn't match (or if we're using API key auth and can't verify), logout first, then login fresh.

### Bug: No logout-before-login recovery

**Current behavior:** If the CLI has a stale session (from a crash, manual use, or previous container run), `bw login` fails with "You are already logged in."

**Fix:** Wrap the login step in a try-catch. On failure, run `bw logout` and retry once.

### Bug: `authenticated` flag goes stale

**File:** `src/index.ts`, global `authenticated` boolean

**Current behavior:** Once set to `true`, it never revalidates. If the vault is locked externally or the session expires, all tool calls fail.

**Fix:** In `ensureAuthenticated()`, when `authenticated` is `true`, check `bw status`. If status is not `"unlocked"`, reset `authenticated = false` and re-run the auth flow.

---

## 3. Docker & Deployment

### Dockerfile

Multi-stage build:
- **Build stage:** Node.js image, install dependencies, compile TypeScript
- **Runtime stage:** Node.js slim image, install `@bitwarden/cli` globally via npm, copy compiled `dist/` and production `node_modules/`

### docker-compose.yml

Single service with:
- Environment variables for all config (BW_SERVER_URL, BW_CLIENT_ID, BW_CLIENT_SECRET, BW_PASSWORD, MCP_AUTH_TOKEN, MCP_PORT, MCP_TRANSPORT)
- Named volume for `BITWARDENCLI_APPDATA_DIR` (persists bw CLI session state across restarts)
- Connected to Traefik's Docker network
- Traefik labels for TLS routing
- `restart: unless-stopped`

### .dockerignore

Excludes: `node_modules/`, `.git/`, `.env`, `dist/`, `*.tsbuildinfo`

---

## 4. File Changes

### Modified Files

| File | Changes |
|---|---|
| `src/index.ts` | Add HTTP server + StreamableHTTPServerTransport, bearer token middleware, dual transport via MCP_TRANSPORT flag, fix stale `authenticated` flag |
| `src/bw-client.ts` | Fix `loginWithApiKey` locked-state handling, add logout-before-login recovery to both login methods |
| `package.json` | No new dependencies required |

### New Files

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build: Node.js + Bitwarden CLI |
| `docker-compose.yml` | Service definition with Traefik labels |
| `.dockerignore` | Build context exclusions |

---

## 5. Environment Variables

Variables the operator must set on the server (never in the repo):

| Variable | Required | Purpose |
|---|---|---|
| `BW_SERVER_URL` | Yes | Vaultwarden instance URL |
| `BW_CLIENT_ID` | Yes | Bitwarden API key client ID |
| `BW_CLIENT_SECRET` | Yes | Bitwarden API key client secret |
| `BW_PASSWORD` | Yes | Master password for vault unlock |
| `MCP_AUTH_TOKEN` | Yes | Bearer token for HTTP endpoint auth |
| `MCP_PORT` | No | HTTP listen port (default: 3000) |
| `MCP_TRANSPORT` | No | `http` (default) or `stdio` |

---

## 6. Client Configuration

Clients connect with just a URL and header — no local installation required:

```json
{
  "mcpServers": {
    "vaultwarden": {
      "url": "https://<your-domain>/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

---

## 7. Deployment

After implementation, deploy to Schrombus:
1. Push the branch / merge to main
2. SSH into Schrombus, clone/pull the repo
3. Create `.env` file with all required variables
4. Run `docker compose up -d`
5. Verify Traefik picks up the service and TLS works
6. Test the MCP endpoint remotely

---

## Out of Scope

- Tests (no existing test infrastructure; can be added in a follow-up)
- Additional MCP tools beyond the existing 14
- Migration from Bitwarden CLI to direct API calls
- Rate limiting or IP allowlisting (can be added at Traefik level later)
