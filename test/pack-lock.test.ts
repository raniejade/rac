import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { findLockEntry, loadPackLock, writePackLock } from '../src/core/pack-lock.js';
import { FrozenLockfileError, resolvePacks, type GitRunner } from '../src/core/parsers.js';
import type { PackLockFile, PackSpec } from '../src/core/types.js';

import { cleanupTmpDirs, makeTmp } from './helpers.js';

afterEach(cleanupTmpDirs);

async function makeProjectRoot(): Promise<string> {
  const tmp = await makeTmp();
  const racDir = path.join(tmp, '.rac');
  await mkdir(racDir, { recursive: true });
  return racDir;
}

const sampleEntry = {
  id: 'alpha',
  repo: 'github:org/alpha',
  ref: 'main',
  resolved: 'a'.repeat(40),
};

const sampleLock: PackLockFile = {
  version: 1,
  packs: [sampleEntry],
};

describe('loadPackLock', () => {
  it('missing file returns null', async () => {
    const projectRoot = await makeProjectRoot();
    const result = await loadPackLock(projectRoot);
    expect(result).toBeNull();
  });

  it('malformed JSON throws with rac-lock.json is malformed: prefix', async () => {
    const projectRoot = await makeProjectRoot();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(projectRoot, 'rac-lock.json'), '{ bad json', 'utf8');
    await expect(loadPackLock(projectRoot)).rejects.toThrow(/^rac-lock\.json is malformed:/);
  });

  it('version 2 throws with unsupported version', async () => {
    const projectRoot = await makeProjectRoot();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path.join(projectRoot, 'rac-lock.json'),
      JSON.stringify({ version: 2, packs: [] }) + '\n',
      'utf8'
    );
    await expect(loadPackLock(projectRoot)).rejects.toThrow('unsupported version');
  });

  it('missing packs array throws', async () => {
    const projectRoot = await makeProjectRoot();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path.join(projectRoot, 'rac-lock.json'),
      JSON.stringify({ version: 1 }) + '\n',
      'utf8'
    );
    await expect(loadPackLock(projectRoot)).rejects.toThrow('packs must be an array');
  });

  it('entry missing resolved throws naming the field', async () => {
    const projectRoot = await makeProjectRoot();
    const { writeFile } = await import('node:fs/promises');
    const lock = {
      version: 1,
      packs: [{ id: 'alpha', repo: 'github:org/alpha', ref: 'main' }],
    };
    await writeFile(path.join(projectRoot, 'rac-lock.json'), JSON.stringify(lock) + '\n', 'utf8');
    await expect(loadPackLock(projectRoot)).rejects.toThrow('field resolved');
  });

  it('round-trip: write then load returns identical structure', async () => {
    const projectRoot = await makeProjectRoot();
    await writePackLock(projectRoot, sampleLock);
    const result = await loadPackLock(projectRoot);
    expect(result).toEqual(sampleLock);
  });
});

