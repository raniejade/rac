---
"@raniejade/rac": minor
---

Add `rac uninstall` command and consolidate selector parsing.

`rac uninstall` reverses an install by reading every per-target install manifest on disk and removing what RAC owns: whole-file outputs (agents, skills, codex rules) are unlinked, and shared config files (`.claude/settings.json`, `.mcp.json`, `.codex/config.toml`, `.opencode/opencode.jsonc`) are surgically pruned of RAC-managed selectors via the same merge strategies install uses, with `nextRecords: []`. User content in shared files is preserved; manifests are deleted only when their records array empties; files are written before manifests so a re-run can recover from partial failure. Flags: `--targets`, `--kind`, `--scope project|user`, `--dry-run`, `--yes`. Without `--yes`, the command prints the plan and prompts for confirmation (TTY readline; piped `y\n` also works); non-interactive shells without `--yes` exit 1. A defensive guard prevents whole-file deletion of known shared file paths even if a manifest record claims selector `$`.

Internal: the four duplicate `$` selector parsers across `target-adapters.ts`, `merge-strategies.ts`, `parsers.ts`, and `config-model.ts` are consolidated into a single `src/core/selector.ts` module exporting `parseSelector`, `tryParseSelector`, `isWholeFileSelector`, `formatSelector`, `parseCodexTomlSelector`, and `pathsOverlap`. The new parser correctly unescapes JSON-encoded keys with embedded quotes (the legacy implementations differed subtly). The on-disk manifest selector format is unchanged — `formatSelector` is byte-identical to the previous `jsonPathBracketSelector`.
