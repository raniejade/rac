import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { shouldRunCliEntrypoint } from '../src/cli.js';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const distCliPath = resolve(repoRoot, 'dist/cli.js');

describe('CLI entrypoint guard', () => {
  it('runs only when argv[1] resolves to the module path', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'rac-entrypoint-paths-'));
    const modulePath = join(tempDir, 'cli.js');
    const symlinkPath = join(tempDir, 'rac');
    const otherPath = join(tempDir, 'other.js');
    writeFileSync(modulePath, '// module\n', 'utf8');
    writeFileSync(otherPath, '// other\n', 'utf8');
    symlinkSync(modulePath, symlinkPath);

    expect(shouldRunCliEntrypoint(modulePath, modulePath)).toBe(true);
    expect(shouldRunCliEntrypoint(symlinkPath, modulePath)).toBe(true);
    expect(shouldRunCliEntrypoint(otherPath, modulePath)).toBe(false);
    expect(shouldRunCliEntrypoint(undefined, modulePath)).toBe(false);
    expect(shouldRunCliEntrypoint('', modulePath)).toBe(false);
  });

  it('does not run cli when imported from a non-entry script named rac', async () => {
    await execFileAsync('npm', ['run', 'build'], { cwd: repoRoot });
    const tempDir = await mkdtemp(join(tmpdir(), 'rac-entrypoint-'));
    const importerPath = join(tempDir, 'rac');

    await writeFile(
      importerPath,
      `import ${JSON.stringify(distCliPath)};\nprocess.stdout.write('imported-marker\\n');\n`,
      'utf8',
    );
    chmodSync(importerPath, 0o755);

    const result = await execFileAsync('node', [importerPath, '--version']);
    expect(result.stdout.trim()).toBe('imported-marker');
    expect(result.stderr.trim()).toBe('');
  });
});
