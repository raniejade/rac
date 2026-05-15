---
"@raniejade/rac": patch
---

Fix the RAC CLI package entrypoint by splitting the import-safe command program from the executable bin entrypoint, so installed `rac` binaries run correctly while tests can import the program safely.

Add regression coverage for shared-pack skill reference files, including reinstall backfill when an older manifest only tracked `SKILL.md`.
