import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultGitRunner, ensureSharedPack, type GitRunner } from '../src/core/parsers.js';

import { cleanupTmpDirs, makeTmp } from './helpers.js';

afterEach(cleanupTmpDirs);

describe('ensureSharedPack', () => {
  const validSpec = { id: 'mypkg', repo: 'github:owner/repo', ref: 'main' };

  it('invalid ref: surfaces fetch error verbatim', async () => {
    const cacheDir = await makeTmp();
    const originalCacheDir = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    try {
      const fetchError = new Error("git fetch --force --tags origin badref failed: fatal: couldn't find remote ref badref");
      const runner: GitRunner = vi.fn()
        .mockImplementationOnce(async () => { /* clone succeeds */ })
        .mockImplementationOnce(async () => { throw fetchError; });

      await expect(
        ensureSharedPack({ ...validSpec, ref: 'badref' }, { gitRunner: runner })
      ).rejects.toThrow("git fetch --force --tags origin badref failed: fatal: couldn't find remote ref badref");
    } finally {
      process.env.RAC_CACHE_DIR = originalCacheDir;
    }
  });

  it('network unreachable: surfaces clone error', async () => {
    const cacheDir = await makeTmp();
    const originalCacheDir = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    try {
      const cloneError = new Error("git clone https://github.com/x/y.git … failed: fatal: unable to access …: Could not resolve host github.com");
      const runner: GitRunner = vi.fn()
        .mockImplementationOnce(async () => { throw cloneError; });

      await expect(
        ensureSharedPack({ id: 'mypkg', repo: 'github:x/y', ref: 'main' }, { gitRunner: runner })
      ).rejects.toThrow('Could not resolve host github.com');
    } finally {
      process.env.RAC_CACHE_DIR = originalCacheDir;
    }
  });

  it('private repo auth: surfaces authentication failure', async () => {
    const cacheDir = await makeTmp();
    const originalCacheDir = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    try {
      const authError = new Error("git clone ... failed: Authentication failed for 'https://github.com/priv/repo.git'");
      const runner: GitRunner = vi.fn()
        .mockImplementationOnce(async () => { throw authError; });

      await expect(
        ensureSharedPack({ id: 'mypkg', repo: 'github:priv/repo', ref: 'main' }, { gitRunner: runner })
      ).rejects.toThrow('Authentication failed');
    } finally {
      process.env.RAC_CACHE_DIR = originalCacheDir;
    }
  });

  it('refresh: true clears cache and triggers clone even when .git sentinel exists', async () => {
    const cacheDir = await makeTmp();
    const originalCacheDir = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    try {
      // Pre-create a fake cache dir with .git sentinel
      const { mkdir } = await import('node:fs/promises');
      const key = `github:owner/repo@main`;
      const keyHash = Buffer.from(key).toString('base64url');
      const repoDir = path.join(cacheDir, 'packs', keyHash);
      await mkdir(path.join(repoDir, '.git'), { recursive: true });

      const cloneCalls: string[][] = [];
      const runner: GitRunner = vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'clone') {
          cloneCalls.push(args);
        }
        // All git calls succeed
      });

      // With refresh: true, clone should be called even though .git exists
      // Note: it will fail at loadSharedPackConfig since there's no real rac config,
      // but we can verify clone was called
      try {
        await ensureSharedPack(validSpec, { refresh: true, gitRunner: runner });
      } catch {
        // expected to fail at loadSharedPackConfig stage
      }

      expect(cloneCalls.length).toBeGreaterThanOrEqual(1);
      expect(cloneCalls[0][0]).toBe('clone');
    } finally {
      process.env.RAC_CACHE_DIR = originalCacheDir;
    }
  });
});

describe('defaultGitRunner', () => {
  it('rejects with PATH-not-found message when git binary is missing', async () => {
    const emptyDir = await makeTmp();
    const originalPath = process.env.PATH;
    process.env.PATH = emptyDir;

    try {
      const runner = defaultGitRunner();
      await expect(runner(['--version'])).rejects.toThrow(
        'git is required to resolve shared packs; install git and ensure it is on PATH'
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
