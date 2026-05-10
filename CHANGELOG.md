# Changelog

## Unreleased

### Breaking Changes

- **Skill assets are now auto-discovered.** Every non-dotfile under a skill directory (recursive, symlinks not followed) is installed alongside `SKILL.md`. Previously, only files explicitly listed in the `assets = [...]` frontmatter field were installed — undeclared files were silently ignored.

  **Migration:** Files previously not declared in `assets` and silently dropped will now ship. Audit each skill directory before upgrading. To exclude a file from installation, prefix it with `.` (dotfiles are excluded) or move it outside the skill directory.

  The `assets = [...]` frontmatter field is no longer read. Existing SKILL.md files that still declare it continue to load without error — the field is silently dropped by the schema parser and auto-discovery decides what ships. Clean up any `assets = [...]` lines at your leisure.

## 0.2.1

### Patch Changes

- [#24](https://github.com/raniejade/rac/pull/24) [`85705f0`](https://github.com/raniejade/rac/commit/85705f0228ebe1651e5c2e8704b571e68df3e34d) Thanks [@raniejade](https://github.com/raniejade)! - initial release
