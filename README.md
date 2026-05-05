# airc

Install `.airc` agent/skill/MCP definitions into Claude, Codex, and OpenCode config surfaces.

## Purpose

`airc` manages one source tree (`.airc/`) and installs generated target config files for:

- Claude
- Codex
- OpenCode

It tracks managed outputs in per-target install manifests so later installs can update or clean stale managed files safely.

## Prerequisites

- Node.js `>=20`
- `npm`
- A project root containing `.airc/`

## Quick Start

```bash
# 1) Initialize source definitions in project scope
npx github:raniejade/airc init

# 2) Validate definitions
npx github:raniejade/airc doctor

# 3) Preview generated changes
npx github:raniejade/airc install --dry-run

# 4) Apply
npx github:raniejade/airc install
```

## Source Layout (`.airc/`)

```text
.airc/
  agents/
    <id>.toml
  skills/
    <id>/
      SKILL.md
      ...asset files...
  mcps/
    <id>.toml
```

Definition rules:

- Agents: one file per agent in `.airc/agents/*.toml`.
- Skills: each skill must be in `.airc/skills/<id>/SKILL.md`.
- Skill frontmatter must start at byte 0 with `+++` and end with `+++`.
- MCPs: one file per server in `.airc/mcps/*.toml`.
- MCP transport must be exactly one of:
  - local: `command` (+ optional `args`)
  - remote: `type` + `url`

Vendor overrides:

- `vendor.<target>.config` pass-through for `agent`, `skill`, and `mcp` target payloads.
- `vendor.<target>.frontmatter` for skill markdown frontmatter (`claude`, `codex`, `opencode`).
- Skills merge order is generated base -> `vendor.<target>.config` -> `vendor.<target>.frontmatter`.
- Generated-key collisions fail fast (for example `name`, `description`).
- Skill installs fail fast when `vendor.<target>.config` and `vendor.<target>.frontmatter` share keys.
- Agents fail fast when `vendor.codex.emit = "instruction-only"` is combined with `vendor.codex.config`.
- Codex TOML pass-through values must be strings, numbers, booleans, or arrays; nested objects are rejected.

### Definition File Examples

Agent definition (`.airc/agents/<id>.toml`):

```toml
id = "reviewer"
name = "Reviewer"
description = "Review pull requests"
instructions = "Review changes and report risks first."
tools = ["git", "rg"]

[vendor.codex]
emit = "instruction-only"

[vendor.claude.config]
model = "sonnet"
```

- `instructions` can be inline text or a relative file path like `./instructions/reviewer.md`.
- If `vendor.codex.emit = "instruction-only"`, do not set `vendor.codex.config` for that agent.

Skill definition (`.airc/skills/<id>/SKILL.md`):

```markdown
+++
name = "release-check"
description = "Run release checks"
assets = ["assets/checklist.md"]

[vendor.codex.config]
tags = ["release"]

[vendor.codex.frontmatter]
audience = "maintainers"
+++

Run the release checklist and report blocking issues.
```

- Frontmatter is TOML between the opening/closing `+++` delimiters, then the skill body.
- Assets are resolved relative to the skill directory and copied with the installed skill.
- Use `vendor.<target>.config` and `vendor.<target>.frontmatter` for target-specific skill frontmatter overlays; avoid duplicate keys across those two maps for the same target.

MCP definition (`.airc/mcps/<id>.toml`):

```toml
id = "local-debug"
command = "node"
args = ["./tools/mcp.js"]
startup_timeout_ms = 15000

[vendor.codex.config]
env = ["DEBUG=1"]
```

```toml
id = "remote-search"
type = "streamable-http"
url = "https://example.com/mcp"

[vendor.claude.config]
headers = { Authorization = "Bearer ${MCP_TOKEN}" }
```

- Local transport uses `command` (+ optional `args`); remote transport uses `type` + `url`.
- Set one transport mode only.
- `startup_timeout_ms` is supported in source and is emitted for Codex as `startup_timeout_sec`.
- Use `vendor.<target>.config` for target-specific MCP fields.
- Avoid nested object values in `vendor.codex.config`; Codex TOML output supports scalar and array pass-through values.

## Command Reference

