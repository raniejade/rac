import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { install } from '../src/core/install.js';
import { saveManifest } from '../src/core/manifest.js';
import { uninstall } from '../src/core/uninstall.js';

import { cleanupTmpDirs, makeTmp, readJsoncFile, seed } from './helpers.js';

afterEach(cleanupTmpDirs);

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('uninstall', () => {
  it('round-trip: install all → uninstall → no RAC files remain, sibling user content preserved', async () => {
    const root = await makeTmp();
    await seed(root);

    // Pre-seed opencode.jsonc with an unrelated user key
    await mkdir(path.join(root, '.opencode'), { recursive: true });
    await writeFile(path.join(root, '.opencode/opencode.jsonc'), '{"userKey": "preserved"}\n', 'utf8');

    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['agent', 'skill', 'mcp', 'rule'] });

    const result = await uninstall({ cwd: root, yes: true });

    // All changes should be populated
    expect(result.changes.length).toBeGreaterThan(0);

    // Claude agents should be gone
    await expect(exists(path.join(root, '.claude/agents/reviewer.md'))).resolves.toBe(false);
    // Codex agents should be gone
    await expect(exists(path.join(root, '.codex/agents/reviewer.toml'))).resolves.toBe(false);
    // Opencode agents should be gone
    await expect(exists(path.join(root, '.opencode/agents/reviewer.md'))).resolves.toBe(false);

    // Skills should be gone
    await expect(exists(path.join(root, '.claude/skills/project-gates/SKILL.md'))).resolves.toBe(false);
    await expect(exists(path.join(root, '.agents/skills/project-gates/SKILL.md'))).resolves.toBe(false);
    await expect(exists(path.join(root, '.opencode/skills/project-gates/SKILL.md'))).resolves.toBe(false);

    // Manifests should be gone
    await expect(exists(path.join(root, '.claude/.rac-install-manifest.json'))).resolves.toBe(false);
    await expect(exists(path.join(root, '.codex/.rac-install-manifest.json'))).resolves.toBe(false);
    await expect(exists(path.join(root, '.agents/.rac-install-manifest.json'))).resolves.toBe(false);
    await expect(exists(path.join(root, '.opencode/.rac-install-manifest.json'))).resolves.toBe(false);

    // User key in opencode.jsonc should be preserved (surgical prune)
    const opencode = await readJsoncFile<{ userKey?: string; mcp?: unknown; permission?: unknown }>(path.join(root, '.opencode/opencode.jsonc'));
    expect(opencode.userKey).toBe('preserved');
    expect(opencode.mcp).toBeUndefined();
    expect(opencode.permission).toBeUndefined();
  });

  it('whole-file deletes: install agents/skills → uninstall → files gone', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['agent', 'skill'] });

    // Verify files were installed
    await expect(exists(path.join(root, '.claude/agents/reviewer.md'))).resolves.toBe(true);
    await expect(exists(path.join(root, '.codex/agents/reviewer.toml'))).resolves.toBe(true);
    await expect(exists(path.join(root, '.agents/skills/project-gates/SKILL.md'))).resolves.toBe(true);

    const result = await uninstall({ cwd: root, kinds: ['agent', 'skill'] });

    // delete-file changes should be present
    const deleteFileChanges = result.changes.filter((c) => c.action === 'delete-file');
    expect(deleteFileChanges.length).toBeGreaterThan(0);

    // All agent and skill files should be gone
    await expect(exists(path.join(root, '.claude/agents/reviewer.md'))).resolves.toBe(false);
    await expect(exists(path.join(root, '.codex/agents/reviewer.toml'))).resolves.toBe(false);
    await expect(exists(path.join(root, '.opencode/agents/reviewer.md'))).resolves.toBe(false);
    await expect(exists(path.join(root, '.agents/skills/project-gates/SKILL.md'))).resolves.toBe(false);
    await expect(exists(path.join(root, '.claude/skills/project-gates/SKILL.md'))).resolves.toBe(false);
  });

  it('selector pruning: install rules → uninstall kind=rule → shared files cleaned', async () => {
    const root = await makeTmp();
    await seed(root);

    // Add some user content to settings.json first
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await writeFile(path.join(root, '.claude/settings.json'), JSON.stringify({ theme: 'dark' }, null, 2) + '\n', 'utf8');

    await install({ cwd: root, targets: ['claude', 'opencode'], kinds: ['rule'] });

    // Verify rules are in settings
    const before = JSON.parse(await readFile(path.join(root, '.claude/settings.json'), 'utf8')) as { permissions?: { allow?: string[]; deny?: string[] } };
    expect(before.permissions).toBeDefined();

    const result = await uninstall({ cwd: root, kinds: ['rule'] });

    // prune-selector changes should be present
    const pruneChanges = result.changes.filter((c) => c.action === 'prune-selector');
    expect(pruneChanges.length).toBeGreaterThan(0);

    // .claude/settings.json should have no rac-managed rules but user content preserved
    const settingsContent = await readFile(path.join(root, '.claude/settings.json'), 'utf8');
    const settings = JSON.parse(settingsContent) as { theme?: string; permissions?: { allow?: string[]; deny?: string[] } };
    // User theme preserved if it was part of settings
    // permissions array should be empty or cleared of RAC entries
    const denyList = settings.permissions?.deny ?? [];
    const allowList = settings.permissions?.allow ?? [];
    // RAC entries should be gone
    expect(denyList.some((e) => e.includes('git push') || e.includes('gh'))).toBe(false);
    expect(allowList.some((e) => e.includes('git push') || e.includes('gh'))).toBe(false);
  });

  it('mixed-kind partial uninstall: install agent+mcp → uninstall kinds=[agent] → agent gone, MCP retained', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['claude', 'codex'], kinds: ['agent', 'mcp'] });

    // Verify both installed
    await expect(exists(path.join(root, '.claude/agents/reviewer.md'))).resolves.toBe(true);
    await expect(exists(path.join(root, '.mcp.json'))).resolves.toBe(true);

    const result = await uninstall({ cwd: root, targets: ['claude', 'codex'], kinds: ['agent'] });

    // Agent should be gone
    await expect(exists(path.join(root, '.claude/agents/reviewer.md'))).resolves.toBe(false);
    await expect(exists(path.join(root, '.codex/agents/reviewer.toml'))).resolves.toBe(false);

    // MCP should still be present
    await expect(exists(path.join(root, '.mcp.json'))).resolves.toBe(true);
    const mcpContent = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
    expect(mcpContent.mcpServers?.['project-rules']).toBeDefined();

    // Manifest should still exist with MCP records
    const manifestContent = JSON.parse(await readFile(path.join(root, '.claude/.rac-install-manifest.json'), 'utf8')) as { records: Array<{ kind: string }> };
    expect(manifestContent.records.some((r) => r.kind === 'mcp')).toBe(true);
    expect(manifestContent.records.some((r) => r.kind === 'agent')).toBe(false);

    // result changes should not include manifest deletion (MCP records remain)
    const deleteManifestChanges = result.changes.filter((c) => c.action === 'delete-manifest');
    // The claude manifest still has MCP records, so it should NOT be in deleteManifestChanges
    const claudeManifest = path.join(root, '.claude/.rac-install-manifest.json');
    expect(deleteManifestChanges.some((c) => c.absPath === claudeManifest)).toBe(false);
  });

  it('manifest deletion only when emptied: partial uninstall leaves manifest with surviving records', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['claude'], kinds: ['agent', 'mcp'] });

    await uninstall({ cwd: root, targets: ['claude'], kinds: ['agent'] });

    // Manifest should still exist
    const manifestPath = path.join(root, '.claude/.rac-install-manifest.json');
    await expect(exists(manifestPath)).resolves.toBe(true);

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { records: Array<{ kind: string }> };
    // Only mcp records should remain
    expect(manifest.records.every((r) => r.kind === 'mcp')).toBe(true);
    expect(manifest.records.length).toBeGreaterThan(0);
  });

  it('non-existent file referenced by manifest: uninstall does not throw; record dropped', async () => {
    const root = await makeTmp();
    await seed(root);

    // Install so manifest is created, then delete the target file
    await install({ cwd: root, targets: ['codex'], kinds: ['agent'] });
    const agentFile = path.join(root, '.codex/agents/reviewer.toml');
    await rm(agentFile, { force: true });

    // Uninstall should not throw even though the file is already gone
    await expect(uninstall({ cwd: root, targets: ['codex'], kinds: ['agent'] })).resolves.toBeTruthy();

    // Manifest should be deleted (all records removed)
    await expect(exists(path.join(root, '.codex/.rac-install-manifest.json'))).resolves.toBe(false);
  });

  it('dry-run writes nothing: result.changes populated, filesystem unchanged', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['claude', 'codex'], kinds: ['agent', 'mcp'] });

    // Capture state before dry-run
    const agentExists = await exists(path.join(root, '.claude/agents/reviewer.md'));
    const mcpExists = await exists(path.join(root, '.mcp.json'));
    const manifestExists = await exists(path.join(root, '.claude/.rac-install-manifest.json'));

    const result = await uninstall({ cwd: root, dryRun: true });

    // Changes should be populated
    expect(result.changes.length).toBeGreaterThan(0);

    // Filesystem should be unchanged
    await expect(exists(path.join(root, '.claude/agents/reviewer.md'))).resolves.toBe(agentExists);
    await expect(exists(path.join(root, '.mcp.json'))).resolves.toBe(mcpExists);
    await expect(exists(path.join(root, '.claude/.rac-install-manifest.json'))).resolves.toBe(manifestExists);
  });

  it('filter combo: install everything → uninstall targets=[opencode], kinds=[mcp] → only opencode mcp pruned', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['agent', 'skill', 'mcp', 'rule'] });

    const result = await uninstall({ cwd: root, targets: ['opencode'], kinds: ['mcp'] });

    // Only opencode mcp-related changes
    for (const change of result.changes) {
      if (change.action === 'delete-manifest') continue;
      expect(change.target === 'opencode').toBe(true);
    }

    // Claude and codex untouched
    await expect(exists(path.join(root, '.claude/agents/reviewer.md'))).resolves.toBe(true);
    await expect(exists(path.join(root, '.codex/agents/reviewer.toml'))).resolves.toBe(true);
    await expect(exists(path.join(root, '.mcp.json'))).resolves.toBe(true);

    // Opencode whole-file owned files (agents/skills) should remain
    // (We only uninstalled mcp kind)
    await expect(exists(path.join(root, '.opencode/agents/reviewer.md'))).resolves.toBe(true);
    await expect(exists(path.join(root, '.opencode/skills/project-gates/SKILL.md'))).resolves.toBe(true);

    // opencode mcp entries should be pruned from opencode.jsonc
    if (await exists(path.join(root, '.opencode/opencode.jsonc'))) {
      const oc = await readJsoncFile<{ mcp?: Record<string, unknown> }>(path.join(root, '.opencode/opencode.jsonc'));
      expect(oc.mcp).toBeUndefined();
    }
  });

  it('defensive guard: manifest with settings.json selector=$  takes surgical-prune NOT whole-file delete', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.claude'), { recursive: true });

    // Write some user content to settings.json
    const userSettings = { theme: 'dark', customKey: 'userValue' };
    await writeFile(path.join(root, '.claude/settings.json'), JSON.stringify(userSettings, null, 2) + '\n', 'utf8');

    // Synthetically write a manifest record with relPath='.claude/settings.json' and selector='$'
    // This is an invalid combination but the defensive guard should handle it.
    const claudeManifestRelPath = '.claude/.rac-install-manifest.json';
    await saveManifest(root, claudeManifestRelPath, {
      version: 1,
      records: [{
        version: 1,
        pack: 'test-pack',
        target: 'claude',
        kind: 'rule',
        id: 'test-rule',
        source: 'rules/test.toml',
        relPath: '.claude/settings.json',
        hash: 'abc123',
        inventory: [{ version: 1, format: 'json', selector: '$' }]
      }]
    });

    // Uninstall should NOT delete the file, should take surgical-prune path
    const result = await uninstall({ cwd: root, targets: ['claude'], kinds: ['rule'] });

    // The file should still exist
    await expect(exists(path.join(root, '.claude/settings.json'))).resolves.toBe(true);

    // Should NOT have a delete-file change for settings.json
    const deleteFileChanges = result.changes.filter((c) => c.action === 'delete-file' && 'relPath' in c && c.relPath === '.claude/settings.json');
    expect(deleteFileChanges.length).toBe(0);

    // Should have a prune-selector change
    const pruneChanges = result.changes.filter((c) => c.action === 'prune-selector');
    expect(pruneChanges.length).toBeGreaterThan(0);

    // User keys should survive
    const after = JSON.parse(await readFile(path.join(root, '.claude/settings.json'), 'utf8')) as Record<string, unknown>;
    expect(after.theme).toBe('dark');
    expect(after.customKey).toBe('userValue');
  });

  it('re-install idempotency: install → uninstall → install → final manifest equals first install manifest', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['claude', 'codex'], kinds: ['agent'] });

    // Read manifest after first install
    const manifestPath = path.join(root, '.claude/.rac-install-manifest.json');
    const firstManifest = await readFile(manifestPath, 'utf8');

    // Uninstall
    await uninstall({ cwd: root, targets: ['claude', 'codex'], kinds: ['agent'] });

    // Re-install
    await install({ cwd: root, targets: ['claude', 'codex'], kinds: ['agent'] });

    // Read manifest after second install
    const secondManifest = await readFile(manifestPath, 'utf8');

    expect(secondManifest).toBe(firstManifest);
  });

  it('RAC_HOME user-scope round-trip: install scope=user → uninstall scope=user → HOME-rooted files gone', async () => {
    const home = await makeTmp();
    const xdg = await makeTmp();
    const prevHome = process.env.RAC_HOME;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.RAC_HOME = home;
    process.env.XDG_CONFIG_HOME = xdg;

    try {
      await seed(home);
      await install({ cwd: process.cwd(), targets: ['claude', 'codex', 'opencode'], kinds: ['agent', 'mcp'], scope: 'user' });

      // Verify installed
      await expect(exists(path.join(home, '.claude/agents/reviewer.md'))).resolves.toBe(true);
      await expect(exists(path.join(home, '.codex/agents/reviewer.toml'))).resolves.toBe(true);
      await expect(exists(path.join(xdg, 'opencode/agents/reviewer.md'))).resolves.toBe(true);
      await expect(exists(path.join(home, '.claude.json'))).resolves.toBe(true);

      await uninstall({ cwd: process.cwd(), targets: ['claude', 'codex', 'opencode'], kinds: ['agent', 'mcp'], scope: 'user' });

      // Agents gone
      await expect(exists(path.join(home, '.claude/agents/reviewer.md'))).resolves.toBe(false);
      await expect(exists(path.join(home, '.codex/agents/reviewer.toml'))).resolves.toBe(false);
      await expect(exists(path.join(xdg, 'opencode/agents/reviewer.md'))).resolves.toBe(false);

      // Manifests gone
      await expect(exists(path.join(home, '.claude/.rac-install-manifest.json'))).resolves.toBe(false);
      await expect(exists(path.join(home, '.codex/.rac-install-manifest.json'))).resolves.toBe(false);
      await expect(exists(path.join(xdg, 'opencode/.rac-install-manifest.json'))).resolves.toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.RAC_HOME; else process.env.RAC_HOME = prevHome;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });

  it('changes array is sorted deterministically', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['agent', 'mcp'] });

    const result = await uninstall({ cwd: root, dryRun: true });

    // Verify sorted order: action then absPath then selector
    for (let i = 1; i < result.changes.length; i++) {
      const a = result.changes[i - 1];
      const b = result.changes[i];
      const absA = 'absPath' in a ? a.absPath : '';
      const absB = 'absPath' in b ? b.absPath : '';
      const selA = a.action === 'prune-selector' ? a.selector : '';
      const selB = b.action === 'prune-selector' ? b.selector : '';

      const cmp = a.action.localeCompare(b.action) !== 0
        ? a.action.localeCompare(b.action)
        : absA !== absB
          ? absA.localeCompare(absB)
          : selA.localeCompare(selB);
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  it('result arrays (deletedFiles, prunedSelectors, deletedManifests) are correctly populated', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['claude', 'codex'], kinds: ['agent', 'mcp', 'rule'] });

    const result = await uninstall({ cwd: root, targets: ['claude', 'codex'], kinds: ['agent', 'mcp', 'rule'] });

    // deletedFiles should contain the agent file absPath
    expect(result.deletedFiles.some((f) => f.includes('reviewer'))).toBe(true);

    // prunedSelectors should have entries for mcp and rule selectors
    expect(result.prunedSelectors.length).toBeGreaterThan(0);
    expect(result.prunedSelectors.every((ps) => typeof ps.absPath === 'string' && typeof ps.selector === 'string')).toBe(true);

    // deletedManifests should have paths
    expect(result.deletedManifests.length).toBeGreaterThan(0);
    expect(result.deletedManifests.every((m) => m.includes('.rac-install-manifest.json'))).toBe(true);
  });
});
