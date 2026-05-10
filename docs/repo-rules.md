# Repo Rules

This repository denies several `git` and `gh` commands directly. Use the
`mise` wrappers instead — they run the full gate (lint, typecheck, tests,
build, harness smoke) before touching the remote or GitHub.

| Don't run                | Do run                         |
| ------------------------ | ------------------------------ |
| `git push …`             | `mise push-branch`             |
| `gh pr create …`         | `mise create-pr -- <gh flags>` |
| `gh pr edit …`           | `mise update-pr -- <gh flags>` |

Pass extra flags through with `-- …` (e.g.
`mise create-pr -- --title "…" --body "…"`).

The forbidden commands are encoded in `.rac/rules/deny-git-push.toml` and
`.rac/rules/deny-gh-pr.toml`; the gate itself is `mise run gate`.