Use `npx github:raniejade/airc ...` to run from GitHub, or replace it with `airc ...` when the binary is installed locally or globally.

### `init`

Create `.airc` folders and optional starter examples.

```bash
airc init [--empty]
```

- `--empty`: only create folders, skip starter sample files

### `doctor`

Validate definitions and print warnings.

```bash
airc doctor [--target claude,codex,opencode] [--kind agent,skill,mcp]
```

- Prints `ok` when no warnings are found.
- Warns for missing MCP env vars.
- Warns for Codex instruction-only emit when `--target` includes `codex` and `--kind` includes `agent`.
- Warns for legacy OpenCode vendor tools when `--target` includes `opencode` and `--kind` includes `agent`.

### `install`

Generate and install selected definitions.

```bash
airc install [--target claude,codex,opencode] [--kind agent,skill,mcp] [--dry-run] [--clean] [--check] [--force]
```

- `--dry-run`: previews planned create/update paths and performs no writes.
- `--clean`: deletes stale managed files for selected target+kind.
- `--check`: verifies generated outputs/manifests are up to date without writing or deleting.
- `--force`: allows overwrite of unmanaged files.

Defaults: omitting `--target` applies all targets; omitting `--kind` applies all kinds.

Without `--force`, overwrite rules are:

- allowed: manifest-owned files
- allowed: text files containing AIRC managed/frontmatter-sensitive markers
- blocked: unmanaged JSON files
- blocked: other unmanaged files without markers

## Target Outputs and Install Manifests

Install manifests are used to track managed files and cleanup behavior.

### Claude

- Agents: `.claude/agents/<id>.md`
- Skills: `.claude/skills/<id>/SKILL.md` + skill assets
- MCP:
  - `.mcp.json`
- Install manifest: `.claude/.airc-install-manifest.json`

### Codex

- Agents:
  - default: `.codex/agents/<id>.toml`
  - if `vendor.codex.emit = "instruction-only"`: `.codex/agents/<id>.md`
- Skills: `.agents/skills/<id>/SKILL.md` + skill assets
- MCP: `.codex/config.toml`
- Install manifests:
  - agents + mcps: `.codex/.airc-install-manifest.json`
  - skills: `.agents/.airc-install-manifest.json`

### OpenCode

- Agents: `.opencode/agents/<id>.md`
- Skills: `.opencode/skills/<id>/SKILL.md` + skill assets
- MCP: `.opencode/opencode.json`
- Install manifest: `.opencode/.airc-install-manifest.json`

## Safe Install Workflow

Use this sequence when enabling or changing definitions:

```bash
# Validate first
airc doctor

# Preview planned create/update changes (no writes)
airc install --dry-run

# Apply selected targets/kinds if needed
airc install --target codex --kind agent,skill,mcp

# Optional: run stale managed-output cleanup after reviewing current definitions/managed outputs
airc install --clean
```

Guidelines:

- Use `--target` and `--kind` during incremental rollout.
- If omitted, `--target` and `--kind` apply all targets/kinds.
- Use `--clean` only after reviewing current definitions and managed outputs.
- Use `--force` only when you intentionally want to replace unmanaged files.

## Troubleshooting

- `invalid target/kind`
  - Use supported values only:
    - target: `claude`, `codex`, `opencode`
    - kind: `agent`, `skill`, `mcp`

- `refusing to overwrite existing init examples`
  - `init` found starter files already present. Remove/rename them or run with `--empty` if you only need folders.

- `duplicate agent id`, `duplicate skill id`, `duplicate mcp id`
  - Ensure each ID is unique in `.airc` sources.

- `skill frontmatter must start with +++ at byte 0` or `missing closing +++ delimiter`
  - Fix `SKILL.md` TOML frontmatter delimiters and placement.

- `mcp requires local command OR remote type+url` / `mcp cannot define both local and remote transport`
  - Fix MCP transport fields so only one transport mode is defined.

- `missing env var: ...`
  - Set required environment variables before running downstream tools.

- `refusing overwrite unmanaged file: <path>`
  - File exists and is not managed by `airc` manifest markers.
  - Either migrate/delete it manually, or rerun with `--force` if replacement is intentional.