describe('writePackLock', () => {
  it('sorts packs alphabetically by id regardless of input order', async () => {
    const projectRoot = await makeProjectRoot();
    const lock: PackLockFile = {
      version: 1,
      packs: [
        { id: 'zeta', repo: 'github:org/zeta', ref: 'main', resolved: 'z'.repeat(40) },
        { id: 'alpha', repo: 'github:org/alpha', ref: 'main', resolved: 'a'.repeat(40) },
        { id: 'beta', repo: 'github:org/beta', ref: 'main', resolved: 'b'.repeat(40) },
      ],
    };
    await writePackLock(projectRoot, lock);
    const raw = await readFile(path.join(projectRoot, 'rac-lock.json'), 'utf8');
    const alphaPos = raw.indexOf('"alpha"');
    const betaPos = raw.indexOf('"beta"');
    const zetaPos = raw.indexOf('"zeta"');
    expect(alphaPos).toBeLessThan(betaPos);
    expect(betaPos).toBeLessThan(zetaPos);
  });

  it('does not mutate the input lock', async () => {
    const projectRoot = await makeProjectRoot();
    const lock: PackLockFile = {
      version: 1,
      packs: [
        { id: 'zeta', repo: 'github:org/zeta', ref: 'main', resolved: 'z'.repeat(40) },
        { id: 'alpha', repo: 'github:org/alpha', ref: 'main', resolved: 'a'.repeat(40) },
      ],
    };
    const originalOrder = lock.packs.map((p) => p.id);
    await writePackLock(projectRoot, lock);
    expect(lock.packs.map((p) => p.id)).toEqual(originalOrder);
  });

  it('outputs trailing newline', async () => {
    const projectRoot = await makeProjectRoot();
    await writePackLock(projectRoot, sampleLock);
    const raw = await readFile(path.join(projectRoot, 'rac-lock.json'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
  });
});

describe('findLockEntry', () => {
  it('returns undefined when lock is null', () => {
    const spec: PackSpec = { id: 'alpha', repo: 'github:org/alpha', ref: 'main' };
    expect(findLockEntry(null, spec)).toBeUndefined();
  });

  it('matches on (id, repo, ref)', () => {
    const spec: PackSpec = { id: 'alpha', repo: 'github:org/alpha', ref: 'main' };
    const result = findLockEntry(sampleLock, spec);
    expect(result).toEqual(sampleEntry);
  });

  it('mismatched ref is a miss', () => {
    const spec: PackSpec = { id: 'alpha', repo: 'github:org/alpha', ref: 'v2' };
    expect(findLockEntry(sampleLock, spec)).toBeUndefined();
  });

  it('mismatched repo is a miss', () => {
    const spec: PackSpec = { id: 'alpha', repo: 'github:org/other', ref: 'main' };
    expect(findLockEntry(sampleLock, spec)).toBeUndefined();
  });

  it('mismatched id is a miss', () => {
    const spec: PackSpec = { id: 'beta', repo: 'github:org/alpha', ref: 'main' };
    expect(findLockEntry(sampleLock, spec)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolvePacks lockfile integration tests
// ---------------------------------------------------------------------------

/**
 * Build a GitRunner that maps "args.join(' ')" → stdout string.
 * Any unrecognised command returns stdout: ''.
 * Exposes `calls` array for assertion.
 */
function makeRunner(stdouts: Record<string, string> = {}): GitRunner & { calls: { args: string[]; cwd?: string }[] } {
  const calls: { args: string[]; cwd?: string }[] = [];
  const runner = vi.fn(async (args: string[], cwd?: string) => {
    calls.push({ args, cwd });
    const key = args.join(' ');
    return { stdout: stdouts[key] ?? '' };
  }) as unknown as GitRunner & { calls: { args: string[]; cwd?: string }[] };
  (runner as unknown as { calls: typeof calls }).calls = calls;
  return runner;
}

/**
 * Set up a minimal project with a .rac/config.toml listing one shared pack,
 * and a matching fake cache entry so ensureSharedPack can finish without a
 * real git clone.
 *
 * Returns { project, cacheDir, repoDir }.
 */
async function makePackProject(opts: {
  packId?: string;
  repo?: string;
  ref?: string;
} = {}): Promise<{ project: string; cacheDir: string; repoDir: string }> {
  const packId = opts.packId ?? 'alpha';
  const repo = opts.repo ?? 'github:owner/alpha';
  const ref = opts.ref ?? 'main';

  const project = await makeTmp();
  const cacheDir = await makeTmp();

  await mkdir(path.join(project, '.rac'), { recursive: true });
  await writeFile(
    path.join(project, '.rac/config.toml'),
    `[[packs]]\nid = "${packId}"\nrepo = "${repo}"\nref = "${ref}"\n`,
    'utf8'
  );

  // Build the fake cache entry keyed the same way ensureSharedPack does
  const key = `${repo}@${ref}`;
  const keyHash = Buffer.from(key).toString('base64url');
  const repoDir = path.join(cacheDir, 'packs', keyHash);
  await mkdir(path.join(repoDir, '.git'), { recursive: true });
  await mkdir(path.join(repoDir, '.rac'), { recursive: true });
  await writeFile(path.join(repoDir, '.rac/config.toml'), '', 'utf8');

  return { project, cacheDir, repoDir };
}

describe('resolvePacks lockfile integration', () => {
  it('first install: no lockfile → resolving mode; lockfile written with captured SHA', async () => {
    const { project, cacheDir } = await makePackProject();
    const origCache = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    try {
      const expectedSha = 'a'.repeat(40);
      const runner = makeRunner({ 'rev-parse HEAD': `${expectedSha}\n` });

      await resolvePacks(project, { gitRunner: runner });

      // rev-parse should have been called (resolving mode)
      const revParseCalls = runner.calls.filter((c) => c.args[0] === 'rev-parse');
      expect(revParseCalls.length).toBeGreaterThan(0);

      // Lockfile should have been written
      const lock = await loadPackLock(path.join(project, '.rac'));
      expect(lock).not.toBeNull();
      expect(lock!.packs).toHaveLength(1);
      expect(lock!.packs[0].id).toBe('alpha');
      expect(lock!.packs[0].resolved).toBe(expectedSha);
    } finally {
      process.env.RAC_CACHE_DIR = origCache;
    }
  });

  it('second install: lockfile exists → locked mode; no FETCH_HEAD, no lockfile rewrite', async () => {
    const { project, cacheDir } = await makePackProject();
    const origCache = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    const lockedSha = 'b'.repeat(40);

    try {
      // Pre-write a lockfile
      await writePackLock(path.join(project, '.rac'), {
        version: 1,
        packs: [{ id: 'alpha', repo: 'github:owner/alpha', ref: 'main', resolved: lockedSha }],
      });

      const lockMtimeBefore = (await stat(path.join(project, '.rac', 'rac-lock.json'))).mtimeMs;

      const runner = makeRunner({});

      await resolvePacks(project, { gitRunner: runner });

      // FETCH_HEAD should NOT have been referenced
      const fetchHeadCalls = runner.calls.filter((c) => c.args.includes('FETCH_HEAD'));
      expect(fetchHeadCalls).toHaveLength(0);

      // rev-parse should NOT have been called
      const revParseCalls = runner.calls.filter((c) => c.args[0] === 'rev-parse');
      expect(revParseCalls).toHaveLength(0);

      // fetch should use the locked SHA, not the ref
      const fetchCalls = runner.calls.filter((c) => c.args[0] === 'fetch');
      expect(fetchCalls.length).toBeGreaterThan(0);
      expect(fetchCalls[0].args).toContain(lockedSha);

      // Lock file should NOT have been rewritten (mtime unchanged)
      const lockMtimeAfter = (await stat(path.join(project, '.rac', 'rac-lock.json'))).mtimeMs;
      expect(lockMtimeAfter).toBe(lockMtimeBefore);
    } finally {
      process.env.RAC_CACHE_DIR = origCache;
    }
  });

  it('refresh:true → resolving mode; lockfile rewritten with new SHA', async () => {
    const { project, cacheDir } = await makePackProject();
    const origCache = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    const oldSha = 'c'.repeat(40);
    const newSha = 'd'.repeat(40);

    try {
      // Pre-write a lockfile with oldSha
      await writePackLock(path.join(project, '.rac'), {
        version: 1,
        packs: [{ id: 'alpha', repo: 'github:owner/alpha', ref: 'main', resolved: oldSha }],
      });

      // With refresh:true the cache is wiped then clone is called; recreate structure on clone
      const key = 'github:owner/alpha@main';
      const keyHash = Buffer.from(key).toString('base64url');
      const repoDir = path.join(cacheDir, 'packs', keyHash);

      const calls: { args: string[]; cwd?: string }[] = [];
      const runner = vi.fn(async (args: string[], cwd?: string) => {
        calls.push({ args, cwd });
        if (args[0] === 'clone') {
          const target = args[2];
          await mkdir(path.join(target, '.git'), { recursive: true });
          await mkdir(path.join(target, '.rac'), { recursive: true });
          await writeFile(path.join(target, '.rac/config.toml'), '', 'utf8');
        }
        if (args[0] === 'rev-parse') return { stdout: `${newSha}\n` };
        return { stdout: '' };
      }) as unknown as GitRunner;
      (runner as unknown as { calls: typeof calls }).calls = calls;

      await resolvePacks(project, { gitRunner: runner, refresh: true });

      // Lockfile should now contain the new SHA
      const lock = await loadPackLock(path.join(project, '.rac'));
      expect(lock!.packs[0].resolved).toBe(newSha);

      // Suppress unused variable lint
      void repoDir;
    } finally {
      process.env.RAC_CACHE_DIR = origCache;
    }
  });

  it('frozen:true with empty lockfile: throws FrozenLockfileError naming the pack', async () => {
    const { project, cacheDir } = await makePackProject();
    const origCache = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    try {
      const runner = makeRunner({ 'rev-parse HEAD': `${'e'.repeat(40)}\n` });

      await expect(
        resolvePacks(project, { gitRunner: runner, frozen: true })
      ).rejects.toThrow(FrozenLockfileError);

      await expect(
        resolvePacks(project, { gitRunner: runner, frozen: true })
      ).rejects.toThrow(/no lockfile entry/);

      await expect(
        resolvePacks(project, { gitRunner: runner, frozen: true })
      ).rejects.toThrow(/alpha/);
    } finally {
      process.env.RAC_CACHE_DIR = origCache;
    }
  });

  it('frozen:true with matching lockfile: succeeds; no writePackLock call', async () => {
    const { project, cacheDir } = await makePackProject();
    const origCache = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    const lockedSha = 'f'.repeat(40);

    try {
      await writePackLock(path.join(project, '.rac'), {
        version: 1,
        packs: [{ id: 'alpha', repo: 'github:owner/alpha', ref: 'main', resolved: lockedSha }],
      });

      const lockMtimeBefore = (await stat(path.join(project, '.rac', 'rac-lock.json'))).mtimeMs;

      const runner = makeRunner({});

      // Should not throw
      await expect(
        resolvePacks(project, { gitRunner: runner, frozen: true })
      ).resolves.toBeDefined();

      // Lockfile not rewritten
      const lockMtimeAfter = (await stat(path.join(project, '.rac', 'rac-lock.json'))).mtimeMs;
      expect(lockMtimeAfter).toBe(lockMtimeBefore);
    } finally {
      process.env.RAC_CACHE_DIR = origCache;
    }
  });

  it('pack override active: overridden pack absent from lockfile after write', async () => {
    const project = await makeTmp();
    const cacheDir = await makeTmp();
    const packOverrideDir = await makeTmp();

    // Set up the overridden pack directory
    await mkdir(path.join(packOverrideDir, '.rac'), { recursive: true });
    await writeFile(path.join(packOverrideDir, '.rac/config.toml'), '', 'utf8');

    const origCache = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    try {
      // config.toml: one shared pack "alpha" + one overridden pack "beta"
      // We only have beta in the overrides, alpha needs a cache entry
      await mkdir(path.join(project, '.rac'), { recursive: true });
      await writeFile(
        path.join(project, '.rac/config.toml'),
        '[[packs]]\nid = "alpha"\nrepo = "github:owner/alpha"\nref = "main"\n\n[[packs]]\nid = "beta"\nrepo = "github:owner/beta"\nref = "v1"\n',
        'utf8'
      );
      await writeFile(
        path.join(project, '.rac/config.local.toml'),
        `[[pack_overrides]]\nid = "beta"\npath = ${JSON.stringify(packOverrideDir)}\n`,
        'utf8'
      );

      // Make fake cache entry for alpha only
      const key = 'github:owner/alpha@main';
      const keyHash = Buffer.from(key).toString('base64url');
      const repoDir = path.join(cacheDir, 'packs', keyHash);
      await mkdir(path.join(repoDir, '.git'), { recursive: true });
      await mkdir(path.join(repoDir, '.rac'), { recursive: true });
      await writeFile(path.join(repoDir, '.rac/config.toml'), '', 'utf8');

      const alphaSha = '0'.repeat(40);
      const runner = makeRunner({ 'rev-parse HEAD': `${alphaSha}\n` });

      await resolvePacks(project, { gitRunner: runner });

      // Lockfile should only contain alpha (beta is overridden)
      const lock = await loadPackLock(path.join(project, '.rac'));
      expect(lock).not.toBeNull();
      expect(lock!.packs.map((p) => p.id)).toEqual(['alpha']);
      expect(lock!.packs.find((p) => p.id === 'beta')).toBeUndefined();
    } finally {
      process.env.RAC_CACHE_DIR = origCache;
    }
  });

  it('ref changed in config: lock miss → re-resolves, old entry replaced', async () => {
    const project = await makeTmp();
    const cacheDir = await makeTmp();
    const origCache = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    try {
      // Start with ref = "v1" locked
      await mkdir(path.join(project, '.rac'), { recursive: true });
      await writeFile(
        path.join(project, '.rac/config.toml'),
        '[[packs]]\nid = "alpha"\nrepo = "github:owner/alpha"\nref = "v2"\n',
        'utf8'
      );
      // Lockfile has old ref = "v1"
      await writePackLock(path.join(project, '.rac'), {
        version: 1,
        packs: [{ id: 'alpha', repo: 'github:owner/alpha', ref: 'v1', resolved: '1'.repeat(40) }],
      });

      // Set up fake cache for the new ref
      const key = 'github:owner/alpha@v2';
      const keyHash = Buffer.from(key).toString('base64url');
      const repoDir = path.join(cacheDir, 'packs', keyHash);
      await mkdir(path.join(repoDir, '.git'), { recursive: true });
      await mkdir(path.join(repoDir, '.rac'), { recursive: true });
      await writeFile(path.join(repoDir, '.rac/config.toml'), '', 'utf8');

      const newSha = '2'.repeat(40);
      const runner = makeRunner({ 'rev-parse HEAD': `${newSha}\n` });

      await resolvePacks(project, { gitRunner: runner });

      // Lockfile should now have v2 entry, old v1 entry gone
      const lock = await loadPackLock(path.join(project, '.rac'));
      expect(lock!.packs).toHaveLength(1);
      expect(lock!.packs[0].ref).toBe('v2');
      expect(lock!.packs[0].resolved).toBe(newSha);
    } finally {
      process.env.RAC_CACHE_DIR = origCache;
    }
  });

  it('drifted entry with frozen:true: throws FrozenLockfileError mentioning is locked to, has moved upstream, and pack id', async () => {
    const { project, cacheDir } = await makePackProject();
    const origCache = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    const oldSha = 'a'.repeat(40);
    const newSha = 'b'.repeat(40);

    try {
      // Pre-write a lockfile with oldSha
      await writePackLock(path.join(project, '.rac'), {
        version: 1,
        packs: [{ id: 'alpha', repo: 'github:owner/alpha', ref: 'main', resolved: oldSha }],
      });

      // refresh:true wipes the cache; clone must recreate it so loadSharedPackConfig can succeed
      const key = 'github:owner/alpha@main';
      const keyHash = Buffer.from(key).toString('base64url');
      const repoDir = path.join(cacheDir, 'packs', keyHash);

      const makeRunner = (): GitRunner => {
        const calls: { args: string[]; cwd?: string }[] = [];
        return vi.fn(async (args: string[], cwd?: string) => {
          calls.push({ args, cwd });
          if (args[0] === 'clone') {
            const target = args[2];
            await mkdir(path.join(target, '.git'), { recursive: true });
            await mkdir(path.join(target, '.rac'), { recursive: true });
            await writeFile(path.join(target, '.rac/config.toml'), '', 'utf8');
          }
          if (args[0] === 'rev-parse') return { stdout: `${newSha}\n` };
          return { stdout: '' };
        }) as unknown as GitRunner;
      };

      await expect(
        resolvePacks(project, { gitRunner: makeRunner(), refresh: true, frozen: true })
      ).rejects.toThrow(FrozenLockfileError);

      await expect(
        resolvePacks(project, { gitRunner: makeRunner(), refresh: true, frozen: true })
      ).rejects.toThrow(/is locked to/);

      await expect(
        resolvePacks(project, { gitRunner: makeRunner(), refresh: true, frozen: true })
      ).rejects.toThrow(/has moved upstream/);

      await expect(
        resolvePacks(project, { gitRunner: makeRunner(), refresh: true, frozen: true })
      ).rejects.toThrow(/alpha/);

      // Suppress unused variable lint
      void repoDir;
    } finally {
      process.env.RAC_CACHE_DIR = origCache;
    }
  });

  it('frozen:true with stale-only change: does not throw and does not write lockfile', async () => {
    const project = await makeTmp();
    const cacheDir = await makeTmp();
    const origCache = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    try {
      // config.toml has only pack X; lockfile has both X and Y (Y is stale)
      await mkdir(path.join(project, '.rac'), { recursive: true });
      await writeFile(
        path.join(project, '.rac/config.toml'),
        '[[packs]]\nid = "x"\nrepo = "github:owner/x"\nref = "main"\n',
        'utf8'
      );

      const xSha = 'c'.repeat(40);
      const ySha = 'd'.repeat(40);

      await writePackLock(path.join(project, '.rac'), {
        version: 1,
        packs: [
          { id: 'x', repo: 'github:owner/x', ref: 'main', resolved: xSha },
          { id: 'y', repo: 'github:owner/y', ref: 'main', resolved: ySha },
        ],
      });

      // Capture the file contents before the call
      const lockBefore = await readFile(path.join(project, '.rac', 'rac-lock.json'), 'utf8');

      // Set up fake cache for X
      const key = 'github:owner/x@main';
      const keyHash = Buffer.from(key).toString('base64url');
      const repoDir = path.join(cacheDir, 'packs', keyHash);
      await mkdir(path.join(repoDir, '.git'), { recursive: true });
      await mkdir(path.join(repoDir, '.rac'), { recursive: true });
      await writeFile(path.join(repoDir, '.rac/config.toml'), '', 'utf8');

      // Runner uses locked SHA path (no rev-parse needed since X is in the lockfile)
      const runner = makeRunner({});

      // Should not throw (stale Y entry is not a frozen violation)
      await expect(
        resolvePacks(project, { gitRunner: runner, frozen: true })
      ).resolves.toBeDefined();

      // Lockfile should not have been rewritten; Y entry still present
      const lockAfter = await readFile(path.join(project, '.rac', 'rac-lock.json'), 'utf8');
      expect(lockAfter).toBe(lockBefore);

      const lock = await loadPackLock(path.join(project, '.rac'));
      expect(lock!.packs.map((p) => p.id).sort()).toContain('y');
    } finally {
      process.env.RAC_CACHE_DIR = origCache;
    }
  });

  it('noWrite:true with empty lockfile: resolves successfully and does not create lockfile', async () => {
    const { project, cacheDir } = await makePackProject();
    const origCache = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    try {
      const expectedSha = 'a'.repeat(40);
      const runner = makeRunner({ 'rev-parse HEAD': `${expectedSha}\n` });

      // Should resolve without error
      const result = await resolvePacks(project, { gitRunner: runner, noWrite: true });
      expect(result.length).toBeGreaterThan(0);

      // Lockfile must NOT have been written
      const lock = await loadPackLock(path.join(project, '.rac'));
      expect(lock).toBeNull();
    } finally {
      process.env.RAC_CACHE_DIR = origCache;
    }
  });

  it('noWrite:true with frozen:true and missing lockfile: does NOT throw FrozenLockfileError and does NOT write', async () => {
    const { project, cacheDir } = await makePackProject();
    const origCache = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    try {
      const runner = makeRunner({ 'rev-parse HEAD': `${'e'.repeat(40)}\n` });

      // Should NOT throw even though frozen + no lockfile entry
      await expect(
        resolvePacks(project, { gitRunner: runner, frozen: true, noWrite: true })
      ).resolves.toBeDefined();

      // Lockfile must NOT have been written
      const lock = await loadPackLock(path.join(project, '.rac'));
      expect(lock).toBeNull();
    } finally {
      process.env.RAC_CACHE_DIR = origCache;
    }
  });

  it('noWrite:true with refresh:true: resolves but does not write lockfile', async () => {
    const { project, cacheDir } = await makePackProject();
    const origCache = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    const key = 'github:owner/alpha@main';
    const keyHash = Buffer.from(key).toString('base64url');
    const repoDir = path.join(cacheDir, 'packs', keyHash);
    const newSha = 'd'.repeat(40);

    const runner = vi.fn(async (args: string[], cwd?: string) => {
      void cwd;
      if (args[0] === 'clone') {
        const target = args[2];
        await mkdir(path.join(target, '.git'), { recursive: true });
        await mkdir(path.join(target, '.rac'), { recursive: true });
        await writeFile(path.join(target, '.rac/config.toml'), '', 'utf8');
      }
      if (args[0] === 'rev-parse') return { stdout: `${newSha}\n` };
      return { stdout: '' };
    }) as unknown as GitRunner;

    try {
      await expect(
        resolvePacks(project, { gitRunner: runner, refresh: true, noWrite: true })
      ).resolves.toBeDefined();

      // Lockfile must NOT have been written
      const lock = await loadPackLock(path.join(project, '.rac'));
      expect(lock).toBeNull();
    } finally {
      process.env.RAC_CACHE_DIR = origCache;
      void repoDir;
    }
  });

  it('pack removed from config: stale lockfile entry cleaned up; no error thrown', async () => {
    const project = await makeTmp();
    const cacheDir = await makeTmp();
    const origCache = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    try {
      // config.toml has only "alpha"; lockfile has both "alpha" and "beta" (stale)
      await mkdir(path.join(project, '.rac'), { recursive: true });
      await writeFile(
        path.join(project, '.rac/config.toml'),
        '[[packs]]\nid = "alpha"\nrepo = "github:owner/alpha"\nref = "main"\n',
        'utf8'
      );
      await writePackLock(path.join(project, '.rac'), {
        version: 1,
        packs: [
          { id: 'alpha', repo: 'github:owner/alpha', ref: 'main', resolved: 'a'.repeat(40) },
          { id: 'beta', repo: 'github:owner/beta', ref: 'main', resolved: 'b'.repeat(40) },
        ],
      });

      // Set up fake cache for alpha
      const key = 'github:owner/alpha@main';
      const keyHash = Buffer.from(key).toString('base64url');
      const repoDir = path.join(cacheDir, 'packs', keyHash);
      await mkdir(path.join(repoDir, '.git'), { recursive: true });
      await mkdir(path.join(repoDir, '.rac'), { recursive: true });
      await writeFile(path.join(repoDir, '.rac/config.toml'), '', 'utf8');

      const alphaSha = 'a'.repeat(40);
      const runner = makeRunner({ 'rev-parse HEAD': `${alphaSha}\n` });

      // Should not throw (stale beta entry is not an error)
      await expect(resolvePacks(project, { gitRunner: runner })).resolves.toBeDefined();

      // New lockfile should only have alpha
      const lock = await loadPackLock(path.join(project, '.rac'));
      expect(lock!.packs.map((p) => p.id)).toEqual(['alpha']);
    } finally {
      process.env.RAC_CACHE_DIR = origCache;
    }
  });
});
