import { afterAll, describe, expect, it } from 'vitest';

import { install } from '../src/core/install.js';

import { cleanupTmpDirs, makeTmp, runCliInProcess, seed } from './helpers.js';

afterAll(cleanupTmpDirs);

describe('rac diff CLI', () => {
  it('rac diff --help: exits 0 and lists expected flags', async () => {
    const root = await makeTmp();
    const result = await runCliInProcess(root, ['diff', '--help']);

    expect(result.status).toBe(0);
    // Verify all 7 documented flags appear in help output
    expect(result.stdout).toContain('--targets');
    expect(result.stdout).toContain('--kind');
    expect(result.stdout).toContain('--scope');
    expect(result.stdout).toContain('--refresh-packs');
    expect(result.stdout).toContain('--no-merge');
    expect(result.stdout).toContain('--summary');
    expect(result.stdout).toContain('--no-drift');
  });

  it('rac diff in seeded fixture: exits 0 with non-empty output', async () => {
    const root = await makeTmp();
    await seed(root);

    const result = await runCliInProcess(root, ['diff', '--plain']);

    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    // Should contain the plan summary line indicating some changes
    expect(result.stdout).toContain('Plan:');
  });

  it('rac install --dry-run in seeded fixture (post-install with changes): output contains @@ hunk markers', async () => {
    const root = await makeTmp();
    await seed(root);
    // First install agents
    await install({ cwd: root, targets: ['claude'], kinds: ['agent'] });

    // Write a new agent to force changes
    const path = await import('node:path');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path.join(root, '.rac/agents/reviewer.md'),
      'Modified review instructions for dry-run test.\n',
      'utf8'
    );

    const result = await runCliInProcess(root, ['install', '--dry-run', '--targets', 'claude', '--kind', 'agent', '--plain']);

    expect(result.status).toBe(0);
    // The output should contain unified diff markers since there are changes
    expect(result.stdout).toContain('@@');
  });
});
