import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { deleteManifest, loadManifest, saveManifest } from '../src/core/manifest.js';

import { cleanupTmpDirs, makeTmp } from './helpers.js';

afterEach(cleanupTmpDirs);

describe('manifest', () => {
  it('missing file returns empty manifest', async () => {
    const root = await makeTmp();
    const result = await loadManifest(root, 'rac-manifest.json');
    expect(result).toEqual({ version: 1, records: [] });
  });

  it('round-trip: saveManifest then loadManifest preserves all fields', async () => {
    const root = await makeTmp();
    const manifest = {
      version: 1 as const,
      records: [
        {
          version: 1 as const,
          pack: 'project',
          target: 'claude' as const,
          kind: 'agent' as const,
          id: 'reviewer',
          source: 'agents/reviewer.toml',
          relPath: '.claude/agents/reviewer.md',
          hash: 'abc123',
          inventory: [
            {
              version: 1 as const,
              format: 'file' as const,
              selector: '$["reviewer"]',
              entries: ['entry1']
            }
          ]
        }
      ]
    };

    await saveManifest(root, 'rac-manifest.json', manifest);
    const loaded = await loadManifest(root, 'rac-manifest.json');
    expect(loaded).toEqual(manifest);
    expect(loaded.records[0].pack).toBe('project');
    expect(loaded.records[0].inventory[0].entries).toEqual(['entry1']);
  });

  it('Zod rejects version: 2', async () => {
    const root = await makeTmp();
    await writeFile(path.join(root, 'bad.json'), JSON.stringify({ version: 2, records: [] }), 'utf8');
    await expect(loadManifest(root, 'bad.json')).rejects.toThrow();
  });

  it('Zod rejects target: cursor', async () => {
    const root = await makeTmp();
    const bad = {
      version: 1,
      records: [
        {
          version: 1,
          pack: 'p',
          target: 'cursor',
          kind: 'agent',
          id: 'x',
          source: 'agents/x.toml',
          relPath: '.claude/agents/x.md',
          hash: 'abc',
          inventory: []
        }
      ]
    };
    await writeFile(path.join(root, 'bad.json'), JSON.stringify(bad), 'utf8');
    await expect(loadManifest(root, 'bad.json')).rejects.toThrow();
  });

  it('Zod rejects kind: plugin', async () => {
    const root = await makeTmp();
    const bad = {
      version: 1,
      records: [
        {
          version: 1,
          pack: 'p',
          target: 'claude',
          kind: 'plugin',
          id: 'x',
          source: 'agents/x.toml',
          relPath: '.claude/agents/x.md',
          hash: 'abc',
          inventory: []
        }
      ]
    };
    await writeFile(path.join(root, 'bad.json'), JSON.stringify(bad), 'utf8');
    await expect(loadManifest(root, 'bad.json')).rejects.toThrow();
  });

  it('Zod rejects missing hash', async () => {
    const root = await makeTmp();
    const bad = {
      version: 1,
      records: [
        {
          version: 1,
          pack: 'p',
          target: 'claude',
          kind: 'agent',
          id: 'x',
          source: 'agents/x.toml',
          relPath: '.claude/agents/x.md',
          inventory: []
        }
      ]
    };
    await writeFile(path.join(root, 'bad.json'), JSON.stringify(bad), 'utf8');
    await expect(loadManifest(root, 'bad.json')).rejects.toThrow();
  });

  it('Zod rejects inventory format: xml', async () => {
    const root = await makeTmp();
    const bad = {
      version: 1,
      records: [
        {
          version: 1,
          pack: 'p',
          target: 'claude',
          kind: 'agent',
          id: 'x',
          source: 'agents/x.toml',
          relPath: '.claude/agents/x.md',
          hash: 'abc',
          inventory: [
            { version: 1, format: 'xml', selector: '$["x"]' }
          ]
        }
      ]
    };
    await writeFile(path.join(root, 'bad.json'), JSON.stringify(bad), 'utf8');
    await expect(loadManifest(root, 'bad.json')).rejects.toThrow();
  });

  it('rejects relPath with path traversal', async () => {
    const root = await makeTmp();
    const bad = {
      version: 1,
      records: [
        {
          version: 1,
          pack: 'p',
          target: 'claude',
          kind: 'agent',
          id: 'x',
          source: 'agents/x.toml',
          relPath: '../escape',
          hash: 'abc',
          inventory: []
        }
      ]
    };
    await writeFile(path.join(root, 'bad.json'), JSON.stringify(bad), 'utf8');
    await expect(loadManifest(root, 'bad.json')).rejects.toThrow();
  });

  it('deleteManifest on absent file is a no-op', async () => {
    const root = await makeTmp();
    await expect(deleteManifest(root, 'nonexistent.json')).resolves.not.toThrow();
  });
});
