# Watchtower Auto-Deployment Design

**Date:** 2026-04-12
**Scope:** Server-wide auto-deployment via Watchtower across LMCustoms infrastructure, starting with Schrombus and extending to SOLCloud.

## Problem

Deploying updates to Schrombus is manual: SSH in, `git pull`, `docker compose up --build`. Services fall behind — vaultwarden-mcp-server was 4 commits behind main at time of writing. Third-party images (Grafana, Vaultwarden, etc.) also go stale without manual intervention.

## Solution Overview

Watchtower monitors all containers on a host, automatically pulling new images from registries and restarting containers. Custom LMCustoms services publish Docker images to GHCR on every release. A webhook from GitHub Actions triggers Watchtower for immediate deploys of our own services; third-party images are picked up via regular polling.

### End-to-End Flow

```
Developer merges PR to main
  -> semantic-release: creates vX.Y.Z tag + GitHub Release
  -> build-push.yml: builds + pushes ghcr.io/lmcustoms/<service>:latest
  -> notify-registry.yml: POST /webhook/release {version}
  -> notify-watchtower (SSH + curl): triggers immediate Watchtower check
  -> Watchtower: pulls new image, restarts container
  -> Watchtower: sends email notification to anian@lmcustoms.cc
  -> Watchtower: POST /webhook/deployment to project-registry
  -> project-registry: deployed_version updated
```

Third-party images (grafana, vaultwarden, postgres, etc.) skip the GitHub steps — Watchtower picks them up via 5-minute polling.

## Component 1: Watchtower Repository

**Repo:** `LMCustoms/watchtower`

A standalone repo containing Docker Compose configuration, deployable to any server by cloning and running `docker compose up -d`.

### Repo Structure

```
watchtower/
  docker-compose.yml
  .env.example
  README.md
```

### Container Configuration

- **Image:** `containrrr/watchtower`
- **Docker socket:** `/var/run/docker.sock` mounted read-only
- **Network:** `proxy-manager_default` (for internal HTTP API access from other containers)
- **No Traefik labels** — not publicly exposed
- **Restart policy:** `unless-stopped`

### Environment Variables (.env)

| Variable | Description | Default |
|----------|-------------|---------|
| `WATCHTOWER_POLL_INTERVAL` | Seconds between registry polls | `300` |
| `WATCHTOWER_HTTP_API_TOKEN` | Bearer token for HTTP API trigger | (required) |
| `WATCHTOWER_HTTP_API_UPDATE` | Enable HTTP API for manual triggers | `true` |
| `WATCHTOWER_CLEANUP` | Remove old images after update | `true` |
| `WATCHTOWER_NOTIFICATION_EMAIL` | Enable email notifications | `true` |
| `WATCHTOWER_NOTIFICATION_EMAIL_FROM` | Sender address | `github@lmcustoms.cc` |
| `WATCHTOWER_NOTIFICATION_EMAIL_TO` | Recipient address | `anian@lmcustoms.cc` |
| `WATCHTOWER_NOTIFICATION_EMAIL_SERVER` | SMTP server host | (Stalwart on SOLCloud) |
| `WATCHTOWER_NOTIFICATION_EMAIL_SERVER_PORT` | SMTP port | `587` |
| `WATCHTOWER_NOTIFICATION_EMAIL_SERVER_USER` | SMTP username | `github@lmcustoms.cc` |
| `WATCHTOWER_NOTIFICATION_EMAIL_SERVER_PASSWORD` | SMTP password | (required) |
| `WATCHTOWER_NOTIFICATION_URL` | Shoutrrr generic webhook URL for project-registry (format: `generic+https://host/webhook/deployment`) | (optional) |

### Behavior

- Watches **all containers** on the host by default
- Containers using pinned version tags (e.g., `prometheus:v2.54.0`) won't be updated unless the digest for that exact tag changes — this is the correct behavior for infrastructure you upgrade deliberately
- Containers using `:latest` (most LMCustoms services, third-party tools) are updated automatically
- HTTP API listens on port 8080 internally for webhook-triggered immediate checks

## Component 2: GHCR Build-Push Pipeline

**Applies to:** `vaultwarden-mcp-server`, `wrapped`

### Shared Workflow

Uses the existing `LMCustoms/.github/.github/workflows/docker-build-push.yml` reusable workflow. The exact tagging behavior (`:latest` + `:vX.Y.Z`) must be verified during implementation — if the shared workflow doesn't support dual tagging, it will need to be extended.

### Per-Repo Changes

Each repo gets a `.github/workflows/build-push.yml`:

```yaml
name: Build & Push Docker Image
on:
  release:
    types: [published]
jobs:
  build-push:
    uses: LMCustoms/.github/.github/workflows/docker-build-push.yml@main
    secrets: inherit
```

### Image Tagging

- Pushes both `:latest` and `:vX.Y.Z` (semver from release tag)
- Watchtower watches `:latest` for auto-updates
- Pinned tags available for manual rollback

### Schrombus Compose Changes

Update compose files to pull from GHCR instead of building locally:

**vaultwarden-mcp-server** (`/home/cobra/vaultwarden-mcp-server/docker-compose.yml`):
- Replace `build: .` with `image: ghcr.io/lmcustoms/vaultwarden-mcp-server:latest`
- Source checkout on server no longer needed for builds (keep for compose + .env)

