#!/usr/bin/env node

import { createProgram } from './cli-program.js';

async function main(): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    if (e?.code === 'commander.helpDisplayed' || e?.code === 'commander.version') process.exit(0);
    if (typeof e?.code === 'string' && e.code.startsWith('commander.')) process.exit(2);
    if (typeof e?.exitCode === 'number') process.exit(e.exitCode);
    if (err instanceof Error) process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

await main();
