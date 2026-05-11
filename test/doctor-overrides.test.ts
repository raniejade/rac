import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectColorMode } from '../src/cli/output/color.js';
import { renderDoctor } from '../src/cli/output/doctor.js';
import { doctor } from '../src/core/install.js';
import type { GitRunner } from '../src/core/parsers.js';

import { cleanupTmpDirs, makeTmp } from './helpers.js';

afterEach(cleanupTmpDirs);

async function seedMinimal(root: string): Promise<void> {
  await mkdir(path.join(root, '.rac/agents'), { recursive: true });
  await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');
}

async function makeLocalPack(packDir: string): Promise<void> {
  await mkdir(path.join(packDir, '.rac/agents'), { recursive: true });
  await writeFile(path.join(packDir, '.rac/config.toml'), '', 'utf8');
}

describe('doctor: pack override warnings', () => {
  it('no overrides: no pack_override_active warning', async () => {
    const root = await makeTmp();
    await seedMinimal(root);

    const warnings = await doctor(root, undefined, ['agent']);

    expect(warnings.some((w) => w.code === 'pack_override_active')).toBe(false);
  });

  it('one active override: emits WARN with correct message and hint', async () => {
    const root = await makeTmp();
    const packDir = await makeTmp();
    await seedMinimal(root);
    await makeLocalPack(packDir);

    // Add a pack spec and override
    await writeFile(
      path.join(root, '.rac/config.toml'),
      `[[packs]]\nid = "mypkg"\nrepo = "github:owner/repo"\nref = "main"\n`,
      'utf8'
    );
    await writeFile(
      path.join(root, '.rac/config.local.toml'),
      `[[pack_overrides]]\nid = "mypkg"\npath = ${JSON.stringify(packDir)}\n`,
      'utf8'
    );

    const warnings = await doctor(root, undefined, ['agent']);

    const overrideWarn = warnings.find((w) => w.code === 'pack_override_active');
    expect(overrideWarn).toBeDefined();
    expect(overrideWarn?.severity).toBe('warn');
    expect(overrideWarn?.message).toContain('pack override active: mypkg →');
    expect(overrideWarn?.message).toContain(packDir);
    expect(overrideWarn?.hint).toContain('rac pack override --clear mypkg');
    expect(overrideWarn?.hint).toContain('before publishing');
  });

  it('multiple overrides: one warning per override', async () => {
    const root = await makeTmp();
    const packDir1 = await makeTmp();
    const packDir2 = await makeTmp();
    await seedMinimal(root);
    await makeLocalPack(packDir1);
    await makeLocalPack(packDir2);

    await writeFile(
      path.join(root, '.rac/config.toml'),
      [
        '[[packs]]',
        'id = "pkg1"',
        'repo = "github:owner/pkg1"',
        'ref = "main"',
        '',
        '[[packs]]',
        'id = "pkg2"',
        'repo = "github:owner/pkg2"',
        'ref = "main"',
        '',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      path.join(root, '.rac/config.local.toml'),
      [
        '[[pack_overrides]]',
        'id = "pkg1"',
        `path = ${JSON.stringify(packDir1)}`,
        '',
        '[[pack_overrides]]',
        'id = "pkg2"',
        `path = ${JSON.stringify(packDir2)}`,
        '',
      ].join('\n'),
      'utf8'
    );

    const warnings = await doctor(root, undefined, ['agent']);

    const overrideWarnings = warnings.filter((w) => w.code === 'pack_override_active');
    expect(overrideWarnings).toHaveLength(2);
    expect(overrideWarnings.some((w) => w.message.includes('pkg1'))).toBe(true);
    expect(overrideWarnings.some((w) => w.message.includes('pkg2'))).toBe(true);
    expect(overrideWarnings.every((w) => w.severity === 'warn')).toBe(true);
  });

  it('scope=user: does NOT emit override warnings (overrides are project-scope only)', async () => {
    const root = await makeTmp();
    // Set up user scope via RAC_HOME env var pointing at root
    const prevRacHome = process.env.RAC_HOME;
    process.env.RAC_HOME = root;
    try {
      await mkdir(path.join(root, '.rac/agents'), { recursive: true });
      await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');

      // Even if config.local.toml exists, user scope should not read it
      // (we just verify no override warnings come from user scope)
      const warnings = await doctor(root, undefined, ['agent'], 'user');

      expect(warnings.some((w) => w.code === 'pack_override_active')).toBe(false);
    } finally {
      if (prevRacHome === undefined) {
        delete process.env.RAC_HOME;
      } else {
        process.env.RAC_HOME = prevRacHome;
      }
    }
  });

  it('override warning is non-fatal: doctor still exits 0 (warnings-only)', async () => {
    const root = await makeTmp();
    const packDir = await makeTmp();
    await seedMinimal(root);
    await makeLocalPack(packDir);

    await writeFile(
      path.join(root, '.rac/config.toml'),
      `[[packs]]\nid = "mypkg"\nrepo = "github:owner/repo"\nref = "main"\n`,
      'utf8'
    );
    await writeFile(
      path.join(root, '.rac/config.local.toml'),
      `[[pack_overrides]]\nid = "mypkg"\npath = ${JSON.stringify(packDir)}\n`,
      'utf8'
    );

    const warnings = await doctor(root, undefined, ['agent']);

    // Confirm there are warnings but no errors
    expect(warnings.some((w) => w.code === 'pack_override_active')).toBe(true);
    const hasErrors = warnings.some((w) => w.severity === 'error');
    expect(hasErrors).toBe(false);

    // renderDoctor exits 0 when there are only warnings (no errors)
    // The CLI does: if (warnings.some(w => w.severity === 'error')) process.exit(1)
    // With only WARN severity, exit code remains 0.
    const rendered = renderDoctor(warnings, detectColorMode({ plainFlag: true }));
    expect(rendered).toContain('warning(s)');
    expect(rendered).toContain('0 error(s)');
  });

  it('resolved absolute path appears in warning message (not verbatim override path)', async () => {
    const root = await makeTmp();
    const packDir = await makeTmp();
    await seedMinimal(root);
    await makeLocalPack(packDir);

    // Use the absolute path directly
    await writeFile(
      path.join(root, '.rac/config.toml'),
      `[[packs]]\nid = "mypkg"\nrepo = "github:owner/repo"\nref = "main"\n`,
      'utf8'
    );
    await writeFile(
      path.join(root, '.rac/config.local.toml'),
      `[[pack_overrides]]\nid = "mypkg"\npath = ${JSON.stringify(packDir)}\n`,
      'utf8'
    );

    const warnings = await doctor(root, undefined, ['agent']);
    const overrideWarn = warnings.find((w) => w.code === 'pack_override_active');
    expect(overrideWarn).toBeDefined();
    // The resolved absolute path (packDir) must appear in the message
    expect(overrideWarn?.message).toContain(packDir);
  });
});

// ---------------------------------------------------------------------------
// Helpers for lockfile diagnostic tests
// ---------------------------------------------------------------------------

const FAKE_SHA = 'a'.repeat(40);
const FAKE_PACK_SPEC = {
  id: 'pkg-x',
  repo: 'github:owner/pkg-x',
  ref: 'main',
};
const FAKE_PACK_SPEC_Y = {
  id: 'pkg-y',
  repo: 'github:owner/pkg-y',
  ref: 'main',
};

/**
 * Pre-create a fake pack cache directory so ensureSharedPack does not
 * need to clone (the .git sentinel already exists) and loadSharedPackConfig
 * can read the inner config.toml.
 */
async function preparePackCacheDir(cacheDir: string, spec: { repo: string; ref: string }): Promise<void> {
  const key = `${spec.repo}@${spec.ref}`;
  const keyHash = Buffer.from(key).toString('base64url');
  const repoDir = path.join(cacheDir, 'packs', keyHash);
  await mkdir(path.join(repoDir, '.git'), { recursive: true });
  await mkdir(path.join(repoDir, '.rac'), { recursive: true });
  await writeFile(path.join(repoDir, '.rac/config.toml'), '', 'utf8');
}

/**
 * A fake gitRunner that handles all git commands without real git.
 * rev-parse HEAD returns FAKE_SHA; everything else returns empty stdout.
 */
function makeFakeGitRunner(): GitRunner {
  return vi.fn().mockImplementation(async (args: string[]) => {
    if (args[0] === 'rev-parse') return { stdout: `${FAKE_SHA}\n` };
    return { stdout: '' };
  });
}

/**
 * Seed a minimal project with a single pack (no lockfile, no overrides).
 * Returns the cache dir (set as RAC_CACHE_DIR) that must be restored.
 */
async function seedProjectWithPack(root: string, spec: typeof FAKE_PACK_SPEC): Promise<string> {
  await mkdir(path.join(root, '.rac/agents'), { recursive: true });
  await writeFile(
    path.join(root, '.rac/config.toml'),
    `[[packs]]\nid = "${spec.id}"\nrepo = "${spec.repo}"\nref = "${spec.ref}"\n`,
    'utf8',
  );
  const cacheDir = await makeTmp();
  await preparePackCacheDir(cacheDir, spec);
  return cacheDir;
}

// ---------------------------------------------------------------------------
// Lockfile diagnostic tests
// ---------------------------------------------------------------------------

describe('doctor: lockfile diagnostics', () => {
  it('malformed lockfile: emits lockfile_malformed error', async () => {
    const root = await makeTmp();
    await seedMinimal(root);
    // Seed a malformed rac-lock.json
    await writeFile(path.join(root, '.rac/rac-lock.json'), 'not valid json {', 'utf8');

    const warnings = await doctor(root, undefined, ['agent']);

    const malformedWarn = warnings.find((w) => w.code === 'lockfile_malformed');
    expect(malformedWarn).toBeDefined();
    expect(malformedWarn?.severity).toBe('error');
    expect(malformedWarn?.message).toMatch(/^rac-lock\.json is malformed:/);
    expect(malformedWarn?.hint).toContain("delete .rac/rac-lock.json and run 'rac install' to regenerate");
  });

  it('malformed lockfile: does not emit other lockfile warnings', async () => {
    const root = await makeTmp();
    await seedMinimal(root);
    await writeFile(path.join(root, '.rac/rac-lock.json'), 'not valid json {', 'utf8');

    const warnings = await doctor(root, undefined, ['agent'], 'project', { frozen: true });

    expect(warnings.some((w) => w.code === 'missing_lockfile_entry')).toBe(false);
    expect(warnings.some((w) => w.code === 'stale_lockfile_entry')).toBe(false);
  });

  it('frozen + pack in config without lockfile entry: emits missing_lockfile_entry error', async () => {
    const root = await makeTmp();
    const cacheDir = await seedProjectWithPack(root, FAKE_PACK_SPEC);
    const origCacheDir = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    try {
      // No lockfile seeded — pack has no entry
      const warnings = await doctor(root, undefined, ['agent'], 'project', {
        frozen: true,
        gitRunner: makeFakeGitRunner(),
      });

      const missing = warnings.find((w) => w.code === 'missing_lockfile_entry');
      expect(missing).toBeDefined();
      expect(missing?.severity).toBe('error');
      expect(missing?.message).toContain(`pack '${FAKE_PACK_SPEC.id}' has no lockfile entry`);
      expect(missing?.context).toMatchObject({ pack: FAKE_PACK_SPEC.id });
    } finally {
      process.env.RAC_CACHE_DIR = origCacheDir;
    }
  });

  it('stale lockfile entry: emits stale_lockfile_entry warn for removed pack', async () => {
    const root = await makeTmp();
    const packDir = await makeTmp();
    await seedMinimal(root);
    await makeLocalPack(packDir);

    // Config has pkg-x with override (so resolvePacks uses local path, no git)
    await writeFile(
      path.join(root, '.rac/config.toml'),
      `[[packs]]\nid = "${FAKE_PACK_SPEC.id}"\nrepo = "${FAKE_PACK_SPEC.repo}"\nref = "${FAKE_PACK_SPEC.ref}"\n`,
      'utf8',
    );
    await writeFile(
      path.join(root, '.rac/config.local.toml'),
      `[[pack_overrides]]\nid = "${FAKE_PACK_SPEC.id}"\npath = ${JSON.stringify(packDir)}\n`,
      'utf8',
    );

    // Lockfile has both pkg-x (matching config) AND pkg-y (stale — not in config)
    await writeFile(
      path.join(root, '.rac/rac-lock.json'),
      JSON.stringify({
        version: 1,
        packs: [
          { id: FAKE_PACK_SPEC.id, repo: FAKE_PACK_SPEC.repo, ref: FAKE_PACK_SPEC.ref, resolved: FAKE_SHA },
          { id: FAKE_PACK_SPEC_Y.id, repo: FAKE_PACK_SPEC_Y.repo, ref: FAKE_PACK_SPEC_Y.ref, resolved: FAKE_SHA },
        ],
      }, null, 2),
      'utf8',
    );

    const warnings = await doctor(root, undefined, ['agent']);

    const staleWarns = warnings.filter((w) => w.code === 'stale_lockfile_entry');
    expect(staleWarns).toHaveLength(1);
    expect(staleWarns[0].severity).toBe('warn');
    expect(staleWarns[0].message).toContain(`stale lockfile entry: '${FAKE_PACK_SPEC_Y.id}'`);
    expect(staleWarns[0].context).toMatchObject({ pack: FAKE_PACK_SPEC_Y.id });

    // The pkg-x entry (still in config) must NOT produce a stale warning
    const xStale = warnings.find((w) => w.code === 'stale_lockfile_entry' && (w.context as Record<string, unknown>)['pack'] === FAKE_PACK_SPEC.id);
    expect(xStale).toBeUndefined();
  });

  it('frozen + complete matching lockfile: no missing_lockfile_entry warnings', async () => {
    const root = await makeTmp();
    const cacheDir = await seedProjectWithPack(root, FAKE_PACK_SPEC);
    const origCacheDir = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    try {
      // Seed a lockfile with a matching entry for pkg-x
      await writeFile(
        path.join(root, '.rac/rac-lock.json'),
        JSON.stringify({
          version: 1,
          packs: [
            { id: FAKE_PACK_SPEC.id, repo: FAKE_PACK_SPEC.repo, ref: FAKE_PACK_SPEC.ref, resolved: FAKE_SHA },
          ],
        }, null, 2),
        'utf8',
      );

      const warnings = await doctor(root, undefined, ['agent'], 'project', {
        frozen: true,
        gitRunner: makeFakeGitRunner(),
      });

      expect(warnings.some((w) => w.code === 'missing_lockfile_entry')).toBe(false);
      expect(warnings.some((w) => w.code === 'stale_lockfile_entry')).toBe(false);
    } finally {
      process.env.RAC_CACHE_DIR = origCacheDir;
    }
  });

  it('rac doctor does not create rac-lock.json', async () => {
    const root = await makeTmp();
    const cacheDir = await seedProjectWithPack(root, FAKE_PACK_SPEC);
    const origCacheDir = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;

    try {
      // No lockfile seeded — doctor must not write one
      await doctor(root, undefined, ['agent'], 'project', {
        gitRunner: makeFakeGitRunner(),
      });

      // Assert rac-lock.json was NOT created
      const { stat } = await import('node:fs/promises');
      await expect(
        stat(path.join(root, '.rac', 'rac-lock.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      process.env.RAC_CACHE_DIR = origCacheDir;
    }
  });

  it('frozen + no packs in config + no lockfile: no lockfile errors', async () => {
    const root = await makeTmp();
    await seedMinimal(root);
    // No lockfile seeded, no packs in config

    const warnings = await doctor(root, undefined, ['agent'], 'project', { frozen: true });

    expect(warnings.some((w) => w.code === 'missing_lockfile_entry')).toBe(false);
    expect(warnings.some((w) => w.code === 'lockfile_malformed')).toBe(false);
    expect(warnings.some((w) => w.code === 'stale_lockfile_entry')).toBe(false);
  });

  it('override-shadowed pack: emits pack_override_active but no lockfile warnings for that pack', async () => {
    const root = await makeTmp();
    const packDir = await makeTmp();
    await seedMinimal(root);
    await makeLocalPack(packDir);

    // Config has pkg-x with override; lockfile has a valid entry for pkg-x
    await writeFile(
      path.join(root, '.rac/config.toml'),
      `[[packs]]\nid = "${FAKE_PACK_SPEC.id}"\nrepo = "${FAKE_PACK_SPEC.repo}"\nref = "${FAKE_PACK_SPEC.ref}"\n`,
      'utf8',
    );
    await writeFile(
      path.join(root, '.rac/config.local.toml'),
      `[[pack_overrides]]\nid = "${FAKE_PACK_SPEC.id}"\npath = ${JSON.stringify(packDir)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(root, '.rac/rac-lock.json'),
      JSON.stringify({
        version: 1,
        packs: [
          { id: FAKE_PACK_SPEC.id, repo: FAKE_PACK_SPEC.repo, ref: FAKE_PACK_SPEC.ref, resolved: FAKE_SHA },
        ],
      }, null, 2),
      'utf8',
    );

    const warnings = await doctor(root, undefined, ['agent'], 'project', { frozen: true });

    // Override warning is present
    expect(warnings.some((w) => w.code === 'pack_override_active')).toBe(true);
    // No stale or missing for the overridden pack
    expect(warnings.some((w) => w.code === 'stale_lockfile_entry')).toBe(false);
    expect(warnings.some((w) => w.code === 'missing_lockfile_entry')).toBe(false);
  });
});
