# rac

Centralize agent/skill/MCP/rule definitions in `.rac` as the source of truth, then generate and sync Claude, Codex, and OpenCode config surfaces.

## Purpose

`rac` manages one source tree (`.rac/`) and generates/syncs target config files for:

- Claude
- Codex
- OpenCode

It tracks managed outputs in per-target install manifests so later installs can update or clean stale managed files safely.

## Prerequisites

- Node.js `>=20`
- `npm`
- A project root containing `.rac/`

## Quick Start

```bash
# 1) Initialize source definitions in project scope
npx github:raniejade/rac init

# 2) Validate definitions
npx github:raniejade/rac doctor

# 3) Add a shared pack
npx github:raniejade/rac pack add platform-rules github:owner/repo --ref main

# 4) Preview generated changes
npx github:raniejade/rac install --dry-run

# 5) Apply
npx github:raniejade/rac install
```

## Source Layout (`.rac/`)

```text
.rac/
  agents/
    <id>.toml
  skills/
    <id>/
      SKILL.md
      ...asset files...
  mcps/
    <id>.toml
  rules/
    <file>.toml
  config.toml
```

Definition rules:

- `.rac/config.toml` is required.
- Project mode may define top-level `[[packs]]` entries for shared packs.
- Shared pack mode must keep `.rac/config.toml` present and must not define `[[packs]]`.

- Agents: one file per agent in `.rac/agents/*.toml`.
- Skills: each skill must be in `.rac/skills/<id>/SKILL.md`.
- Skill frontmatter must start at byte 0 with `+++` and end with `+++`.
- MCPs: one file per server in `.rac/mcps/*.toml`.
- Rules: one or more `[[rule]]` entries per file in `.rac/rules/*.toml`.
- Definition IDs (`agent.id`, skill directory name, `mcp.id`, `rule.id`) normalize to Unicode NFC.
- IDs are rejected when empty after trimming, with leading/trailing whitespace, `.`/`..`, `/` or `\`, or control characters.
- Duplicate checks compare normalized IDs.
- MCP transport must be exactly one of:
  - local: `command` (+ optional `args`)
  - remote: `type` + `url`

Vendor overrides:

- `vendor.<target>.config` pass-through for `agent`, `skill`, and `mcp` target payloads.
- `vendor.<target>.frontmatter` for skill markdown frontmatter (`claude`, `codex`, `opencode`).
- Skills merge order is generated base -> `vendor.<target>.config` -> `vendor.<target>.frontmatter`.
- Generated-key collisions fail fast (for example `name`, `description`).
- Skill installs fail fast when `vendor.<target>.config` and `vendor.<target>.frontmatter` share keys.
- Codex TOML pass-through values must be strings, numbers, booleans, or arrays; nested objects are rejected.

### Definition File Examples

Agent definition (`.rac/agents/<id>.toml`):

```toml
id = "reviewer"
name = "Reviewer"
description = "Review pull requests"
instructions = "Review changes and report risks first."
tools = ["git", "rg"]

