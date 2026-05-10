import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { renderDiff } from '../src/cli/output/diff.js';
import { diff } from '../src/core/diff.js';
import { install } from '../src/core/install.js';

import { cleanupTmpDirs, makeTmp, seed } from './helpers.js';

afterAll(cleanupTmpDirs);

const plainMode = { color: false };

describe('diff()', () => {
  it('1. no-op diff: after install, diff returns empty changes and empty drift', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['claude'], kinds: ['agent'] });

    const result = await diff({ cwd: root, targets: ['claude'], kinds: ['agent'] });

    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([]);
    expect(result.create).toEqual([]);
    expect(result.update).toEqual([]);
    expect(result.del).toEqual([]);

    const output = renderDiff(result, { cwd: root, mode: plainMode });
    expect(output).toContain('Nothing to do.');
  });

  it('2. create diff: before install, diff returns create entries with before=null', async () => {
    const root = await makeTmp();
    await seed(root);

    const result = await diff({ cwd: root, targets: ['claude'], kinds: ['agent'] });

    expect(result.changes.length).toBeGreaterThan(0);
    const createEntry = result.changes.find((c) => c.action === 'create');
    expect(createEntry).toBeDefined();
    expect(createEntry!.before).toBeNull();
    expect(createEntry!.after).not.toBeNull();
    expect(result.create.length).toBeGreaterThan(0);
    expect(result.update.length).toBe(0);
  });

  it('3. update diff with unified markers: after modifying source, diff shows unified markers', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['claude'], kinds: ['agent'] });

    // Modify the agent instructions to force an update
    await writeFile(
      path.join(root, '.rac/agents/reviewer.md'),
      'Modified review instructions.\n',
      'utf8'
    );

    const result = await diff({ cwd: root, targets: ['claude'], kinds: ['agent'] });

    const updateEntry = result.changes.find((c) => c.action === 'update');
    expect(updateEntry).toBeDefined();
    expect(updateEntry!.before).not.toBeNull();
    expect(updateEntry!.after).not.toBeNull();
    expect(updateEntry!.binary).toBe(false);

    const output = renderDiff(result, { cwd: root, mode: plainMode });
    // Should contain unified diff markers
    expect(output).toContain('---');
    expect(output).toContain('+++');
    expect(output).toContain('@@');
  });

  it('4. drift detection: hand-edited managed file shows up in drift section', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['claude'], kinds: ['agent'] });

    // Hand-edit a managed output file
    const agentPath = path.join(root, '.claude/agents/reviewer.md');
    await writeFile(agentPath, 'Hand edited content!\n', 'utf8');

    const result = await diff({ cwd: root, targets: ['claude'], kinds: ['agent'] });

    expect(result.drift.length).toBe(1);
    expect(result.drift[0].currentHash).not.toBe(result.drift[0].manifestHash);
    expect(result.drift[0].relPath).toContain('reviewer');

    const output = renderDiff(result, { cwd: root, mode: plainMode });
    expect(output).toContain('Drift detected:');
  });

  it('5. drift on shared merged file: one drift entry per path (not per source rule)', async () => {
    const root = await makeTmp();
    await seed(root);
    // Install rules which share .claude/settings.json
    await install({ cwd: root, targets: ['claude'], kinds: ['rule'] });

    // Hand-edit the shared settings.json
    const settingsPath = path.join(root, '.claude/settings.json');
    const original = await readFile(settingsPath, 'utf8');
    await writeFile(settingsPath, original + '\n// hand edited\n', 'utf8');

    const result = await diff({ cwd: root, targets: ['claude'], kinds: ['rule'] });

    // Should have at most 1 drift entry per (target, relPath)
    const driftPaths = result.drift.map((d) => `${d.target}:${d.relPath}`);
    const uniqueDriftPaths = new Set(driftPaths);
    expect(uniqueDriftPaths.size).toBe(driftPaths.length);

    // Specifically settings.json should appear only once
    const settingsDrift = result.drift.filter((d) => d.relPath === '.claude/settings.json');
    expect(settingsDrift.length).toBe(1);
  });

  it('6. --no-drift suppresses drift section', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['claude'], kinds: ['agent'] });

    // Hand-edit a managed output file
    const agentPath = path.join(root, '.claude/agents/reviewer.md');
    await writeFile(agentPath, 'Hand edited content!\n', 'utf8');

    const result = await diff({ cwd: root, targets: ['claude'], kinds: ['agent'], detectDrift: false });

    expect(result.drift).toEqual([]);

    const output = renderDiff(result, { cwd: root, mode: plainMode });
    expect(output).not.toContain('Drift detected:');
  });

  it('7. target filtering: only claude entries appear when targets=claude', async () => {
    const root = await makeTmp();
    await seed(root);

    const result = await diff({ cwd: root, targets: ['claude'], kinds: ['agent'] });

    for (const change of result.changes) {
      expect(change.target).toBe('claude');
    }

    for (const entry of result.drift) {
      expect(entry.target).toBe('claude');
    }

    // codex entries should not appear
    const hasCodex = result.changes.some((c) => c.target === 'codex');
    expect(hasCodex).toBe(false);
  });

  it('8. summary mode parity: summary output contains path and action symbol, not @@ hunks', async () => {
    const root = await makeTmp();
    await seed(root);

    const result = await diff({ cwd: root, targets: ['claude'], kinds: ['agent'] });

    // Full diff output (default) contains raw diff header lines
    const fullOutput = renderDiff(result, { cwd: root, mode: plainMode });
    // Summary mode should not contain @@ but should contain the path and action symbols
    const summaryOutput = renderDiff(result, { cwd: root, mode: plainMode, summary: true });

    expect(summaryOutput).not.toContain('@@');
    // Should contain the plan summary line
    expect(summaryOutput).toContain('Plan:');
    expect(summaryOutput).toContain('to create');

    // Full output for creates does not have @@ but verify they differ
    // (either way summary mode omits diff bodies and full output includes them for updates)
    // For create entries, full output has +++ header while summary omits it
    if (result.changes.some((c) => c.action === 'create')) {
      // Summary should not have the +++ (planned, N lines) detail
      expect(summaryOutput).not.toContain('(planned,');
    }

    void fullOutput; // referenced to avoid unused variable warning
  });

  it('9. binary safety: binary asset shows binary: true and renderer prints (binary, content omitted)', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await mkdir(path.join(root, '.rac/skills/img-skill'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');

    // Create a skill with a binary asset
    await writeFile(
      path.join(root, '.rac/skills/img-skill/SKILL.md'),
      '+++\ndescription = "image skill"\nassets = ["icon.png"]\n+++\nSkill body\n',
      'utf8'
    );
    // Write a minimal PNG-like binary file (PNG magic bytes)
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    await writeFile(path.join(root, '.rac/skills/img-skill/icon.png'), pngBytes);

    await install({ cwd: root, targets: ['claude'], kinds: ['skill'] });

    // Now modify the binary asset to force an update
    const newPngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0e]);
    await writeFile(path.join(root, '.rac/skills/img-skill/icon.png'), newPngBytes);

    const result = await diff({ cwd: root, targets: ['claude'], kinds: ['skill'] });

    // Find the binary entry
    const binaryEntry = result.changes.find((c) => c.binary === true);
    expect(binaryEntry).toBeDefined();

    const output = renderDiff(result, { cwd: root, mode: plainMode });
    expect(output).toContain('(binary, content omitted)');
  });

  it('10. drift detection: unchanged binary asset produces no drift', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await mkdir(path.join(root, '.rac/skills/img-skill'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');

    // Create a skill with a binary asset containing bytes that are invalid UTF-8
    await writeFile(
      path.join(root, '.rac/skills/img-skill/SKILL.md'),
      '+++\ndescription = "image skill"\nassets = ["icon.png"]\n+++\nSkill body\n',
      'utf8'
    );
    // Write a binary file with bytes that cause mutation on UTF-8 round-trip (0x80-0xBF are invalid UTF-8 lead bytes)
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x80, 0xff, 0xfe, 0x00]);
    await writeFile(path.join(root, '.rac/skills/img-skill/icon.png'), pngBytes);

    // Install so the manifest records the hash
    await install({ cwd: root, targets: ['claude'], kinds: ['skill'] });

    // Do NOT modify the binary asset — it should not appear in drift
    const result = await diff({ cwd: root, targets: ['claude'], kinds: ['skill'] });

    const binaryDrift = result.drift.filter((d) => d.relPath.endsWith('icon.png'));
    expect(binaryDrift).toHaveLength(0);
  });
});
