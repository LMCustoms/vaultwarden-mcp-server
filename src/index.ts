#!/usr/bin/env node
/**
 * Vaultwarden MCP Server
 *
 * Exposes Bitwarden/Vaultwarden vault operations as MCP tools
 * via the Bitwarden CLI. Supports stdio and HTTP transports.
 *
 * Required environment variables:
 *   BW_SERVER_URL  – Vaultwarden instance URL (e.g. https://vault.example.com)
 *   BW_EMAIL       – Vault email (for password-based login)
 *   BW_PASSWORD    – Master password (for login / unlock)
 *
 * Optional:
 *   BW_SESSION     – Pre-existing session key (skip login)
 *   BW_CLIENT_ID   – API key client_id  (for API-key login)
 *   BW_CLIENT_SECRET – API key client_secret
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BWClient, CipherType } from "./bw-client.js";
import type { VaultItem } from "./bw-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

/** Format a VaultItem into a human-readable summary (no secrets). */
function formatItemSummary(item: VaultItem): string {
  const parts: string[] = [
    `${item.name} (${CipherType[item.type] ?? "Unknown"}) id=${item.id}`,
  ];
  if (item.login?.username) parts.push(`user=${item.login.username}`);
  if (item.login?.uris?.[0]) parts.push(`uri=${item.login.uris[0].uri}`);
  if (item.card?.brand) parts.push(`card=${item.card.brand}****${item.card.number?.slice(-4) ?? "????"}`);
  if (item.identity?.firstName) parts.push(`name=${item.identity.firstName} ${item.identity.lastName ?? ""}`);
  return parts.join(" ");
}

/** Format a full item including sensitive fields. */
function formatItemFull(item: VaultItem): string {
  const lines: string[] = [
    `${item.name} (${CipherType[item.type] ?? "Unknown"}) id=${item.id}`,
  ];
  if (item.login) {
    if (item.login.username) lines.push(`user: ${item.login.username}`);
    if (item.login.password) lines.push(`pass: ${item.login.password}`);
    if (item.login.totp) lines.push(`totp: ${item.login.totp}`);
    if (item.login.uris?.length) {
      lines.push(`uri: ${item.login.uris.map((u) => u.uri).join(", ")}`);
    }
  }
  if (item.card) {
    if (item.card.cardholderName) lines.push(`cardholder: ${item.card.cardholderName}`);
    if (item.card.number) lines.push(`number: ${item.card.number}`);
    if (item.card.expMonth || item.card.expYear) lines.push(`exp: ${item.card.expMonth}/${item.card.expYear}`);
    if (item.card.code) lines.push(`cvv: ${item.card.code}`);
  }
  if (item.identity) {
    const { firstName, lastName, email, phone } = item.identity;
    if (firstName || lastName) lines.push(`name: ${(firstName ?? "")} ${(lastName ?? "")}`.trim());
    if (email) lines.push(`email: ${email}`);
    if (phone) lines.push(`phone: ${phone}`);
  }
  if (item.fields?.length) {
    for (const f of item.fields) lines.push(`field.${f.name}: ${f.value}`);
  }
  if (item.notes) lines.push(`notes: ${item.notes}`);
  if (item.folderId) lines.push(`folder: ${item.folderId}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Server Setup
// ---------------------------------------------------------------------------

const serverUrl = env("BW_SERVER_URL", "https://vault.lmcustoms.cc");
const client = new BWClient(serverUrl);

const server = new McpServer({
  name: "vaultwarden-mcp-server",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Auto-login helper
// ---------------------------------------------------------------------------

// TODO(multi-session): In HTTP mode, multiple sessions share this flag and the BWClient.
// A per-session or per-client auth context would prevent cross-session interference.
let authenticated = false;

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

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function registerTools(srv: McpServer): void {

// 1. vault_status
srv.tool(
  "vault_status",
  "Check vault lock state and connection",
  {},
  async () => {
    const installed = await client.checkInstalled();
    if (!installed) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: Bitwarden CLI (bw) is not installed or not in PATH." }],
      };
    }
    const status = await client.getStatus();
    return {
      content: [
        {
          type: "text",
          text: [
            `Status: ${status.status}`,
            `Server: ${status.serverUrl ?? "Not configured"}`,
            `User: ${status.userEmail ?? "Not logged in"}`,
            `Last sync: ${status.lastSync ?? "Never"}`,
          ].join("\n"),
        },
      ],
    };
  }
);

// 2. vault_login
srv.tool(
  "vault_login",
  "Unlock the vault",
  {},
  async () => {
    try {
      await ensureAuthenticated();
      return {
        content: [{ type: "text", text: "Unlocked." }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Login failed: ${(err as Error).message}` }],
      };
    }
  }
);