**wrapped** (`/home/cobra/webmail/docker-compose.yml`):
- Replace `image: wrapped:latest` with `image: ghcr.io/lmcustoms/wrapped:latest`

### Registry Configurability

Each service's compose file on the server uses an environment variable for the image name (e.g., `IMAGE_REGISTRY=ghcr.io/lmcustoms` in `.env`), and the compose file references `${IMAGE_REGISTRY}/vaultwarden-mcp-server:latest`. Switching registries requires changing one `.env` variable, not editing compose files or workflows.

## Component 3: Watchtower Webhook Trigger

### Trigger Mechanism

On every GitHub release, after the image is pushed to GHCR, GitHub Actions triggers Watchtower to immediately check for updates. This uses the existing SSH deploy key pattern (from `deploy-ssh.yml` in LMCustoms/.github).

### Implementation

Add a shared workflow `LMCustoms/.github/.github/workflows/notify-watchtower.yml` that:
1. SSHes into the target server
2. Curls Watchtower's HTTP API on localhost: `curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/v1/update`

Each repo adds a workflow trigger:

```yaml
name: Notify Watchtower
on:
  release:
    types: [published]
jobs:
  notify:
    uses: LMCustoms/.github/.github/workflows/notify-watchtower.yml@main
    secrets: inherit
```

### Why SSH + curl (not public API)

- No extra public attack surface
- Reuses existing SSH deploy key infrastructure
- Watchtower HTTP API stays internal-only
- No Traefik configuration needed for Watchtower

## Component 4: Project-Registry Integration

### New Endpoint

`POST /webhook/deployment` — called after a successful container update.

Watchtower uses Shoutrrr for notifications, which sends its own payload format. The project-registry endpoint must either:
- Accept Shoutrrr's generic webhook payload and extract the relevant fields, or
- Use n8n as an intermediary to transform the payload before forwarding

**Recommended:** Accept Shoutrrr's payload directly and parse it. Simpler, fewer moving parts.

### Payload (normalized)

```json
{
  "container": "vaultwarden-mcp-server",
  "image": "ghcr.io/lmcustoms/vaultwarden-mcp-server:latest",
  "new_digest": "sha256:abc123..."
}
```

### New Database Fields

Add to the `projects` table:

| Column | Type | Description |
|--------|------|-------------|
| `container_image` | TEXT | Registry image path, e.g., `ghcr.io/lmcustoms/vaultwarden-mcp-server` |
| `deployed_version` | TEXT | Currently running version |
| `last_deploy_at` | TIMESTAMPTZ | When Watchtower last deployed |

### Seed Data Extension

`projects.yaml` gets a `container_image` field per project to map containers to registry images.

### Version Tracking

- `version` = latest released version (set by `/webhook/release`)
- `deployed_version` = what's actually running (set by `/webhook/deployment`)
- If they differ, a deploy is pending or failed

## Component 5: Email Notifications

Watchtower sends email notifications on every container update via Stalwart SMTP on SOLCloud.

- **From:** `github@lmcustoms.cc`
- **To:** `anian@lmcustoms.cc`
- **Content:** Container name, old image digest, new image digest, update timestamp

## Affected Repos and Services

### Repos Requiring Changes

| Repo | Changes |
|------|---------|
| `LMCustoms/watchtower` (new) | Docker Compose, .env.example, README |
| `LMCustoms/.github` | Add `notify-watchtower.yml` shared workflow |
| `LMCustoms/vaultwarden-mcp-server` | Add `build-push.yml`, fix `release.yml` permissions |
| `LMCustoms/wrapped` | Add `build-push.yml`, fix `release.yml` permissions if needed |
| `LMCustoms/project-registry` | New `/webhook/deployment` endpoint, new DB fields, seed data |

### Schrombus Server Changes

| Path | Change |
|------|--------|
| `/home/cobra/vaultwarden-mcp-server/docker-compose.yml` | `build: .` -> `image: ghcr.io/...` |
| `/home/cobra/webmail/docker-compose.yml` | `image: wrapped:latest` -> `image: ghcr.io/...` |
| `/home/cobra/watchtower/` (new) | Clone watchtower repo, configure .env, `docker compose up -d` |

### Containers on Schrombus (25 total)

**Auto-updated via Watchtower polling (third-party, `:latest`):**
vaultwarden, code-server, it-tools, pgadmin, minio, kes, n8n, n8n-workers, redis, docker-tcp-proxy

**Auto-updated via Watchtower + GHCR pipeline (LMCustoms):**
vaultwarden-mcp-server, wrapped, lmcustoms-landing, sk8spots-app, portfolio, project-registry, chef-api

**Not auto-updated (pinned versions, deliberate upgrades):**
traefik (v3.3), postgres (17), prometheus (v2.54.0), grafana (11.1.0), loki (3.1.0), node-exporter (v1.8.2), alertmanager (v0.27.0)

## Future: SOLCloud

The `LMCustoms/watchtower` repo is designed for reuse. Deploying to SOLCloud:
1. Clone the repo
2. Configure `.env` with SOLCloud-specific values (same SMTP, different API token)
3. `docker compose up -d`

No code changes needed — just environment configuration.
