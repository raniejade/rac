---
"@raniejade/rac": patch
---

CLI output overhaul: rac install groups changes by target → kind with action symbols (`+`/`~`/`-`), pack:id labels, relative paths, and a summary line. rac doctor renders structured warnings with severity badges (`ERROR`/`WARN`/`INFO`) and exits 1 when any error-severity warning is present. Added a global `--plain` (`-p`) flag plus auto-detection (`NO_COLOR`, `CI`, `FORCE_COLOR`, TTY). Internal: `InstallResult` now carries a `changes: InstallChange[]` view alongside the existing `create/update/del` arrays; `ConfigWarning` gained `severity`, `code`, optional `hint`, and `context`.
