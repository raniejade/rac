import { describe, expect, it } from 'vitest';

import pkg from '../package.json' with { type: 'json' };

import { runCliInProcess } from './helpers.js';

describe('rac --version', () => {
  it('prints the package version and exits 0 with --version', async () => {
    const result = await runCliInProcess(process.cwd(), ['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it('prints the package version and exits 0 with -v', async () => {
    const result = await runCliInProcess(process.cwd(), ['-v']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });
});
