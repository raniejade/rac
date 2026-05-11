import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadPackOverrides } from '../src/core/parsers.js';

import { cleanupTmpDirs, makeTmp } from './helpers.js';

afterEach(cleanupTmpDirs);

async function makeProjectRoot(): Promise<string> {
  const tmp = await makeTmp();
  const racDir = path.join(tmp, '.rac');
  await mkdir(racDir, { recursive: true });
  return racDir;
}

async function writeLocalConfig(projectRoot: string, content: string): Promise<void> {
  await writeFile(path.join(projectRoot, 'config.local.toml'), content, 'utf8');
}

describe('loadPackOverrides', () => {
  it('missing file returns empty array', async () => {
    const projectRoot = await makeProjectRoot();
    const result = await loadPackOverrides(projectRoot);
    expect(result).toEqual([]);
  });

  it('file with no pack_overrides key returns empty array', async () => {
    const projectRoot = await makeProjectRoot();
    await writeLocalConfig(projectRoot, '');
    const result = await loadPackOverrides(projectRoot);
    expect(result).toEqual([]);
  });

  it('empty pack_overrides array returns empty array', async () => {
    const projectRoot = await makeProjectRoot();
    await writeLocalConfig(projectRoot, 'pack_overrides = []\n');
    const result = await loadPackOverrides(projectRoot);
    expect(result).toEqual([]);
  });

  it('valid single entry is parsed correctly', async () => {
    const projectRoot = await makeProjectRoot();
    await writeLocalConfig(projectRoot, '[[pack_overrides]]\nid = "my-pack"\npath = "../my-pack"\n');
    const result = await loadPackOverrides(projectRoot);
    expect(result).toEqual([{ id: 'my-pack', path: '../my-pack' }]);
  });

  it('valid multiple entries are preserved in order', async () => {
    const projectRoot = await makeProjectRoot();
    await writeLocalConfig(
      projectRoot,
      '[[pack_overrides]]\nid = "alpha"\npath = "../alpha"\n\n[[pack_overrides]]\nid = "beta"\npath = "/abs/beta"\n'
    );
    const result = await loadPackOverrides(projectRoot);
    expect(result).toEqual([
      { id: 'alpha', path: '../alpha' },
      { id: 'beta', path: '/abs/beta' },
    ]);
  });

  it('duplicate ids throws with id mentioned', async () => {
    const projectRoot = await makeProjectRoot();
    await writeLocalConfig(
      projectRoot,
      '[[pack_overrides]]\nid = "alpha"\npath = "../alpha"\n\n[[pack_overrides]]\nid = "alpha"\npath = "../alpha2"\n'
    );
    await expect(loadPackOverrides(projectRoot)).rejects.toThrow('duplicate pack_overrides id: alpha');
  });

  it('id = "project" throws with reserved message', async () => {
    const projectRoot = await makeProjectRoot();
    await writeLocalConfig(projectRoot, '[[pack_overrides]]\nid = "project"\npath = "../some-pack"\n');
    await expect(loadPackOverrides(projectRoot)).rejects.toThrow('reserved');
  });

  it('bad id charset throws with invalid pack id message', async () => {
    const projectRoot = await makeProjectRoot();
    await writeLocalConfig(projectRoot, '[[pack_overrides]]\nid = "bad id"\npath = "../some-pack"\n');
    await expect(loadPackOverrides(projectRoot)).rejects.toThrow('invalid pack id');
  });

  it('missing id field throws', async () => {
    const projectRoot = await makeProjectRoot();
    await writeLocalConfig(projectRoot, '[[pack_overrides]]\npath = "../some-pack"\n');
    await expect(loadPackOverrides(projectRoot)).rejects.toThrow('missing pack_overrides.id');
  });

  it('missing path field throws', async () => {
    const projectRoot = await makeProjectRoot();
    await writeLocalConfig(projectRoot, '[[pack_overrides]]\nid = "my-pack"\n');
    await expect(loadPackOverrides(projectRoot)).rejects.toThrow('missing pack_overrides.path');
  });

  it('empty path throws', async () => {
    const projectRoot = await makeProjectRoot();
    await writeLocalConfig(projectRoot, '[[pack_overrides]]\nid = "my-pack"\npath = ""\n');
    await expect(loadPackOverrides(projectRoot)).rejects.toThrow('non-empty string');
  });

  it('path containing NUL bytes is rejected by TOML parser', async () => {
    const projectRoot = await makeProjectRoot();
    await writeFile(
      path.join(projectRoot, 'config.local.toml'),
      Buffer.from('[[pack_overrides]]\nid = "my-pack"\npath = "../foo\x00bar"\n', 'utf8')
    );
    await expect(loadPackOverrides(projectRoot)).rejects.toThrow(/control characters|invalid TOML/i);
  });

  it('unknown top-level key throws naming the key', async () => {
    const projectRoot = await makeProjectRoot();
    await writeLocalConfig(projectRoot, 'title = "x"\n');
    await expect(loadPackOverrides(projectRoot)).rejects.toThrow('"title"');
  });

  it('foreign [[packs]] section throws naming the section', async () => {
    const projectRoot = await makeProjectRoot();
    await writeLocalConfig(projectRoot, '[[packs]]\nid = "foo"\nrepo = "github:a/b"\nref = "main"\n');
    await expect(loadPackOverrides(projectRoot)).rejects.toThrow('"packs"');
  });

  it('foreign [install] section throws naming the section', async () => {
    const projectRoot = await makeProjectRoot();
    await writeLocalConfig(projectRoot, '[install]\nmerge = true\n');
    await expect(loadPackOverrides(projectRoot)).rejects.toThrow('"install"');
  });

  it('foreign [vendor.codex] section throws naming the section', async () => {
    const projectRoot = await makeProjectRoot();
    await writeLocalConfig(projectRoot, '[vendor.codex]\nsome_key = "val"\n');
    await expect(loadPackOverrides(projectRoot)).rejects.toThrow('"vendor"');
  });

  it('malformed TOML throws via parseTomlOrThrow path', async () => {
    const projectRoot = await makeProjectRoot();
    await writeLocalConfig(projectRoot, '[[pack_overrides\nid = "broken\n');
    await expect(loadPackOverrides(projectRoot)).rejects.toThrow('invalid TOML');
  });
});
