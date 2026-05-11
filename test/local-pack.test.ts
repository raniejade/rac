import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureLocalPack } from '../src/core/parsers.js';

import { cleanupTmpDirs, makeTmp } from './helpers.js';

afterEach(cleanupTmpDirs);

async function makeLocalPack(root: string): Promise<void> {
  await mkdir(path.join(root, '.rac'), { recursive: true });
  await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');
}

describe('ensureLocalPack', () => {
  const validSpec = { id: 'mypkg', repo: 'github:owner/repo', ref: 'main' };

  it('happy path: returns correct PackRuntime shape with override.path, sourceRepo, sourceRef', async () => {
    const projectDir = await makeTmp();
    const packDir = await makeTmp();
    await mkdir(path.join(projectDir, '.rac'), { recursive: true });
    await writeFile(path.join(projectDir, '.rac/config.toml'), '', 'utf8');
    await makeLocalPack(packDir);

    const projectRoot = path.join(projectDir, '.rac');
    const result = await ensureLocalPack(validSpec, packDir, projectRoot);

    expect(result.id).toBe('mypkg');
    expect(result.root).toBe(path.join(packDir, '.rac'));
    expect(result.sourceRepo).toBe('github:owner/repo');
    expect(result.sourceRef).toBe('main');
    expect(result.override).toEqual({ path: packDir });
  });

  it('relative overridePath resolves against project cwd (dir containing .rac/), not .rac/ itself', async () => {
    // Layout: /tmp/project/.rac/config.toml
    //         /tmp/pack/.rac/config.toml
    // We set overridePath = '../pack' relative to the project cwd /tmp/project
    const base = await makeTmp();
    const projectDir = path.join(base, 'project');
    const packDir = path.join(base, 'pack');
    await mkdir(path.join(projectDir, '.rac'), { recursive: true });
    await writeFile(path.join(projectDir, '.rac/config.toml'), '', 'utf8');
    await makeLocalPack(packDir);

    const projectRoot = path.join(projectDir, '.rac');
    // Relative path from projectDir to packDir is '../pack'
    const result = await ensureLocalPack(validSpec, '../pack', projectRoot);

    expect(result.override?.path).toBe(packDir);
    expect(result.root).toBe(path.join(packDir, '.rac'));
  });

  it('absolute overridePath passes through unchanged', async () => {
    const projectDir = await makeTmp();
    const packDir = await makeTmp();
    await mkdir(path.join(projectDir, '.rac'), { recursive: true });
    await writeFile(path.join(projectDir, '.rac/config.toml'), '', 'utf8');
    await makeLocalPack(packDir);

    const projectRoot = path.join(projectDir, '.rac');
    const result = await ensureLocalPack(validSpec, packDir, projectRoot);

    expect(result.override?.path).toBe(packDir);
  });

  it('missing path: error message contains both the pack id and the resolved absolute path', async () => {
    const projectDir = await makeTmp();
    await mkdir(path.join(projectDir, '.rac'), { recursive: true });
    await writeFile(path.join(projectDir, '.rac/config.toml'), '', 'utf8');

    const projectRoot = path.join(projectDir, '.rac');
    const missingPath = path.join(projectDir, 'no-such-dir');

    await expect(ensureLocalPack(validSpec, missingPath, projectRoot))
      .rejects.toThrow(new RegExp(`mypkg`));
    await expect(ensureLocalPack(validSpec, missingPath, projectRoot))
      .rejects.toThrow(new RegExp(missingPath.replace(/[/\\]/g, '.')));
  });

  it('path exists but .rac/config.toml is missing: error mentions pack id', async () => {
    const projectDir = await makeTmp();
    const packDir = await makeTmp(); // exists as a dir but has no .rac/config.toml
    await mkdir(path.join(projectDir, '.rac'), { recursive: true });
    await writeFile(path.join(projectDir, '.rac/config.toml'), '', 'utf8');

    const projectRoot = path.join(projectDir, '.rac');

    await expect(ensureLocalPack(validSpec, packDir, projectRoot))
      .rejects.toThrow(/mypkg/);
  });

  it('local pack whose .rac/config.toml contains [[packs]] is rejected', async () => {
    const projectDir = await makeTmp();
    const packDir = await makeTmp();
    await mkdir(path.join(projectDir, '.rac'), { recursive: true });
    await writeFile(path.join(projectDir, '.rac/config.toml'), '', 'utf8');
    await mkdir(path.join(packDir, '.rac'), { recursive: true });
    // Local pack config contains [[packs]] — should be rejected
    await writeFile(
      path.join(packDir, '.rac/config.toml'),
      '[[packs]]\nid = "nested"\nrepo = "github:owner/nested"\nref = "main"\n',
      'utf8'
    );

    const projectRoot = path.join(projectDir, '.rac');

    await expect(ensureLocalPack(validSpec, packDir, projectRoot))
      .rejects.toThrow(/shared pack config cannot contain \[\[packs\]\]/);
  });
});
