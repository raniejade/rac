import { describe, expect, it } from 'vitest';

import pkg from '../package.json' with { type: 'json' };

import { runCli } from './helpers.js';

describe('rac --version', () => {
  it('prints the package version and exits 0 with --version', () => {
    const result = runCli(process.cwd(), ['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it('prints the package version and exits 0 with -v', () => {
    const result = runCli(process.cwd(), ['-v']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });
});