// 3. vault_search
srv.tool(
  "vault_search",
  "Search vault items (no passwords)",
  {
    query: z.string().describe("Search keyword"),
    folderId: z.string().optional().describe("Filter by folder"),
    limit: z.number().optional().describe("Max results (def 10)"),
  },
  async ({ query, folderId, limit }) => {
    await ensureAuthenticated();
    const items = await client.listItems(query, folderId);
    if (items.length === 0) {
      return { content: [{ type: "text", text: "No results." }] };
    }
    const cap = Math.min(limit ?? 10, 50);
    const shown = items.slice(0, cap);
    const lines = shown.map(formatItemSummary);
    if (items.length > cap) lines.push(`(+${items.length - cap} more)`);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

// 4. vault_get_item
srv.tool(
  "vault_get_item",
  "Get full item details including secrets",
  {
    id: z.string().describe("Item ID"),
  },
  async ({ id }) => {
    await ensureAuthenticated();
    const item = await client.getItem(id);
    return {
      content: [{ type: "text", text: formatItemFull(item) }],
    };
  }
);

// 5. vault_get_password
srv.tool(
  "vault_get_password",
  "Get item password only",
  {
    id: z.string().describe("Item ID"),
  },
  async ({ id }) => {
    await ensureAuthenticated();
    const password = await client.getPassword(id);
    return {
      content: [{ type: "text", text: password }],
    };
  }
);

// 6. vault_get_totp
srv.tool(
  "vault_get_totp",
  "Get current TOTP code",
  {
    id: z.string().describe("Item ID"),
  },
  async ({ id }) => {
    await ensureAuthenticated();
    try {
      const code = await client.getTotp(id);
      return {
        content: [{ type: "text", text: code }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `TOTP error: ${(err as Error).message}` }],
      };
    }
  }
);

// 7. vault_create_item
srv.tool(
  "vault_create_item",
  "Create a login item",
  {
    name: z.string().describe("Item name"),
    username: z.string().optional(),
    password: z.string().optional().describe("Omit to auto-generate"),
    uri: z.string().optional(),
    notes: z.string().optional(),
    folderId: z.string().optional().describe("Folder ID"),
    generatePassword: z.boolean().optional().describe("Auto-generate password"),
  },
  async ({ name, username, password, uri, notes, folderId, generatePassword }) => {
    await ensureAuthenticated();

    let finalPassword = password;
    if (!finalPassword && generatePassword) {
      finalPassword = await client.generatePassword({
        length: 24,
        uppercase: true,
        lowercase: true,
        number: true,
        special: true,
      });
    }

    const created = await client.createItem({
      name,
      username,
      password: finalPassword,
      uri,
      notes,
      folderId,
    });

    return {
      content: [
        {
          type: "text",
          text: `id=${created.id}${finalPassword && !password ? `\npass=${finalPassword}` : ""}`,
        },
      ],
    };
  }
);

// 8. vault_edit_item
srv.tool(
  "vault_edit_item",
  "Edit a vault item (partial update)",
  {
    id: z.string().describe("Item ID"),
    name: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    uri: z.string().optional(),
    notes: z.string().optional(),
    folderId: z.string().optional().describe("Target folder ID"),
  },
  async ({ id, name, username, password, uri, notes, folderId }) => {
    await ensureAuthenticated();

    // Fetch current item to merge
    const current = await client.getItem(id);
    const updated: Record<string, unknown> = { ...current };

    if (name !== undefined) updated["name"] = name;
    if (notes !== undefined) updated["notes"] = notes;
    if (folderId !== undefined) updated["folderId"] = folderId;

    if (current.type === CipherType.Login) {
      const login = { ...(current.login ?? {}) };
      if (username !== undefined) login.username = username;
      if (password !== undefined) login.password = password;
      if (uri !== undefined) {
        login.uris = [{ uri, match: null }];
      }
      updated["login"] = login;
    }

    const result = await client.editItem(id, updated);
    return {
      content: [{ type: "text", text: "Updated." }],
    };
  }
);

// 9. vault_delete_item
srv.tool(
  "vault_delete_item",
  "Soft-delete a vault item",
  {
    id: z.string().describe("Item ID"),
    confirm: z
      .boolean()
      .describe("Confirm deletion"),
  },
  async ({ id, confirm }) => {
    if (!confirm) {
      return {
        content: [{ type: "text", text: "Deletion cancelled. Set confirm=true to proceed." }],
      };
    }
    await ensureAuthenticated();
    await client.deleteItem(id);
    return {
      content: [{ type: "text", text: "Deleted." }],
    };
  }
);

// 10. vault_list_folders
srv.tool(
  "vault_list_folders",
  "List folders",
  {},
  async () => {
    await ensureAuthenticated();
    const folders = await client.listFolders();
    if (folders.length === 0) {
      return { content: [{ type: "text", text: "No folders found." }] };
    }
    const text = folders.map((f) => `${f.name} id=${f.id}`).join("\n");
    return {
      content: [{ type: "text", text }],
    };
  }
);

// 11. vault_create_folder
srv.tool(
  "vault_create_folder",
  "Create a folder",
  {
    name: z.string(),
  },
  async ({ name }) => {
    await ensureAuthenticated();
    const folder = await client.createFolder(name);
    return {
      content: [{ type: "text", text: `id=${folder.id}` }],
    };
  }
);

// 12. vault_generate_password
srv.tool(
  "vault_generate_password",
  "Generate a password or passphrase",
  {
    length: z.number().optional().describe("Length (def 16)"),
    uppercase: z.boolean().optional(),
    lowercase: z.boolean().optional(),
    numbers: z.boolean().optional(),
    special: z.boolean().optional(),
    passphrase: z.boolean().optional().describe("Passphrase mode"),
    words: z.number().optional().describe("Word count (def 3)"),
    separator: z.string().optional().describe("Separator (def '-')"),
  },
  async ({ length, uppercase, lowercase, numbers, special, passphrase, words, separator }) => {
    const pw = await client.generatePassword({
      length: length ?? 16,
      uppercase: uppercase ?? true,
      lowercase: lowercase ?? true,
      number: numbers ?? true,
      special: special ?? true,
      passphrase,
      words,
      separator,
    });
    return {
      content: [{ type: "text", text: pw }],
    };
  }
);

// 13. vault_sync
srv.tool(
  "vault_sync",
  "Sync vault with server",
  {},
  async () => {
    await ensureAuthenticated();
    await client.sync();
    return {
      content: [{ type: "text", text: "Synced." }],
    };
  }
);

// 14. vault_lock
srv.tool(
  "vault_lock",
  "Lock the vault",
  {},
  async () => {
    await client.lock();
    authenticated = false;
    return {
      content: [{ type: "text", text: "Vault locked." }],
    };
  }
);

} // end registerTools

