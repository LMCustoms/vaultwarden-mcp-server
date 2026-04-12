/**
 * Bitwarden CLI wrapper for Vaultwarden MCP Server.
 *
 * Handles authentication, session management, and all vault operations
 * by shelling out to the `bw` CLI. All crypto is handled by the CLI itself.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Bitwarden cipher types
export enum CipherType {
  Login = 1,
  SecureNote = 2,
  Card = 3,
  Identity = 4,
}

export interface VaultLogin {
  uris?: Array<{ uri: string; match: number | null }>;
  username: string | null;
  password: string | null;
  totp: string | null;
}

export interface VaultCard {
  cardholderName: string | null;
  brand: string | null;
  number: string | null;
  expMonth: string | null;
  expYear: string | null;
  code: string | null;
}

export interface VaultIdentity {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  [key: string]: string | null | undefined;
}

export interface VaultItem {
  id: string;
  organizationId: string | null;
  folderId: string | null;
  type: CipherType;
  name: string;
  notes: string | null;
  favorite: boolean;
  login?: VaultLogin;
  card?: VaultCard;
  identity?: VaultIdentity;
  fields?: Array<{
    name: string;
    value: string;
    type: number;
  }>;
  reprompt: number;
  revisionDate: string;
  creationDate: string;
  deletedDate: string | null;
}

export interface VaultFolder {
  id: string;
  name: string;
}

export interface BWStatus {
  serverUrl: string | null;
  lastSync: string | null;
  userEmail: string | null;
  userId: string | null;
  status: "unauthenticated" | "locked" | "unlocked";
}

export class BWClient {
  private sessionKey: string | null = null;
  private serverUrl: string;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  /**
   * Execute a `bw` CLI command with optional session key.
   */
  private async exec(
    args: string[],
    options?: { noSession?: boolean; input?: string }
  ): Promise<string> {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      BW_NOINTERACTION: "true",
      BITWARDENCLI_APPDATA_DIR:
        process.env["BITWARDENCLI_APPDATA_DIR"] ??
        `${process.env["HOME"] ?? "/tmp"}/.bw-mcp`,
    };

    if (this.sessionKey && !options?.noSession) {
      env["BW_SESSION"] = this.sessionKey;
    }

    try {
      const { stdout } = await execFileAsync("bw", args, {
        env,
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024, // 10MB for large vaults
      });
      return stdout.trim();
    } catch (error: unknown) {
      const err = error as { stderr?: string; message?: string };
      const msg = err.stderr ?? err.message ?? "Unknown bw CLI error";
      throw new Error(`bw CLI error: ${msg}`);
    }
  }

  /**
   * Check if the `bw` CLI is installed.
   */
  async checkInstalled(): Promise<boolean> {
    try {
      await this.exec(["--version"], { noSession: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the current status of the Bitwarden CLI session.
   */
  async getStatus(): Promise<BWStatus> {
    const raw = await this.exec(["status"], { noSession: true });
    return JSON.parse(raw) as BWStatus;
  }

  /**
   * Configure the server URL for self-hosted Vaultwarden.
   */
  async configure(): Promise<void> {
    await this.exec(["config", "server", this.serverUrl], {
      noSession: true,
    });
  }

  /**
   * Log in with email + password and unlock the vault.
   * Returns the session key.
   */
  async login(email: string, password: string): Promise<string> {
    const status = await this.getStatus();

    if (status.status === "unlocked") {
      // Already unlocked — no need to sync, vault is ready
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

    // Unauthenticated — configure server URL, then full login
    await this.configure();
    try {
      const raw = await this.exec(
        ["login", email, password, "--raw"],
        { noSession: true }
      );
      this.sessionKey = raw;
    } catch (originalError) {
      // May fail if stale session exists — logout and retry
      console.error("Login failed, attempting logout and retry...");
      try { await this.logout(); } catch { /* ignore */ }
      try {
        const raw = await this.exec(
          ["login", email, password, "--raw"],
          { noSession: true }
        );
        this.sessionKey = raw;
      } catch {
        const orig = (originalError as Error).message ?? "Unknown error";
        throw new Error(`Login failed (retry after logout also failed): ${orig}`);
      }
    }

    await this.sync();
    return this.sessionKey;
  }

  /**
   * Login with API key (client_id + client_secret) then unlock with password.
   */
  async loginWithApiKey(
    clientId: string,
    clientSecret: string,
    password: string
  ): Promise<string> {
    let status = await this.getStatus();

    // Already unlocked — no need to sync, vault is ready
    if (status.status === "unlocked") {
      return this.sessionKey ?? "";
    }

    // Locked — just unlock, no need to logout or reconfigure
    if (status.status === "locked") {
      const raw = await this.exec(
        ["unlock", password, "--raw"],
        { noSession: true }
      );
      this.sessionKey = raw;
      await this.sync();
      return this.sessionKey;
    }

    // Unauthenticated — configure server URL, then login with API key
    await this.configure();
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

  /**
   * Set session key directly (e.g., from environment variable).
   */
  setSession(sessionKey: string): void {
    this.sessionKey = sessionKey;
  }

  /**
   * Sync the vault with the server.
   */
  async sync(): Promise<void> {
    await this.exec(["sync"]);
  }

  /**
   * Lock the vault.
   */
  async lock(): Promise<void> {
    await this.exec(["lock"], { noSession: true });
    this.sessionKey = null;
  }

  /**
   * Logout completely.
   */
  async logout(): Promise<void> {
    await this.exec(["logout"], { noSession: true });
    this.sessionKey = null;
  }

  /**
   * List all vault items, optionally filtered by search query.
   */
  async listItems(search?: string, folderId?: string): Promise<VaultItem[]> {
    const args = ["list", "items"];
    if (search) {
      args.push("--search", search);
    }
    if (folderId) {
      args.push("--folderid", folderId);
    }
    const raw = await this.exec(args);
    return JSON.parse(raw) as VaultItem[];
  }

  /**
   * Get a single vault item by ID.
   */
  async getItem(id: string): Promise<VaultItem> {
    const raw = await this.exec(["get", "item", id]);
    return JSON.parse(raw) as VaultItem;
  }

  /**
   * Get a TOTP code for a vault item.
   */
  async getTotp(id: string): Promise<string> {
    return this.exec(["get", "totp", id]);
  }

  /**
   * Get a specific field from a vault item.
   */
  async getPassword(id: string): Promise<string> {
    return this.exec(["get", "password", id]);
  }

  async getUsername(id: string): Promise<string> {
    return this.exec(["get", "username", id]);
  }

  async getUri(id: string): Promise<string> {
    return this.exec(["get", "uri", id]);
  }

  /**
   * List all folders.
   */
  async listFolders(): Promise<VaultFolder[]> {
    const raw = await this.exec(["list", "folders"]);
    return JSON.parse(raw) as VaultFolder[];
  }

  /**
   * Create a new login item.
   */
  async createItem(item: {
    name: string;
    username?: string;
    password?: string;
    uri?: string;
    notes?: string;
    folderId?: string;
  }): Promise<VaultItem> {
    const template: Record<string, unknown> = {
      organizationId: null,
      collectionIds: null,
      folderId: item.folderId ?? null,
      type: CipherType.Login,
      name: item.name,
      notes: item.notes ?? null,
      favorite: false,
      fields: [],
      login: {
        uris: item.uri
          ? [{ match: null, uri: item.uri }]
          : [],
        username: item.username ?? null,
        password: item.password ?? null,
        totp: null,
      },
      reprompt: 0,
    };

    const encoded = Buffer.from(JSON.stringify(template)).toString("base64");
    const raw = await this.exec(["create", "item", encoded]);
    return JSON.parse(raw) as VaultItem;
  }

  /**
   * Edit an existing item (full replacement).
   */
  async editItem(id: string, item: Record<string, unknown>): Promise<VaultItem> {
    const encoded = Buffer.from(JSON.stringify(item)).toString("base64");
    const raw = await this.exec(["edit", "item", id, encoded]);
    return JSON.parse(raw) as VaultItem;
  }

  /**
   * Delete a vault item (soft delete / trash).
   */
  async deleteItem(id: string): Promise<void> {
    await this.exec(["delete", "item", id]);
  }

  /**
   * Create a folder.
   */
  async createFolder(name: string): Promise<VaultFolder> {
    const encoded = Buffer.from(JSON.stringify({ name })).toString("base64");
    const raw = await this.exec(["create", "folder", encoded]);
    return JSON.parse(raw) as VaultFolder;
  }

  /**
   * Generate a random password.
   */
  async generatePassword(options?: {
    length?: number;
    uppercase?: boolean;
    lowercase?: boolean;
    number?: boolean;
    special?: boolean;
    passphrase?: boolean;
    words?: number;
    separator?: string;
  }): Promise<string> {
    const args = ["generate"];
    if (options?.length) args.push("--length", String(options.length));
    if (options?.uppercase) args.push("--uppercase");
    if (options?.lowercase) args.push("--lowercase");
    if (options?.number) args.push("--number");
    if (options?.special) args.push("--special");
    if (options?.passphrase) {
      args.push("--passphrase");
      if (options?.words) args.push("--words", String(options.words));
      if (options?.separator) args.push("--separator", options.separator);
    }
    return this.exec(args);
  }
}
