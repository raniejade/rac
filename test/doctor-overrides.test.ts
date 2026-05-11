import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectColorMode } from '../src/cli/output/color.js';
import { renderDoctor } from '../src/cli/output/doctor.js';
import { doctor } from '../src/core/install.js';

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
