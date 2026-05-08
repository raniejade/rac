/* global process */
import { spawn } from 'node:child_process';

export async function spawnCapture(command, args, cwd, env = undefined) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function makeRunCli(cliPath) {
  return async function runCli(cwd, args, env = undefined) {
    const result = await spawnCapture(process.execPath, [cliPath, ...args], cwd, env);
    if (result.code === 0) return result;
    throw new Error(`rac ${args.join(' ')} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
