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
  const lines: string[] = [
    `**${item.name}** (${CipherType[item.type] ?? "Unknown"})`,
    `ID: ${item.id}`,
  ];
  if (item.login?.username) lines.push(`Username: ${item.login.username}`);
  if (item.login?.uris?.length) {
    lines.push(`URIs: ${item.login.uris.map((u) => u.uri).join(", ")}`);
  }
  if (item.folderId) lines.push(`Folder: ${item.folderId}`);
  if (item.notes) lines.push(`Notes: ${item.notes.slice(0, 120)}…`);
  if (item.card?.brand) lines.push(`Card: ${item.card.brand} ****${item.card.number?.slice(-4) ?? "????"}`);
  if (item.identity?.firstName) {
    lines.push(`Identity: ${item.identity.firstName} ${item.identity.lastName ?? ""}`);
  }
  lines.push(`Modified: ${item.revisionDate}`);
  return lines.join("\n");
}

/** Format a full item including sensitive fields. */
function formatItemFull(item: VaultItem): string {
  const lines: string[] = [
    `**${item.name}** (${CipherType[item.type] ?? "Unknown"})`,
    `ID: ${item.id}`,
  ];
  if (item.login) {
    if (item.login.username) lines.push(`Username: ${item.login.username}`);
    if (item.login.password) lines.push(`Password: ${item.login.password}`);
    if (item.login.totp) lines.push(`TOTP seed: ${item.login.totp}`);
    if (item.login.uris?.length) {
      lines.push(`URIs: ${item.login.uris.map((u) => u.uri).join(", ")}`);
    }
  }
  if (item.card) {
    lines.push(`Cardholder: ${item.card.cardholderName ?? "N/A"}`);
    lines.push(`Number: ${item.card.number ?? "N/A"}`);
    lines.push(`Exp: ${item.card.expMonth}/${item.card.expYear}`);
    lines.push(`CVV: ${item.card.code ?? "N/A"}`);
  }
  if (item.identity) {
    const { firstName, lastName, email, phone } = item.identity;
    lines.push(`Name: ${firstName ?? ""} ${lastName ?? ""}`);
    if (email) lines.push(`Email: ${email}`);
    if (phone) lines.push(`Phone: ${phone}`);
  }
  if (item.fields?.length) {
    lines.push("Custom fields:");
    for (const f of item.fields) {
      lines.push(`  ${f.name}: ${f.value}`);
    }
  }
  if (item.notes) lines.push(`Notes: ${item.notes}`);
  if (item.folderId) lines.push(`Folder: ${item.folderId}`);
  lines.push(`Favorite: ${item.favorite ? "Yes" : "No"}`);
  lines.push(`Created: ${item.creationDate}`);
  lines.push(`Modified: ${item.revisionDate}`);
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
  "Get the current Bitwarden CLI status (server URL, user, lock state)",
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
  "Authenticate and unlock the Bitwarden vault. Uses configured env credentials.",
  {},
  async () => {
    try {
      await ensureAuthenticated();
      return {
        content: [{ type: "text", text: "Vault unlocked and synced successfully." }],
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
  "Search vault items by keyword. Returns summaries (no passwords).",
  {
    query: z.string().describe("Search keyword to filter vault items"),
    folderId: z.string().optional().describe("Optional folder ID to narrow search"),
  },
  async ({ query, folderId }) => {
    await ensureAuthenticated();
    const items = await client.listItems(query, folderId);
    if (items.length === 0) {
      return { content: [{ type: "text", text: `No items found for "${query}".` }] };
    }
    const text = items.map(formatItemSummary).join("\n\n---\n\n");
    return {
      content: [
        { type: "text", text: `Found ${items.length} item(s):\n\n${text}` },
      ],
    };
  }
);

// 4. vault_get_item
srv.tool(
  "vault_get_item",
  "Get full details of a vault item by ID, including all sensitive fields.",
  {
    id: z.string().describe("The vault item ID"),
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
  "Retrieve just the password for a vault item by ID.",
  {
    id: z.string().describe("The vault item ID"),
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
  "Generate a current TOTP code for a vault item.",
  {
    id: z.string().describe("The vault item ID (must have TOTP configured)"),
  },
  async ({ id }) => {
    await ensureAuthenticated();
    try {
      const code = await client.getTotp(id);
      return {
        content: [{ type: "text", text: `TOTP code: ${code}` }],
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
  "Create a new login item in the vault.",
  {
    name: z.string().describe("Name / title for the item"),
    username: z.string().optional().describe("Login username"),
    password: z.string().optional().describe("Login password (omit to auto-generate)"),
    uri: z.string().optional().describe("Website URL"),
    notes: z.string().optional().describe("Free-text notes"),
    folderId: z.string().optional().describe("Folder ID to place the item in"),
    generatePassword: z.boolean().optional().describe("Auto-generate a strong password if none provided"),
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
          text: `Created item "${created.name}" (ID: ${created.id})${finalPassword && !password ? `\nGenerated password: ${finalPassword}` : ""}`,
        },
      ],
    };
  }
);

// 8. vault_edit_item
srv.tool(
  "vault_edit_item",
  "Edit an existing vault item. Fetches current data, merges changes, and saves.",
  {
    id: z.string().describe("The vault item ID to edit"),
    name: z.string().optional().describe("New name"),
    username: z.string().optional().describe("New username"),
    password: z.string().optional().describe("New password"),
    uri: z.string().optional().describe("New URI"),
    notes: z.string().optional().describe("New notes"),
    folderId: z.string().optional().describe("Move to folder ID"),
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
      content: [{ type: "text", text: `Updated item "${result.name}" (ID: ${result.id}).` }],
    };
  }
);

// 9. vault_delete_item
srv.tool(
  "vault_delete_item",
  "Delete (trash) a vault item by ID. This is a soft delete.",
  {
    id: z.string().describe("The vault item ID to delete"),
    confirm: z
      .boolean()
      .describe("Must be true to confirm deletion"),
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
      content: [{ type: "text", text: `Item ${id} moved to trash.` }],
    };
  }
);

// 10. vault_list_folders
srv.tool(
  "vault_list_folders",
  "List all folders in the vault.",
  {},
  async () => {
    await ensureAuthenticated();
    const folders = await client.listFolders();
    if (folders.length === 0) {
      return { content: [{ type: "text", text: "No folders found." }] };
    }
    const text = folders.map((f) => `• ${f.name} (${f.id})`).join("\n");
    return {
      content: [{ type: "text", text: `Folders:\n${text}` }],
    };
  }
);

// 11. vault_create_folder
srv.tool(
  "vault_create_folder",
  "Create a new folder in the vault.",
  {
    name: z.string().describe("Folder name"),
  },
  async ({ name }) => {
    await ensureAuthenticated();
    const folder = await client.createFolder(name);
    return {
      content: [{ type: "text", text: `Created folder "${folder.name}" (ID: ${folder.id}).` }],
    };
  }
);

// 12. vault_generate_password
srv.tool(
  "vault_generate_password",
  "Generate a random password or passphrase using the Bitwarden generator.",
  {
    length: z.number().optional().describe("Password length (default 16)"),
    uppercase: z.boolean().optional().describe("Include uppercase (default true)"),
    lowercase: z.boolean().optional().describe("Include lowercase (default true)"),
    numbers: z.boolean().optional().describe("Include numbers (default true)"),
    special: z.boolean().optional().describe("Include special characters (default true)"),
    passphrase: z.boolean().optional().describe("Generate a passphrase instead"),
    words: z.number().optional().describe("Number of words for passphrase (default 3)"),
    separator: z.string().optional().describe("Word separator for passphrase (default '-')"),
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
  "Force a sync of the local vault cache with the Vaultwarden server.",
  {},
  async () => {
    await ensureAuthenticated();
    await client.sync();
    return {
      content: [{ type: "text", text: "Vault synced successfully." }],
    };
  }
);

// 14. vault_lock
srv.tool(
  "vault_lock",
  "Lock the vault. Session key is cleared; unlock required to continue.",
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
