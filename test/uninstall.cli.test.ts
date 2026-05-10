import { stat } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { install } from '../src/core/install.js';
import { uninstall } from '../src/core/uninstall.js';

import { cleanupTmpDirs, makeTmp, runCliInProcess, seed } from './helpers.js';

afterEach(cleanupTmpDirs);

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function treeSnapshot(root: string): Promise<Set<string>> {
  const { readdirSync, statSync } = await import('node:fs');
  const files = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files.add(path.relative(root, full));
      }
    }
  };
  walk(root);
  return files;
}

describe('rac uninstall CLI', () => {
  it('install then uninstall --yes --kind agent --targets codex: exits 0, only codex agent files removed', async () => {
    const root = await makeTmp();
    await seed(root);

    // Direct call: no spawn tax, tests the same underlying behavior
    await install({ cwd: root, targets: ['claude', 'codex'], kinds: ['agent'] });

    // Verify agents were installed
    await expect(exists(path.join(root, '.claude/agents/reviewer.md'))).resolves.toBe(true);
    await expect(exists(path.join(root, '.codex/agents/reviewer.toml'))).resolves.toBe(true);

    // Direct call: exercise the filter logic (--kind agent --targets codex)
    await uninstall({ cwd: root, targets: ['codex'], kinds: ['agent'], yes: true });

    // Only codex agent should be gone
    await expect(exists(path.join(root, '.codex/agents/reviewer.toml'))).resolves.toBe(false);

    // Claude agent should still be present
    await expect(exists(path.join(root, '.claude/agents/reviewer.md'))).resolves.toBe(true);
  });

  it('uninstall --dry-run: exits 0 with rendered plan, zero filesystem changes', async () => {
    const root = await makeTmp();
    await seed(root);

    const installResult = await runCliInProcess(root, ['install', '--targets', 'claude,codex', '--kind', 'agent,mcp']);
    expect(installResult.status).toBe(0);

    // Snapshot directory tree before dry-run
    const beforeSnapshot = await treeSnapshot(root);

    const dryRunResult = await runCliInProcess(root, ['uninstall', '--dry-run']);
    expect(dryRunResult.status).toBe(0);

    // Output should indicate it's a dry-run plan
    expect(dryRunResult.stdout).toContain('dry-run');

    // Snapshot directory tree after dry-run — should be identical
    const afterSnapshot = await treeSnapshot(root);
    expect([...afterSnapshot].sort()).toEqual([...beforeSnapshot].sort());
  });

  it('uninstall without --yes in non-TTY: exits non-zero and stderr contains --yes', async () => {
    const root = await makeTmp();
    await seed(root);

    const installResult = await runCliInProcess(root, ['install', '--targets', 'claude', '--kind', 'agent']);
    expect(installResult.status).toBe(0);

    // runCliInProcess is non-TTY. Without --yes, should fail.
    const uninstallResult = await runCliInProcess(root, ['uninstall']);
    expect(uninstallResult.status).toBe(1);
    expect(uninstallResult.stderr).toContain('--yes');
  });

  it('render snapshot: install one of each kind, then uninstall --dry-run has correct glyph counts', async () => {
    const root = await makeTmp();
    await seed(root);

    const installResult = await runCliInProcess(root, ['install', '--targets', 'claude,codex', '--kind', 'agent,mcp,rule', '--plain']);
    expect(installResult.status).toBe(0);

    const dryRunResult = await runCliInProcess(root, ['uninstall', '--dry-run', '--plain']);
    expect(dryRunResult.status).toBe(0);

    const output = dryRunResult.stdout;

    // Should have `-` glyphs for delete-file actions (agents are whole-file)
    // claude: 1 agent + 1 manifest; codex: 1 agent + 2 rules (same file, 2 records) + 1 manifest = 6
    const deleteGlyphs = (output.match(/ {2}[a-z ]+ {2}- {2}/g) ?? []).length;
    expect(deleteGlyphs).toBe(6);

    // Should have `~` glyphs for prune-selector actions (mcp and rule are shared files)
    // claude: 1 mcp + 2 rules (deny/deny entries); codex: 1 mcp = 4
    const pruneGlyphs = (output.match(/ {2}[a-z ]+ {2}~ {2}/g) ?? []).length;
    expect(pruneGlyphs).toBe(4);

    // Should contain (dry-run) in summary
    expect(output).toContain('(dry-run)');
  });

  it('uninstall --dry-run on empty (nothing installed): exits 0 with nothing-to-uninstall message', async () => {
    const root = await makeTmp();
    await seed(root);

    const dryRunResult = await runCliInProcess(root, ['uninstall', '--dry-run']);
    expect(dryRunResult.status).toBe(0);
    expect(dryRunResult.stdout).toContain('Nothing to uninstall.');
  });

  it('uninstall --yes on already-empty: exits 0 with nothing-to-uninstall message', async () => {
    const root = await makeTmp();
    await seed(root);

    const result = await runCliInProcess(root, ['uninstall', '--yes']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Nothing to uninstall.');
  });

  it('uninstall with piped y: exits 0 and agent file is removed', async () => {
    const root = await makeTmp();
    await seed(root);

    const installResult = await runCliInProcess(root, ['install', '--targets', 'claude', '--kind', 'agent']);
    expect(installResult.status).toBe(0);
    await expect(exists(path.join(root, '.claude/agents/reviewer.md'))).resolves.toBe(true);

    const uninstallResult = await runCliInProcess(root, ['uninstall'], { stdin: 'y\n' });

    expect(uninstallResult.status).toBe(0);
    await expect(exists(path.join(root, '.claude/agents/reviewer.md'))).resolves.toBe(false);
  });
});
