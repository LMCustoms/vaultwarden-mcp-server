# Vaultwarden MCP Server

MCP (Model Context Protocol) server for managing a self-hosted [Vaultwarden](https://github.com/dani-garcia/vaultwarden) / Bitwarden vault. Wraps the official [Bitwarden CLI](https://bitwarden.com/help/cli/) so all encryption is handled natively.

## Prerequisites

- **Node.js** >= 18
- **Bitwarden CLI** (`bw`) installed and in PATH
  ```bash
  npm install -g @bitwarden/cli
  ```

## Setup

```bash
git clone https://github.com/LMCustoms/vaultwarden-mcp-server.git
cd vaultwarden-mcp-server
npm install
npm run build
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BW_SERVER_URL` | Yes | Your Vaultwarden URL (e.g. `https://vault.lmcustoms.cc`) |
| `BW_EMAIL` | * | Vault account email |
| `BW_PASSWORD` | * | Master password |
| `BW_SESSION` | * | Pre-existing session key (skip login) |
| `BW_CLIENT_ID` | * | API key client ID (alternative login) |
| `BW_CLIENT_SECRET` | * | API key client secret |

\* Provide **one** of: `BW_SESSION`, `BW_EMAIL` + `BW_PASSWORD`, or `BW_CLIENT_ID` + `BW_CLIENT_SECRET` + `BW_PASSWORD`.

## MCP Client Configuration

Add to your MCP client config (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "vaultwarden": {
      "command": "node",
      "args": ["/path/to/vaultwarden-mcp-server/dist/index.js"],
      "env": {
        "BW_SERVER_URL": "https://vault.lmcustoms.cc",
        "BW_EMAIL": "your@email.com",
        "BW_PASSWORD": "your-master-password"
      }
    }
  }
}
```

## Available Tools

| Tool | Description |
|---|---|
| `vault_status` | Check CLI status, server URL, lock state |
| `vault_login` | Authenticate and unlock the vault |
| `vault_search` | Search items by keyword (returns summaries, no passwords) |
| `vault_get_item` | Get full item details including all sensitive fields |
| `vault_get_password` | Retrieve just the password for an item |
| `vault_get_totp` | Generate a current TOTP code |
| `vault_create_item` | Create a new login item (with optional password generation) |
| `vault_edit_item` | Edit an existing item (merge changes) |
| `vault_delete_item` | Soft-delete (trash) an item |
| `vault_list_folders` | List all vault folders |
| `vault_create_folder` | Create a new folder |
| `vault_generate_password` | Generate a random password or passphrase |
| `vault_sync` | Force sync with the server |
| `vault_lock` | Lock the vault |

## Development

```bash
npm run dev    # Watch mode with tsx
npm run build  # Compile TypeScript
npm start      # Run compiled server
```

## License

MIT