[vendor.claude.config]
model = "sonnet"
```

- `instructions` can be inline text or a relative file path like `./instructions/reviewer.md`.
- Agent instruction templates are opt-in via file suffix: `.tpl.md` or `.tpl.txt`.
- Template example:

```markdown
{% if vendor.codex %}
Use Codex-specific execution rules.
{% elsif vendor.claude %}
Use Claude-specific execution rules.
{% else %}
Use vendor-neutral execution rules.
{% endif %}
```

Skill definition (`.rac/skills/<id>/SKILL.md`):

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

- Skills may use either `SKILL.md` or `SKILL.tpl.md` (not both in one directory).
- Template scope is limited to booleans: `vendor.claude`, `vendor.codex`, `vendor.opencode`.
- Unknown template variables/filters fail fast; includes/partials are not supported.
- `SKILL.tpl.md` can use the same conditional shape:

```markdown
{% if vendor.codex %}
Codex skill behavior.
{% elsif vendor.claude %}
Claude skill behavior.
{% else %}
Default skill behavior.
{% endif %}
```

- Frontmatter is TOML between the opening/closing `+++` delimiters, then the skill body.
- Assets are resolved relative to the skill directory and copied with the installed skill.
- Use `vendor.<target>.config` and `vendor.<target>.frontmatter` for target-specific skill frontmatter overlays; avoid duplicate keys across those two maps for the same target.

MCP definition (`.rac/mcps/<id>.toml`):

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

Project pack entry schema:

```toml
[[packs]]
id = "platform-rules"
repo = "github:owner/repo"
ref = "main"
```

- `id` must match ASCII path-safe `A-Z a-z 0-9 . _ -`.
- `repo` must use `github:owner/repo`.
- `ref` is required.
- RAC resolves shared packs with system `git` into cache (`$RAC_CACHE_DIR` or `~/.cache/rac`), then checks out `--detach <ref>`.

## Command Reference

Use `npx github:raniejade/rac ...` to run from GitHub, or replace it with `rac ...` when the binary is installed locally or globally.

### `init`

Create `.rac` folders and optional starter examples.

```bash
rac init [--empty]
```

- `--empty`: only create folders, skip starter sample files

### `doctor`

Validate definitions and print warnings.

```bash
rac doctor [--target claude,codex,opencode] [--kind agent,skill,mcp,rule]
```

- Prints `ok` when no warnings are found.
- Warns for missing MCP env vars.
- Warns for legacy OpenCode vendor tools when `--target` includes `opencode` and `--kind` includes `agent`.

### `install`

Generate and install selected definitions.

```bash
rac install [--target claude,codex,opencode] [--kind agent,skill,mcp,rule] [--dry-run] [--clean] [--check] [--force]
```

- `--dry-run`: previews planned create/update paths and performs no writes.
- `--clean`: deletes stale managed files for selected target+kind.
- `--check`: verifies generated outputs/manifests are up to date without writing or deleting.
- `--force`: allows overwrite of unmanaged files.

Defaults: omitting `--target` applies all targets; omitting `--kind` applies all kinds.

Without `--force`, overwrite rules are:

- allowed: manifest-owned files
- allowed: TOML/JSONC files with RAC managed warning at byte 0
- allowed: markdown files with YAML frontmatter at byte 0 and RAC managed marker immediately after the closing frontmatter
- blocked: unmanaged JSON files
- blocked: other unmanaged files without markers

### `pack add`

Append a top-level `[[packs]]` entry to `.rac/config.toml`.

```bash
rac pack add <id> <repo> --ref <ref>
```

- `id` must be ASCII path-safe: `A-Z a-z 0-9 . _ -` and cannot be `project`.
- `repo` must use `github:owner/repo`.
- `--ref` is required and must not contain whitespace.

### `pack list`

List configured packs in config order.

```bash
rac pack list
```

- Output format: `<id> <repo> <ref>` (one per line)
- Prints `-` when no packs are configured.

### `pack remove`

Remove a top-level `[[packs]]` entry by id.

```bash
rac pack remove <id>
```

## Target Outputs and Install Manifests

Install manifests are used to track managed files and cleanup behavior.

Manifest behavior:
- Missing manifest file is treated as empty.
- Invalid JSON, unsupported version, invalid records, or unsafe manifest record paths fail with `invalid RAC install manifest: <path>: <reason>`.
- Generated output paths and manifest record paths must resolve inside the project root before overwrite checks, writes, check comparisons, manifest save/delete, and clean deletes.
- Dynamic JSON selectors use bracket-safe JSONPath (`$["..."]["..."]`), and Codex MCP table keys use quoted TOML keys.

### Claude

- Agents: `.claude/agents/<id>.md`
- Skills: `.claude/skills/<id>/SKILL.md` + skill assets
- MCP:
  - `.mcp.json`
- Install manifest: `.claude/.rac-install-manifest.json`

### Codex

- Agents: `.codex/agents/<id>.toml`
- Skills: `.agents/skills/<id>/SKILL.md` + skill assets
- MCP: `.codex/config.toml`
- Rules: `.codex/rules/<source-file-stem>.rules`
- Codex MCP entries are emitted as quoted table keys (for example `[mcp_servers."id.with spaces"]`).
- Install manifests:
  - agents + mcps: `.codex/.rac-install-manifest.json`
  - skills: `.agents/.rac-install-manifest.json`

### OpenCode

- Agents: `.opencode/agents/<id>.md`
- Skills: `.opencode/skills/<id>/SKILL.md` + skill assets
- MCP + rules config: `.opencode/opencode.jsonc` (rules render as `permission.bash` command-pattern keys mapped to `"deny"`)
- Install manifest: `.opencode/.rac-install-manifest.json`

## Safe Install Workflow

Use this sequence when enabling or changing definitions:

```bash
# Add/update shared pack references
rac pack add platform-rules github:owner/repo --ref main

# Validate definitions
rac doctor

# Apply selected targets/kinds
rac install

# Remove a shared pack when retiring it
rac pack remove platform-rules

# Clean stale managed outputs
rac install --clean
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
    - kind: `agent`, `skill`, `mcp`, `rule`

- `refusing to overwrite existing init examples`
  - `init` found starter files already present. Remove/rename them or run with `--empty` if you only need folders.

- `duplicate agent id`, `duplicate skill id`, `duplicate mcp id`, `duplicate rule id`
  - Ensure each ID is unique in `.rac` sources.

- `skill frontmatter must start with +++ at byte 0` or `missing closing +++ delimiter`
  - Fix `SKILL.md` TOML frontmatter delimiters and placement.

- `mcp requires local command OR remote type+url` / `mcp cannot define both local and remote transport`
  - Fix MCP transport fields so only one transport mode is defined.

- `missing env var: ...`
  - Set required environment variables before running downstream tools.

- `refusing overwrite unmanaged file: <path>`
  - File exists and is not managed by `rac` manifest markers.
  - Either migrate/delete it manually, or rerun with `--force` if replacement is intentional.
