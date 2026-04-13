## 1.0.0 (2026-04-13)

### Features

* add centralized caller workflows ([f90d2ca](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/f90d2caae9705bd37ffee708f04a389f3267d031))
* add docker-compose with Traefik labels for deployment ([8782d5b](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/8782d5bcd148a28708bbc711440a203a7f70f699))
* add Dockerfile for containerized deployment ([2e3e127](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/2e3e127181d2eb6ae188b175c896852cbe9d30f5))
* add HTTP transport with bearer token auth and dual-mode support ([ce46256](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/ce462565ee68e28ba698809f1a8839b5528f62a7))
* add issue-on-failure and issue-notifications workflows ([8b11e8b](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/8b11e8bc805f827b129b70bbb5d88e56a10c6dfe))
* add registry notification on release ([68157c1](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/68157c11a44db4ebc05f4bd5fd90b2cfa1386852))

### Bug Fixes

* add extra_hosts for container-to-host Vaultwarden access ([3326256](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/3326256346bebb5ef4018e09773f1bd354924c07))
* add prebuild clean step to ensure fresh dist output ([608f11a](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/608f11af73fb16f00966b7351a271689f07887da))
* defer configure() until unauthenticated state ([48d857f](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/48d857f4fd09abb184336fb32373381c91f050cf))
* handle stale sessions and locked-state in login methods ([db5894b](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/db5894b5646c7fc2234b161f235091a313720f3d))
* improve error handling in login recovery paths ([0f1ad88](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/0f1ad885d94287833cd01f49524d20332056c4a3))
* pin bw CLI to 2025.1.0 for Vaultwarden 1.35.x compatibility ([37a9f89](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/37a9f891328f148c557f3c4a7c307a7d1b1db669))
* route vault.lmcustoms.cc to Traefik internal IP ([dff59ca](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/dff59caf41bac1246426a0b765f6bcece648c3dd))
* timing-safe auth, session cleanup, and startup warnings ([dda4f3d](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/dda4f3d411682c65de518d594a846750f561fbd5))
* use correct Traefik network name for Schrombus ([1dab358](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/1dab35830c6bc782d8c4369aaf3c932d81b487ce))

### Performance Improvements

* add auth check TTL and remove redundant sync calls ([ec2f0dd](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/ec2f0dd10796eb877235a2236b44a570ab4b492c))
* minimize MCP response token usage ([86876bb](https://github.com/LMCustoms/vaultwarden-mcp-server/commit/86876bb3c6bf65c12a2cc858a34025f08210e337))
