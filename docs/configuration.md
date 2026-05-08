# Configuration

RAC reads `.rac/` source definitions, normalizes them into a vendor-neutral model, and writes Claude, Codex, and OpenCode outputs with manifest-tracked ownership.

## Source Layout

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
- Vendor-wide target config is sourced only from `.rac/config.toml`.
- Agents: one file per agent in `.rac/agents/*.toml`.
- Skills: each skill must be in `.rac/skills/<id>/SKILL.md` or `.rac/skills/<id>/SKILL.tpl.md`.
- Skill frontmatter must start at byte 0 with `+++` and end with `+++`.
- MCPs: one file per server in `.rac/mcps/*.toml`.
- Rules: one or more `[[rule]]` entries per file in `.rac/rules/*.toml`.
- Definition IDs (`agent.id`, skill directory name, `mcp.id`, `rule.id`) normalize to Unicode NFC.
- IDs are rejected when empty after trimming, with leading/trailing whitespace, `.`/`..`, `/` or `\`, or control characters.
- Duplicate checks compare normalized IDs.
- MCP transport must be exactly one of:
  - local: `command` plus optional `args`
  - remote: `type` plus `url`

## Agents

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
- Template scope is limited to booleans: `vendor.claude`, `vendor.codex`, `vendor.opencode`.
- Unknown template variables and filters fail fast.

Template example:

```markdown
{% if vendor.codex %}
Use Codex-specific execution rules.
{% elsif vendor.claude %}
Use Claude-specific execution rules.
{% else %}
Use vendor-neutral execution rules.
{% endif %}
```

## Skills

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

- Skills may use either `SKILL.md` or `SKILL.tpl.md`, not both in one directory.
- Frontmatter is TOML between the opening and closing `+++` delimiters, then the skill body.
- Assets are resolved relative to the skill directory and copied with the installed skill.
- Use `vendor.<target>.config` and `vendor.<target>.frontmatter` for target-specific skill frontmatter overlays.
- Skills merge order is generated base -> `vendor.<target>.config` -> `vendor.<target>.frontmatter`.
- Generated-key collisions fail fast, for example `name` or `description`.
- Skill installs fail fast when `vendor.<target>.config` and `vendor.<target>.frontmatter` share keys.
- `SKILL.tpl.md` uses the same vendor template conditionals as agent instruction templates.

## MCPs

Local MCP definition (`.rac/mcps/<id>.toml`):

```toml
id = "local-debug"
command = "node"
args = ["./tools/mcp.js"]
startup_timeout_ms = 15000

[vendor.codex.config]
env = ["DEBUG=1"]
```

Remote MCP definition:

```toml
id = "remote-search"
url = "https://example.com/mcp"

[vendor.claude.config]
type = "sse"
headers = { Authorization = "Bearer ${MCP_TOKEN}" }