// Register tools on the default server (used for stdio mode)
registerTools(server);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const rawPort = parseInt(process.env["MCP_PORT"] ?? "3000", 10);
const MCP_PORT = isNaN(rawPort) ? 3000 : rawPort;
const MCP_AUTH_TOKEN = process.env["MCP_AUTH_TOKEN"];
if (!MCP_AUTH_TOKEN && (process.env["MCP_TRANSPORT"] ?? "http") === "http") {
  console.error("WARNING: MCP_AUTH_TOKEN is not set — server is open to unauthenticated access");
}
const MCP_TRANSPORT = process.env["MCP_TRANSPORT"] ?? "http";

/** Verify bearer token. Returns true if valid, sends 401 and returns false if not. */
function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!MCP_AUTH_TOKEN) {
    return true;
  }
  const authHeader = req.headers["authorization"] ?? "";
  const expected = `Bearer ${MCP_AUTH_TOKEN}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  const match = a.length === b.length && timingSafeEqual(a, b);
  if (match) return true;
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
      const sessionServer = new McpServer({
        name: "vaultwarden-mcp-server",
        version: "1.0.0",
      });
      registerTools(sessionServer);

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport!);
          console.error(`Session created: ${id}`);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          sessionServer.close().catch(() => {});
          console.error(`Session closed: ${id}`);
        },
      });

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
