import { execFile } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import pkg from '../package.json' with { type: 'json' };

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const distCliPath = resolve(repoRoot, 'dist/cli.js');
const distCliMainPath = resolve(repoRoot, 'dist/cli-main.js');
const distCliProgramPath = resolve(repoRoot, 'dist/cli-program.js');
const sourceProgramPath = resolve(repoRoot, 'src/cli-program.ts');

describe('CLI entrypoint split', () => {
  beforeAll(async () => {
    await execFileAsync('npm', ['run', 'build'], { cwd: repoRoot });
  });

  it('importing the source program module is safe', async () => {
    const mod = await import(pathToFileURL(sourceProgramPath).href);
    expect(typeof mod.createProgram).toBe('function');
  });

  it('executes built dist/cli.js --version', async () => {
    const result = await execFileAsync('node', [distCliPath, '--version']);
    expect(result.stdout.trim()).toBe(pkg.version);
    expect(result.stderr.trim()).toBe('');
  });

  it('executes symlink named rac to built dist/cli.js --version', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'rac-entrypoint-symlink-'));
    const symlinkPath = join(tempDir, 'rac');
    symlinkSync(distCliPath, symlinkPath);

    const result = await execFileAsync('node', [symlinkPath, '--version']);
    expect(result.stdout.trim()).toBe(pkg.version);
    expect(result.stderr.trim()).toBe('');
  });

  it('build only emits dist/cli.js as entrypoint artifact', async () => {
    await expect(access(distCliPath)).resolves.toBeUndefined();
    await expect(access(distCliMainPath)).rejects.toThrow();
    await expect(access(distCliProgramPath)).rejects.toThrow();
  });
});
