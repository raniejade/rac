---
"@raniejade/rac": minor
---

Add local pack overrides for dev cycle. A new `.rac/config.local.toml` (gitignored) with `[[pack_overrides]]` entries redirects a configured `[[packs]]` id to a local directory, bypassing git and cache so packs can be iterated on locally without commit/push churn.

- New CLI: `rac pack override <id> <path>` and `rac pack override <id> --clear`.
- `rac pack list` decorates overridden packs with `(override → <path>)`.
- `rac doctor` and `rac install` emit a `WARN` per active override (install still exits 0).
- `rac init` writes `.rac/.gitignore` containing `config.local.toml`.
