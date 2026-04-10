# Remote Vaultwarden MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the stdio-only MCP server to support HTTP transport with bearer token auth, fix auth bugs, Dockerize, and deploy on Schrombus.

**Architecture:** Replace StdioServerTransport with StreamableHTTPServerTransport behind a bearer token check. Each MCP session gets its own transport instance tracked in a Map. Dual-mode (http/stdio) via MCP_TRANSPORT env var. Docker container bundles Node.js + Bitwarden CLI, deployed behind Traefik on Schrombus.

**Tech Stack:** Node.js, @modelcontextprotocol/sdk (StreamableHTTPServerTransport), node:http, node:crypto, Docker, Traefik

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/bw-client.ts` | Modify | Fix loginWithApiKey locked-state + stale-session recovery in both login methods |
| `src/index.ts` | Modify | Add HTTP server, bearer token auth, StreamableHTTPServerTransport, dual transport, fix stale authenticated flag |
| `Dockerfile` | Create | Multi-stage build: compile TS → slim runtime with bw CLI |
| `docker-compose.yml` | Create | Service definition with Traefik labels, env vars, volumes |
| `.dockerignore` | Create | Exclude node_modules, .git, .env, dist from build context |

---

### Task 1: Fix auth bugs in bw-client.ts

**Files:**
- Modify: `src/bw-client.ts:154-225` (login and loginWithApiKey methods)

- [ ] **Step 1: Fix `loginWithApiKey` to handle "locked" state with user mismatch**

In `src/bw-client.ts`, replace the `loginWithApiKey` method (lines 191-225) with:

```typescript
  /**
   * Login with API key (client_id + client_secret) then unlock with password.
   */
  async loginWithApiKey(
    clientId: string,
    clientSecret: string,
    password: string
  ): Promise<string> {
    await this.configure();

    let status = await this.getStatus();

    // Already unlocked — just sync
    if (status.status === "unlocked") {
      await this.sync();
      return this.sessionKey ?? "";
    }

    // Locked under a different or unknown user — logout first
    if (status.status === "locked") {
      console.error("Vault is locked, logging out to start fresh...");
      try {
        await this.logout();
      } catch {
        // Logout can fail if session is corrupt — ignore
      }
      status = await this.getStatus();
    }

    // Now we should be unauthenticated — login with API key
    if (status.status === "unauthenticated") {
      const loginEnv = {
        ...process.env as Record<string, string>,
        BW_CLIENTID: clientId,
        BW_CLIENTSECRET: clientSecret,
        BW_NOINTERACTION: "true",
        BITWARDENCLI_APPDATA_DIR:
          process.env["BITWARDENCLI_APPDATA_DIR"] ??
          `${process.env["HOME"] ?? "/tmp"}/.bw-mcp`,
      };
      try {
        await execFileAsync("bw", ["login", "--apikey"], {
          env: loginEnv,
          timeout: 30000,
        });
      } catch (error: unknown) {
        const err = error as { stderr?: string; message?: string };
        throw new Error(`API key login failed: ${err.stderr ?? err.message}`);
      }
    }

    // Unlock with master password
    const raw = await this.exec(
      ["unlock", password, "--raw"],
      { noSession: true }
    );
    this.sessionKey = raw;
    await this.sync();
    return this.sessionKey;
  }
```

- [ ] **Step 2: Add logout-before-login recovery to the `login` (email/password) method**

In `src/bw-client.ts`, replace the `login` method (lines 154-186) with:

```typescript
  /**
   * Log in with email + password and unlock the vault.
   * Returns the session key.
   */
  async login(email: string, password: string): Promise<string> {
    await this.configure();

    let status = await this.getStatus();

    if (status.status === "unlocked") {
      await this.sync();
      return this.sessionKey ?? "";
    }

    if (status.status === "locked") {
      // Locked — unlock with password
      const raw = await this.exec(
        ["unlock", password, "--raw"],
        { noSession: true }
      );
      this.sessionKey = raw;
      await this.sync();
      return this.sessionKey;
    }

    // Unauthenticated — full login
    try {
      const raw = await this.exec(
        ["login", email, password, "--raw"],
        { noSession: true }
      );
      this.sessionKey = raw;
    } catch {
      // May fail if stale session exists — logout and retry
      console.error("Login failed, attempting logout and retry...");
      try { await this.logout(); } catch { /* ignore */ }
      const raw = await this.exec(
        ["login", email, password, "--raw"],
        { noSession: true }
      );
      this.sessionKey = raw;
    }

    await this.sync();
    return this.sessionKey;
  }
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd /Users/aniansollinger/dev/LMCustoms/vaultwarden-mcp-server && npm run build`
Expected: Clean compilation, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/bw-client.ts
git commit -m "fix: handle stale sessions and locked-state in login methods"
```

