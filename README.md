# rac

RAC keeps `.rac/` as the source of truth for agent, skill, MCP, rule, and vendor-wide config definitions, then generates Claude, Codex, and OpenCode config surfaces from that source.

Use it to:

- Install project-local config from a repository's `.rac/`.
- Install user/global config from `~/.rac/`.
- Share reusable config packs across repositories.
- Generate vendor-native outputs while keeping ownership tracked in RAC install manifests.

## Requirements

- Node.js `>=20`
- `npm`

## Project Quick Start

Project scope reads `<cwd>/.rac/` and writes project-local vendor outputs.

```bash
# Scaffold .rac/ in the current project
npx github:raniejade/rac init

# Validate source definitions
npx github:raniejade/rac doctor

# Preview generated project outputs
npx github:raniejade/rac install --dry-run

# Apply generated project outputs
npx github:raniejade/rac install
```

## User Quick Start

User scope reads `~/.rac/` and writes global/home config surfaces.

```bash
# Scaffold ~/.rac/
npx github:raniejade/rac init --scope user

# Validate ~/.rac/
npx github:raniejade/rac doctor --scope user

# Preview global outputs
npx github:raniejade/rac install --scope user --dry-run

# Apply global outputs
npx github:raniejade/rac install --scope user
```

For dotfiles, manage the `.rac` tree directly in your dotfiles repo and deploy or symlink it to `~/.rac`. `RAC_HOME` is for relocation/testing because it changes the user-scope source home and the Claude/Codex target home; OpenCode user outputs still follow `XDG_CONFIG_HOME`.

## Shared Packs

Project `.rac/config.toml` can reference shared packs:

```bash
npx github:raniejade/rac pack add platform-rules github:owner/repo --ref main
npx github:raniejade/rac pack list
npx github:raniejade/rac install --refresh-packs --dry-run
```

Pack commands edit the current project's `.rac/config.toml`.

## Docs

- [Install Scopes](docs/install-scopes.md): project scope, user scope, dotfiles workflow, and output paths.
- [Configuration](docs/configuration.md): `.rac/` layout, definition schemas, commands, merge behavior, shared packs, target outputs, and troubleshooting.
- [Architecture](docs/architecture.md): internal pipeline and ownership boundaries.

## Verification

```bash
docker build -f docker/smoke.Dockerfile --target smoke-test -t rac-smoke-test .
```
