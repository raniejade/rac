import { stat } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTmpDirs, makeTmp, runCli, seed } from './helpers.js';

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

    const installResult = runCli(root, ['install', '--targets', 'claude,codex', '--kind', 'agent']);
    expect(installResult.status).toBe(0);

    // Verify agents were installed
    await expect(exists(path.join(root, '.claude/agents/reviewer.md'))).resolves.toBe(true);
    await expect(exists(path.join(root, '.codex/agents/reviewer.toml'))).resolves.toBe(true);

    const uninstallResult = runCli(root, ['uninstall', '--yes', '--kind', 'agent', '--targets', 'codex']);
    expect(uninstallResult.status).toBe(0);

    // Only codex agent should be gone
    await expect(exists(path.join(root, '.codex/agents/reviewer.toml'))).resolves.toBe(false);

    // Claude agent should still be present
    await expect(exists(path.join(root, '.claude/agents/reviewer.md'))).resolves.toBe(true);
  });

  it('uninstall --dry-run: exits 0 with rendered plan, zero filesystem changes', async () => {
    const root = await makeTmp();
    await seed(root);

    const installResult = runCli(root, ['install', '--targets', 'claude,codex', '--kind', 'agent,mcp']);
    expect(installResult.status).toBe(0);

    // Snapshot directory tree before dry-run
    const beforeSnapshot = await treeSnapshot(root);

    const dryRunResult = runCli(root, ['uninstall', '--dry-run']);
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

    const installResult = runCli(root, ['install', '--targets', 'claude', '--kind', 'agent']);
    expect(installResult.status).toBe(0);

    // runCli uses spawnSync, which is non-TTY. Without --yes, should fail.
    const uninstallResult = runCli(root, ['uninstall']);
    expect(uninstallResult.status).not.toBe(0);
    expect(uninstallResult.stderr).toContain('--yes');
  });

  it('render snapshot: install one of each kind, then uninstall --dry-run has correct glyph counts', async () => {
    const root = await makeTmp();
    await seed(root);

    const installResult = runCli(root, ['install', '--targets', 'claude,codex', '--kind', 'agent,mcp,rule', '--plain']);
    expect(installResult.status).toBe(0);

    const dryRunResult = runCli(root, ['uninstall', '--dry-run', '--plain']);
    expect(dryRunResult.status).toBe(0);

    const output = dryRunResult.stdout;

    // Should have `-` glyphs for delete-file actions (agents are whole-file)
    const deleteGlyphs = (output.match(/ {2}[a-z ]+ {2}- {2}/g) ?? []).length;
    expect(deleteGlyphs).toBeGreaterThan(0);

    // Should have `~` glyphs for prune-selector actions (mcp and rule are shared files)
    const pruneGlyphs = (output.match(/ {2}[a-z ]+ {2}~ {2}/g) ?? []).length;
    expect(pruneGlyphs).toBeGreaterThan(0);

    // Should contain (dry-run) in summary
    expect(output).toContain('(dry-run)');
  });

  it('uninstall --dry-run on empty (nothing installed): exits 0 with nothing-to-uninstall message', async () => {
    const root = await makeTmp();
    await seed(root);

    const dryRunResult = runCli(root, ['uninstall', '--dry-run']);
    expect(dryRunResult.status).toBe(0);
    expect(dryRunResult.stdout).toContain('Nothing to uninstall.');
  });

  it('uninstall --yes on already-empty: exits 0 with nothing-to-uninstall message', async () => {
    const root = await makeTmp();
    await seed(root);

    const result = runCli(root, ['uninstall', '--yes']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Nothing to uninstall.');
  });
});
