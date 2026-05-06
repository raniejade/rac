# RAC Architecture

## Pipeline (Current)

RAC is organized as a strict 4-stage flow:

1. Parsed source files
2. Common runtime representation
3. Vendor-specific adapters
4. Centralized install writer with vendor-local manifest safety

The core ownership rule is: upstream stages do not know about downstream file formats.

## 1) Parsed Source Files (`src/core/parsers.ts`)

Inputs are loaded from the project source root:

- `agents/*.toml`
- `skills/*/SKILL.md` with `+++` frontmatter
- `mcps/*.toml`

Responsibilities:

- Discover files with deterministic glob patterns
- Parse and validate schema (`zod`)
- Enforce structural constraints (duplicate IDs, MCP transport exclusivity, skill frontmatter boundaries)
- Emit typed source definitions with source-path metadata

Non-responsibilities:

- No vendor output shape decisions
- No install/write policy

## 2) Common Runtime Representation (`src/core/config-model.ts`)

`buildRuntimeConfig(...)` translates parsed definitions into a vendor-neutral runtime model.

Responsibilities:

- Normalize cross-cutting fields used by all targets
- Resolve instruction file indirection for agents
- Resolve skill asset hashes
- Normalize MCP transport into `local` vs `remote`
- Normalize vendor pass-through maps:
- `vendor.<target>.config` for agent/skill/mcp target payload overlays
- `vendor.<target>.frontmatter` for skill markdown frontmatter overlays
- skill frontmatter merge order is `base generated/frontmatter -> vendor.<target>.config -> vendor.<target>.frontmatter`
- skill overlay maps cannot collide with generated keys (`name`, `description`) and cannot duplicate keys across `config` + `frontmatter`
- Enforce collision rules for generated keys and incompatibilities (for example instruction-only + codex config)
- Collect config warnings as runtime signals

Non-responsibilities:

- No target file path decisions
- No filesystem writes

This is the integration seam between source parsing and target adapters.

## 3) Vendor-Specific Adapters (`src/adapters/target-adapters.ts`)

Each target adapter maps `RuntimeConfig` into `AdapterOutput[]` write plans.

Current adapters:

- `claude`
- `codex`
- `opencode`

Responsibilities:

- Define target-relative output paths
- Render target-specific content formats
- Apply vendor pass-through overlays verbatim
- Preserve source metadata + deterministic content hash
- Mark JSON outputs when overwrite policy should be stricter

Non-responsibilities:

- No direct file I/O
- No manifest mutation
- No overwrite/delete decision logic

The adapter contract is intentionally small:

- Input: `RuntimeConfig`
- Output: declarative write plan (`AdapterOutput`)

## 4) Centralized Install Writer + Vendor-Local Manifest Safety (`src/core/install.ts`, `src/core/manifest.ts`)

`install(...)` is the only write/delete orchestrator.

Responsibilities:

- Build a full plan by combining selected kinds + targets
- Apply overwrite guardrails (`canOverwrite`) with managed-file checks
- Write files (content or asset copy) exactly once per destination path
- Optionally clean stale managed outputs
- Persist vendor-local install manifests per target/kind:
- `.claude/.rac-install-manifest.json` (claude agents/skills/mcp)
- `.codex/.rac-install-manifest.json` (codex agents/mcp)
- `.agents/.rac-install-manifest.json` (codex skills)
- `.opencode/.rac-install-manifest.json` (opencode agents/skills/mcp)

Safety model:

- Managed ownership is tracked in vendor-local manifests using `relPath` + inventory selectors
- Unmanaged files are protected from overwrite unless explicit conditions are met (`force`, manifest-owned, or managed markers for text outputs)
- Deletions are constrained to stale manifest-owned outputs when `clean` is enabled

This keeps write policy centralized and consistent across all vendors.

## Ownership Boundaries Summary

- `parsers.ts`: file discovery + schema validation only
- `config-model.ts`: runtime normalization only
- `target-adapters.ts`: vendor rendering + path planning only
- `install.ts`/`manifest.ts`: write/delete policy + state tracking only

If behavior belongs to more than one stage, prefer moving it earlier as normalized data rather than duplicating it in multiple adapters.

## Adding a New Vendor

1. Add target literal in core types (`Target` in `src/core/types.ts`).
2. Implement a new adapter in `src/adapters/target-adapters.ts`:
   - Create `<vendor>Adapter(): TargetAdapter`
   - Map `RuntimeConfig` to deterministic `AdapterOutput[]`
   - Define target-relative output paths and content
3. Register adapter in `TARGET_ADAPTERS`.
4. Ensure CLI target parsing accepts the new target (if target list is enforced there).
5. Add tests covering:
   - Adapter output paths/content
   - Install behavior for create/update/clean with manifest ownership
6. Validate full pipeline with lint/typecheck/test/build.

Design rule: do not bypass the shared runtime model or install writer. Vendor logic belongs only in adapter planning.