---

### Task 2: Add HTTP transport with bearer token auth to index.ts

**Files:**
- Modify: `src/index.ts` (replace transport setup and add HTTP server)

- [ ] **Step 1: Add imports for HTTP transport**

In `src/index.ts`, replace the existing import block (lines 19-23) with:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BWClient, CipherType } from "./bw-client.js";
import type { VaultItem } from "./bw-client.js";
```

- [ ] **Step 2: Fix stale `authenticated` flag in `ensureAuthenticated`**

In `src/index.ts`, replace the `ensureAuthenticated` function (lines 115-143) with:

```typescript
async function ensureAuthenticated(): Promise<void> {
  // Validate that an existing session is still alive
  if (authenticated) {
    try {
      const status = await client.getStatus();
      if (status.status === "unlocked") return;
      // Session went stale — re-authenticate
      console.error("Session stale, re-authenticating...");
      authenticated = false;
    } catch {
      authenticated = false;
    }
  }

  // If a session key is provided, use it directly
  const existingSession = process.env["BW_SESSION"];
  if (existingSession) {
    client.setSession(existingSession);
    authenticated = true;
    return;
  }

  const email = process.env["BW_EMAIL"];
  const password = process.env["BW_PASSWORD"];
  const clientId = process.env["BW_CLIENT_ID"];
  const clientSecret = process.env["BW_CLIENT_SECRET"];

  if (clientId && clientSecret && password) {
    await client.loginWithApiKey(clientId, clientSecret, password);
    authenticated = true;
  } else if (email && password) {
    await client.login(email, password);
    authenticated = true;
  } else {
    throw new Error(
      "No credentials configured. Set BW_SESSION, or BW_EMAIL + BW_PASSWORD, " +
        "or BW_CLIENT_ID + BW_CLIENT_SECRET + BW_PASSWORD."
    );
  }
}
```

- [ ] **Step 3: Replace the `main` function with dual-transport startup**

In `src/index.ts`, replace the `main` function and its invocation (lines 486-496) with:

```typescript
// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const MCP_PORT = parseInt(process.env["MCP_PORT"] ?? "3000", 10);
const MCP_AUTH_TOKEN = process.env["MCP_AUTH_TOKEN"];
const MCP_TRANSPORT = process.env["MCP_TRANSPORT"] ?? "http";

/** Verify bearer token. Returns true if valid, sends 401 and returns false if not. */
function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!MCP_AUTH_TOKEN) return true; // No token configured = no auth (dev mode)
  const authHeader = req.headers["authorization"];
  if (authHeader === `Bearer ${MCP_AUTH_TOKEN}`) return true;
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
  return false;
}