[vendor.codex.config]
type = "streamable-http"
```

- Local transport uses `command` plus optional `args`.
- Remote transport uses `url`.
- Set one transport mode only.
- `startup_timeout_ms` is supported in source and is emitted for Codex as `startup_timeout_sec`.
- Use `vendor.<target>.config` for target-specific MCP fields, including transport `type` values required by a vendor.
- Avoid nested object values in `vendor.codex.config`; Codex TOML output supports scalar and array pass-through values.

## Rules

Rules live in `.rac/rules/*.toml`. Each file can contain one or more `[[rule]]` entries.

```toml
[[rule]]
id = "deny-git-push"
decision = "forbidden"
justification = "Use approved wrappers for push operations."
command = ["git", "push"]

[[rule]]
id = "deny-gh-pr-merge"
decision = "forbidden"
justification = "Use approved wrappers for PR merges."
command = ["gh", "pr", ["merge", "close"]]
append_wildcard = false
```

- `decision` currently supports `forbidden`.
- `justification` is required.
- `command` is a non-empty prefix made of literal segments and optional alternatives.
- `append_wildcard` defaults to `true`.

## Vendor Overrides

- `vendor.<target>.config` passes target-specific fields through for agent, skill, and MCP target payloads.
- `vendor.<target>.frontmatter` adds skill markdown frontmatter for `claude`, `codex`, and `opencode`.
- Codex TOML pass-through values must be strings, numbers, booleans, or arrays; nested objects are rejected.

## Vendor-Wide Config

Vendor-wide config is defined in `.rac/config.toml`.

- `[vendor.<target>.config]` writes mergeable leaf selectors to the target's native shared config file.
- `[vendor.<target>.raw]` writes whole immediate top-level keys from TOML values.
- `[vendor.<target>.raw_json]` writes whole immediate top-level keys parsed from TOML strings containing JSON.
- Supported targets are only `claude`, `codex`, and `opencode`.
- `config` accepts strings, booleans, finite numbers, nested tables, inline tables, and homogeneous arrays of scalar JSON-compatible values.
- `raw` accepts JSON-compatible TOML values, including arrays of inline tables.
- `raw_json` requires valid JSON strings; values that cannot be emitted by the target format are rejected.
- Exact or ancestor/descendant selector overlap fails fast across `config`, `raw`, `raw_json`, active packs, and generated MCP/rule ownership.

Example:

```toml
[vendor.codex.config]
model = "gpt-5.5"
model_reasoning_effort = "medium"

[vendor.codex.config.features]
multi_agent = true

[vendor.claude.raw]
allowedMcpServers = [{ serverName = "github" }]

[vendor.opencode.raw_json]
plugin = """["opencode-plugin-foo", ["opencode-plugin-bar", { "enabled": true }]]"""
```

## Shared Packs

Project `.rac/config.toml` can include shared pack references:

```toml
[[packs]]
id = "platform-rules"
repo = "github:owner/repo"
ref = "main"
```

- `id` must match ASCII path-safe `A-Z a-z 0-9 . _ -` and cannot be `project`.
- `repo` must use `github:owner/repo`.
- `ref` is required and must not contain whitespace.
- RAC resolves shared packs with system `git` into cache (`$RAC_CACHE_DIR` or `~/.cache/rac`), then checks out `--detach <ref>`.
- Shared packs can provide definitions but cannot define transitive `[[packs]]`.

## Merge Behavior

Codex `config.toml`, Claude `.mcp.json`/`.claude.json`, Claude `settings.json`, and OpenCode `opencode.jsonc` are co-owned with the user. On install, RAC surgically merges only the keys it owns:

| File | RAC owns |
|---|---|
| Codex `config.toml` | `[mcp_servers.<id>]` and exact vendor-wide `config` selectors |
| Claude `.mcp.json` / `.claude.json` | `mcpServers.<id>` |
| Claude `settings.json` | specific entries in `permissions.deny[]` and exact vendor-wide `config` selectors |
| OpenCode `opencode.jsonc` | `mcp.<id>`, `permission.bash.<cmd>`, and exact vendor-wide `config` selectors |

Everything else in those files is preserved. Ownership is tracked in the per-target install manifest.

To bypass merging and write RAC's content wholesale, use `install --no-merge` or set it in `.rac/config.toml`:

```toml
[install]
merge = false
```

CLI `--no-merge` wins over the config setting. It is subject to the same `--force` rules for unmanaged files.

## Command Reference

Use `npx github:raniejade/rac ...` to run from GitHub, or replace it with `rac ...` when the binary is installed locally or globally.

### `init`

Create `.rac` folders and optional starter examples.

```bash
rac init [--empty] [--scope project|user]
```

- `--empty`: only create folders, skip starter sample files.
- `--scope`: `project` scaffolds `<cwd>/.rac/`; `user` scaffolds `~/.rac/`.

### `doctor`

Validate definitions and print warnings.

```bash
rac doctor [--target claude,codex,opencode] [--kind agent,skill,mcp,rule,config] [--scope project|user]
```

- Prints `ok` when no warnings are found.
- Warns for missing MCP env vars.
- Warns for legacy OpenCode vendor tools when `--target` includes `opencode` and `--kind` includes `agent`.

### `install`

Generate and install selected definitions.

```bash
rac install [--target claude,codex,opencode] [--kind agent,skill,mcp,rule,config] [--dry-run] [--clean] [--check] [--force] [--refresh-packs] [--scope project|user] [--no-merge]
```

- `--dry-run`: previews planned create/update paths and performs no writes.
- `--clean`: deletes stale managed files or stale shared-file selectors for selected target+kind.
- `--check`: verifies generated outputs/manifests are up to date without writing or deleting.
- `--force`: allows overwrite of unmanaged files.
- `--refresh-packs`: force re-clone of shared pack caches before installing.
- `--scope`: see [Install Scopes](install-scopes.md). Default `project`.
- `--no-merge`: write adapter-generated content for shared config files wholesale instead of surgically merging into existing user keys.

Defaults: omitting `--target` applies all targets; omitting `--kind` applies all kinds.

Without `--force`, overwrite rules are:

- allowed: manifest-owned files
- allowed: shared config files with a registered merge strategy
- allowed: TOML/JSONC files with RAC managed warning at byte 0
- allowed: markdown files with YAML frontmatter at byte 0 and RAC managed marker immediately after the closing frontmatter
- blocked: unmanaged JSON files
- blocked: other unmanaged files without markers

When `--no-merge` is set, the merge-strategy allowance is skipped. Those files behave like any other and require manifest ownership or `--force`.

### `pack add`

Append a top-level `[[packs]]` entry to the current project's `.rac/config.toml`.

```bash
rac pack add <id> <repo> --ref <ref>
```

### `pack list`

List configured packs in config order.

```bash
rac pack list
```

- Output format: `<id> <repo> <ref>` on each line.
- Prints `-` when no packs are configured.

### `pack remove`

Remove a top-level `[[packs]]` entry by id from the current project's `.rac/config.toml`.

```bash
rac pack remove <id>
```

## Target Outputs and Install Manifests

Install manifests track managed files and cleanup behavior.

Manifest behavior:

- Missing manifest file is treated as empty.
- Invalid JSON, unsupported version, invalid records, or unsafe manifest record paths fail with `invalid RAC install manifest: <path>: <reason>`.
- Generated output paths and manifest record paths must resolve inside the install target root before overwrite checks, writes, check comparisons, manifest save/delete, and clean deletes.
- Dynamic JSON selectors use bracket-safe JSONPath (`$["..."]["..."]`), vendor-wide config selectors use that same form for JSON and TOML shared files, and Codex MCP table keys use quoted TOML keys.

### Project-Scope Outputs

#### Claude

- Agents: `.claude/agents/<id>.md`
- Skills: `.claude/skills/<id>/SKILL.md` plus skill assets
- MCPs: `.mcp.json`
- Rules and vendor-wide config: `.claude/settings.json`
- Install manifest: `.claude/.rac-install-manifest.json`

#### Codex

- Agents: `.codex/agents/<id>.toml`
- Skills: `.agents/skills/<id>/SKILL.md` plus skill assets
- MCPs and vendor-wide config: `.codex/config.toml`
- Rules: `.codex/rules/<source-file-stem>.rules`
- Install manifests:
  - agents, MCPs, rules, and config: `.codex/.rac-install-manifest.json`
  - skills: `.agents/.rac-install-manifest.json`

#### OpenCode

- Agents: `.opencode/agents/<id>.md`
- Skills: `.opencode/skills/<id>/SKILL.md` plus skill assets
- MCPs, rules, and vendor-wide config: `.opencode/opencode.jsonc`
- Install manifest: `.opencode/.rac-install-manifest.json`

For user-scope paths, see [Install Scopes](install-scopes.md#user-scope-output-paths).

## Safe Install Workflow

```bash
# Add/update shared pack references.
rac pack add platform-rules github:owner/repo --ref main

# Validate definitions.
rac doctor

# Preview selected targets/kinds.
rac install --dry-run

# Refresh pack caches while previewing or applying.
rac install --refresh-packs --dry-run

# Apply selected targets/kinds.
rac install

# Clean stale managed outputs after removing definitions or packs.
rac install --clean
```

Guidelines:

- Use `--target` and `--kind` during incremental rollout.
- If omitted, `--target` and `--kind` apply all targets/kinds.
- Use `--clean` only after reviewing current definitions and managed outputs.
- Use `--force` only when you intentionally want to replace unmanaged files.

## Troubleshooting

- `invalid target/kind`
  - Use supported targets: `claude`, `codex`, `opencode`.
  - Use supported kinds: `agent`, `skill`, `mcp`, `rule`, `config`.

- `refusing to overwrite existing init examples`
  - `init` found starter files already present. Remove or rename them, or run with `--empty` if you only need folders.

- `duplicate agent id`, `duplicate skill id`, `duplicate mcp id`, `duplicate rule id`
  - Ensure each ID is unique in `.rac` sources and active shared packs.

- `skill frontmatter must start with +++ at byte 0` or `missing closing +++ delimiter`
  - Fix `SKILL.md` TOML frontmatter delimiters and placement.

- `mcp requires local command OR remote url` / `mcp cannot define both local and remote transport`
  - Fix MCP transport fields so only one transport mode is defined.

- `missing env var: ...`
  - Set required environment variables before running downstream tools.

- `refusing overwrite unmanaged file: <path>`
  - File exists and is not managed by RAC manifest markers, and either it has no registered merge strategy or `--no-merge` is in effect.
  - For shared config files, drop `--no-merge` to let RAC surgically merge instead.
  - Otherwise migrate/delete it manually, or rerun with `--force` if replacement is intentional.

- `refusing to merge malformed codex config.toml: ...`
  - Existing `config.toml` is not valid TOML. Back the file up and fix it, or rerun with `--no-merge --force` to let RAC replace it.
