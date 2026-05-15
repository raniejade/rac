import { describe, expect, it } from 'vitest';

import { shouldRunCliEntrypoint } from '../src/cli.js';

describe('CLI entrypoint guard', () => {
  it('runs for direct cli script paths and package bin/symlink name rac', () => {
    expect(shouldRunCliEntrypoint('/repo/dist/cli.js')).toBe(true);
    expect(shouldRunCliEntrypoint('/repo/src/cli.ts')).toBe(true);
    expect(shouldRunCliEntrypoint('/repo/node_modules/.bin/rac')).toBe(true);
    expect(shouldRunCliEntrypoint('/tmp/rac')).toBe(true);
    expect(shouldRunCliEntrypoint('rac')).toBe(true);
  });

  it('does not run when imported as a module or for non-cli executables', () => {
    expect(shouldRunCliEntrypoint(undefined)).toBe(false);
    expect(shouldRunCliEntrypoint('')).toBe(false);
    expect(shouldRunCliEntrypoint('/repo/test/helpers.js')).toBe(false);
    expect(shouldRunCliEntrypoint('/usr/bin/node')).toBe(false);
  });
});