/** Read the full request body as parsed JSON. */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (MCP_TRANSPORT === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Vaultwarden MCP Server running on stdio");
    return;
  }

  // HTTP mode — one transport per session
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Auth check
    if (!checkAuth(req, res)) return;

    // Only handle /mcp path
    const url = new URL(req.url ?? "/", `http://localhost:${MCP_PORT}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    // Health check shortcut
    if (req.method === "GET" && !req.headers.accept?.includes("text/event-stream")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "vaultwarden-mcp-server" }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    // Existing session
    if (transport) {
      const body = await readBody(req);
      await transport.handleRequest(req, res, body);
      return;
    }

    // New session (POST with initialize)
    if (req.method === "POST") {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport!);
          console.error(`Session created: ${id}`);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          console.error(`Session closed: ${id}`);
        },
      });

      // Each session gets its own McpServer instance sharing the same BWClient
      const sessionServer = new McpServer({
        name: "vaultwarden-mcp-server",
        version: "1.0.0",
      });
      registerTools(sessionServer);
      await sessionServer.connect(transport);

      const body = await readBody(req);
      await transport.handleRequest(req, res, body);
      return;
    }

    // Unknown session for GET/DELETE
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No valid session. Send an initialize request first." }));
  });

  httpServer.listen(MCP_PORT, "0.0.0.0", () => {
    console.error(`Vaultwarden MCP Server listening on http://0.0.0.0:${MCP_PORT}/mcp`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 4: Extract tool registration into a `registerTools` function**

Since HTTP mode creates a new McpServer per session, the 14 tool registrations need to be callable on any server instance. In `src/index.ts`, wrap all the `server.tool(...)` calls (lines 150-480) in a function, and call it once for the top-level server (used in stdio mode):

Replace the line `const server = new McpServer({` block (lines 104-107) and the comment + tools section (lines 109-480) with:

```typescript
const server = new McpServer({
  name: "vaultwarden-mcp-server",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function registerTools(srv: McpServer): void {
  // 1. vault_status
  srv.tool(
    "vault_status",
    ...existing implementation unchanged...
  );

  // ... all 14 tools, identical to current code but using `srv` instead of `server` ...
}

// Register tools on the default server (used for stdio mode)
registerTools(server);
```

Every `server.tool(...)` call becomes `srv.tool(...)`. The tool callback bodies stay identical — they all close over the shared `client` and `ensureAuthenticated` which are module-level.

- [ ] **Step 5: Verify the build compiles**

Run: `cd /Users/aniansollinger/dev/LMCustoms/vaultwarden-mcp-server && npm run build`
Expected: Clean compilation, no errors.

- [ ] **Step 6: Test HTTP mode locally**

Run the server:
```bash
MCP_TRANSPORT=http MCP_AUTH_TOKEN=test-token-123 MCP_PORT=3000 node dist/index.js
```

In another terminal, test health check:
```bash
curl -H "Authorization: Bearer test-token-123" http://localhost:3000/mcp
```
Expected: `{"status":"ok","server":"vaultwarden-mcp-server"}`

Test without token:
```bash
curl http://localhost:3000/mcp
```
Expected: HTTP 401 `{"error":"Unauthorized"}`

Test MCP initialize:
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
```
Expected: SSE stream with initialize response containing server capabilities and session ID in `Mcp-Session-Id` header.

- [ ] **Step 7: Test stdio mode still works**

Run:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | MCP_TRANSPORT=stdio node dist/index.js
```
Expected: JSON-RPC response on stdout with server capabilities.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "feat: add HTTP transport with bearer token auth and dual-mode support"
```

---

### Task 3: Create Docker configuration

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Create `.dockerignore`**

Create `.dockerignore` at project root:

```
node_modules
dist
.git
.env
*.tsbuildinfo
docs
.github
```

- [ ] **Step 2: Create `Dockerfile`**

Create `Dockerfile` at project root:

```dockerfile
# -- Build stage --
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# -- Runtime stage --
FROM node:20-slim
WORKDIR /app

# Install Bitwarden CLI globally
RUN npm install -g @bitwarden/cli

# Copy compiled output and production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ ./dist/

# Default env
ENV MCP_TRANSPORT=http
ENV MCP_PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Build the Docker image locally to verify**

Run:
```bash
cd /Users/aniansollinger/dev/LMCustoms/vaultwarden-mcp-server && docker build -t vaultwarden-mcp-server .
```
Expected: Successful build, no errors.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "feat: add Dockerfile for containerized deployment"
```

---

### Task 4: Create docker-compose.yml

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Create `docker-compose.yml`**

Create `docker-compose.yml` at project root:

```yaml
services:
  vaultwarden-mcp:
    build: .
    container_name: vaultwarden-mcp-server
    restart: unless-stopped
    environment:
      - MCP_TRANSPORT=http
      - MCP_PORT=3000
      - MCP_AUTH_TOKEN=${MCP_AUTH_TOKEN}
      - BW_SERVER_URL=${BW_SERVER_URL}
      - BW_CLIENT_ID=${BW_CLIENT_ID}
      - BW_CLIENT_SECRET=${BW_CLIENT_SECRET}
      - BW_PASSWORD=${BW_PASSWORD}
      - BITWARDENCLI_APPDATA_DIR=/data/.bw-mcp
    volumes:
      - bw-data:/data/.bw-mcp
    expose:
      - "3000"
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.vaultwarden-mcp.rule=Host(`${MCP_HOST}`)"
      - "traefik.http.routers.vaultwarden-mcp.entrypoints=websecure"
      - "traefik.http.routers.vaultwarden-mcp.tls.certresolver=letsencrypt"
      - "traefik.http.services.vaultwarden-mcp.loadbalancer.server.port=3000"
    networks:
      - traefik

volumes:
  bw-data:

networks:
  traefik:
    external: true
```

Note: `MCP_HOST` is the subdomain you want (e.g. `mcp-vault.yourdomain.com`). Set it in `.env` alongside the other variables. The Traefik network name may differ on Schrombus — adjust `networks.traefik.name` if needed.

- [ ] **Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add docker-compose with Traefik labels for deployment"
```

---

### Task 5: Local integration test

- [ ] **Step 1: Run the container with docker compose**

Create a temporary `.env` for local testing (do NOT commit):
```bash
cat > /Users/aniansollinger/dev/LMCustoms/vaultwarden-mcp-server/.env << 'EOF'
MCP_AUTH_TOKEN=local-test-token
BW_SERVER_URL=https://vault.lmcustoms.cc
BW_CLIENT_ID=<user provides>
BW_CLIENT_SECRET=<user provides>
BW_PASSWORD=<user provides>
MCP_HOST=localhost
EOF
```

Then run:
```bash
docker compose up --build -d
docker compose logs -f vaultwarden-mcp
```
Expected: Server starts, prints "Vaultwarden MCP Server listening on http://0.0.0.0:3000/mcp"

- [ ] **Step 2: Test MCP initialize through docker**

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer local-test-token" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
```
Expected: Initialize response with server capabilities.

- [ ] **Step 3: Test vault_status tool through MCP**

Using the session ID from Step 2, send a tools/call request:
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer local-test-token" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <session-id-from-step-2>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"vault_status","arguments":{}}}'
```
Expected: Response with vault status info.

- [ ] **Step 4: Test vault_login tool**

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer local-test-token" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <session-id-from-step-2>" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"vault_login","arguments":{}}}'
```
Expected: "Vault unlocked and synced successfully." (This confirms the auth bug fixes work.)

- [ ] **Step 5: Clean up local test**

```bash
docker compose down
rm .env
```

---

### Task 6: Deploy to Schrombus

- [ ] **Step 1: SSH into Schrombus and clone the repo**

```bash
ssh schrombus
cd /opt  # or wherever services live on Schrombus
git clone https://github.com/LMCustoms/vaultwarden-mcp-server.git
cd vaultwarden-mcp-server
```

(If already cloned, `git pull` instead.)

- [ ] **Step 2: Create `.env` file on Schrombus**

```bash
cat > .env << 'EOF'
MCP_AUTH_TOKEN=<user-provided-token>
BW_SERVER_URL=<user-provided>
BW_CLIENT_ID=<user-provided>
BW_CLIENT_SECRET=<user-provided>
BW_PASSWORD=<user-provided>
MCP_HOST=<chosen-subdomain>
EOF
chmod 600 .env
```

- [ ] **Step 3: Verify Traefik network name**

```bash
docker network ls | grep traefik
```

If the network name differs from `traefik`, update `docker-compose.yml` accordingly.

- [ ] **Step 4: Build and start**

```bash
docker compose up --build -d
docker compose logs -f vaultwarden-mcp
```
Expected: Server starts successfully.

- [ ] **Step 5: Verify TLS and remote access**

From local machine:
```bash
curl https://<mcp-host>/mcp -H "Authorization: Bearer <token>"
```
Expected: `{"status":"ok","server":"vaultwarden-mcp-server"}`

- [ ] **Step 6: Test full MCP flow remotely**

Send initialize + vault_login through the remote endpoint to verify end-to-end.
