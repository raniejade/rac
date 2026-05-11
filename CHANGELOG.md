# Changelog

## 0.4.0

### Minor Changes

- [#39](https://github.com/raniejade/rac/pull/39) [`c6f501b`](https://github.com/raniejade/rac/commit/c6f501bfc90d8798ff98d8e1e6080c3798334d7f) Thanks [@raniejade](https://github.com/raniejade)! - Add local pack overrides for dev cycle. A new `.rac/config.local.toml` (gitignored) with `[[pack_overrides]]` entries redirects a configured `[[packs]]` id to a local directory, bypassing git and cache so packs can be iterated on locally without commit/push churn.

  - New CLI: `rac pack override <id> <path>` and `rac pack override <id> --clear`.
  - `rac pack list` decorates overridden packs with `(override → <path>)`.
  - `rac doctor` and `rac install` emit a `WARN` per active override (install still exits 0).
  - `rac init` writes `.rac/.gitignore` containing `config.local.toml`.

- [#41](https://github.com/raniejade/rac/pull/41) [`33037ca`](https://github.com/raniejade/rac/commit/33037ca07ba4ad1c84c8503ce6fd1a0e179cb5f7) Thanks [@raniejade](https://github.com/raniejade)! - Pin shared packs to resolved commit SHAs via `.rac/rac-lock.json`. The lockfile is committed alongside `config.toml`; future installs check out the locked SHA instead of re-resolving the floating `ref`. Two machines installing the same project now produce identical outputs, and CI can gate on lockfile drift.

  - New flag `--frozen-lockfile` for `rac install`, `rac diff`, and `rac doctor`: errors (exit code 2) if the lockfile would change.
  - Existing `--refresh-packs` now also re-resolves and rewrites the lockfile.
  - `rac pack add` / `rac pack remove` keep the lockfile in sync.
  - Pack overrides skip the lockfile entirely.
  - `rac doctor` reports malformed lockfiles, stale entries, and (with `--frozen-lockfile`) missing entries.

## 0.3.0

### Minor Changes

- [#28](https://github.com/raniejade/rac/pull/28) [`676c3d7`](https://github.com/raniejade/rac/commit/676c3d79b0f5e469e389315d876313c095bbfd6a) Thanks [@raniejade](https://github.com/raniejade)! - Add `rac uninstall` command and consolidate selector parsing.

  `rac uninstall` reverses an install by reading every per-target install manifest on disk and removing what RAC owns: whole-file outputs (agents, skills, codex rules) are unlinked, and shared config files (`.claude/settings.json`, `.mcp.json`, `.codex/config.toml`, `.opencode/opencode.jsonc`) are surgically pruned of RAC-managed selectors via the same merge strategies install uses, with `nextRecords: []`. User content in shared files is preserved; manifests are deleted only when their records array empties; files are written before manifests so a re-run can recover from partial failure. Flags: `--targets`, `--kind`, `--scope project|user`, `--dry-run`, `--yes`. Without `--yes`, the command prints the plan and prompts for confirmation (TTY readline; piped `y\n` also works); non-interactive shells without `--yes` exit 1. A defensive guard prevents whole-file deletion of known shared file paths even if a manifest record claims selector `$`.

  Internal: the four duplicate `$` selector parsers across `target-adapters.ts`, `merge-strategies.ts`, `parsers.ts`, and `config-model.ts` are consolidated into a single `src/core/selector.ts` module exporting `parseSelector`, `tryParseSelector`, `isWholeFileSelector`, `formatSelector`, `parseCodexTomlSelector`, and `pathsOverlap`. The new parser correctly unescapes JSON-encoded keys with embedded quotes (the legacy implementations differed subtly). The on-disk manifest selector format is unchanged — `formatSelector` is byte-identical to the previous `jsonPathBracketSelector`.

### Patch Changes

- [#26](https://github.com/raniejade/rac/pull/26) [`1a2a58d`](https://github.com/raniejade/rac/commit/1a2a58daa2d937c036ab77a161b6560f0243b809) Thanks [@raniejade](https://github.com/raniejade)! - CLI output overhaul: rac install groups changes by target → kind with action symbols (`+`/`~`/`-`), pack:id labels, relative paths, and a summary line. rac doctor renders structured warnings with severity badges (`ERROR`/`WARN`/`INFO`) and exits 1 when any error-severity warning is present. Added a global `--plain` (`-p`) flag plus auto-detection (`NO_COLOR`, `CI`, `FORCE_COLOR`, TTY). Internal: `InstallResult` now carries a `changes: InstallChange[]` view alongside the existing `create/update/del` arrays; `ConfigWarning` gained `severity`, `code`, optional `hint`, and `context`. rac install now shows a brief animated spinner while resolving and writing files (color mode only — silent in --plain, NO_COLOR, CI, or when stdout isn't a TTY).

- [#33](https://github.com/raniejade/rac/pull/33) [`8f835e1`](https://github.com/raniejade/rac/commit/8f835e190ee707cfd63bfed14676d834a853cb4e) Thanks [@raniejade](https://github.com/raniejade)! - Add npm keywords (claude, claude-code, codex, opencode, mcp, agent-config, agents, skills, cli, dotfiles) for discoverability.

- [#31](https://github.com/raniejade/rac/pull/31) [`2261d0f`](https://github.com/raniejade/rac/commit/2261d0f5296476d63b18cb7edef40de5ed190ccc) Thanks [@raniejade](https://github.com/raniejade)! - Add `rac diff` command and reroute `install --dry-run` through the same renderer.

  `rac diff` shows git-style unified diffs of every file `install` would create or update, grouped by target → kind with the same action symbols (`+`/`~`/`-`) and `pack:id` labels as `rac install`. Update bodies are produced by jsdiff's `createTwoFilesPatch` (3 lines of context) with green `+`, red `-`, cyan `@@`, and gray header coloring under the existing `--plain` / `NO_COLOR` / `CI` / TTY rules; create/delete bodies skip the patch step and dump content with `+`/`-` prefixes. A `Drift detected:` section flags managed files whose current SHA-256 no longer matches the manifest hash recorded at last install — useful for catching hand-edits before they get reverted by the next install. Drift entries on shared merged files (`.claude/settings.json`, `.mcp.json`, `.codex/config.toml`, `.opencode/opencode.jsonc`) are deduplicated to one entry per `(target, relPath)` with contributing record ids joined by `+`. Flags: `--targets`, `--kind`, `--scope project|user`, `--refresh-packs`, `--no-merge`, `--summary` (suppress per-file diffs; show the legacy path/count table only), `--no-drift` (skip the drift section). `rac diff` is informational and always exits 0 absent real errors; for CI gating, keep using `install --check`.

  `rac install --dry-run` is now rerouted through `diff()` + `renderDiff()`, so `--dry-run` shows unified diffs by default; pass `--dry-run --summary` for byte-compatible legacy output. Binary skill assets are detected via UTF-8 round-trip (and the `sourceFile`-without-`content` shape) and rendered as `(binary, content omitted)` rather than producing a noisy patch; drift on binary assets uses raw-Buffer hashing so unchanged binaries don't false-positive.

  Internal: extracted `computeInstallPlan(options): Promise<ComputeInstallPlanResult>` from `install()` so both `install` and the new `diff()` core share one plan-computation path; `install()` external behavior is unchanged. Exported `exists`, `contentMatches`, `ManifestEntry`, `PlannedWrite` from `src/core/install.ts`. New core function `diff()` and types `DiffOptions`, `DiffEntry`, `DriftEntry`, `DiffResult` exported from the package entry. `renderInstall()`'s grouped change-list body extracted into a shared `renderChangeList()` helper consumed by both renderers. Added `diff@^5.2.0` (jsdiff) as a runtime dependency for unified-patch generation; the diff algorithm itself is not implemented in-tree.

## Unreleased

### Breaking Changes

- **Skill assets are now auto-discovered.** Every non-dotfile under a skill directory (recursive, symlinks not followed) is installed alongside `SKILL.md`. Previously, only files explicitly listed in the `assets = [...]` frontmatter field were installed — undeclared files were silently ignored.

  **Migration:** Files previously not declared in `assets` and silently dropped will now ship. Audit each skill directory before upgrading. To exclude a file from installation, prefix it with `.` (dotfiles are excluded) or move it outside the skill directory.

  The `assets = [...]` frontmatter field is no longer read. Existing SKILL.md files that still declare it continue to load without error — the field is silently dropped by the schema parser and auto-discovery decides what ships. Clean up any `assets = [...]` lines at your leisure.

## 0.2.1

### Patch Changes

- [#24](https://github.com/raniejade/rac/pull/24) [`85705f0`](https://github.com/raniejade/rac/commit/85705f0228ebe1651e5c2e8704b571e68df3e34d) Thanks [@raniejade](https://github.com/raniejade)! - initial release
