# airc

Install `.airc` agent/skill/MCP definitions into Claude, Codex, and OpenCode config surfaces.

## Run with npx

```bash
npx github:raniejade/airc init --scope project
npx github:raniejade/airc doctor --scope project
npx github:raniejade/airc install --scope project --dry-run
npx github:raniejade/airc install --scope project
```

`airc install` supports:

- `--target claude,codex,opencode`
- `--kind agent,skill,mcp`
- `--scope project|user`
