import path from 'node:path';

import { assert, spawnCapture } from './lib.mjs';

export async function checkCodexProject(sampleRepo) {
  await checkCodex({
    label: 'project-scope',
    cwd: sampleRepo,
    rulesPath: path.join(sampleRepo, '.codex', 'rules', 'wrapper-deny.rules'),
    env: { HOME: sampleRepo }
  });
}

export async function checkCodexUser({ userHome, cwd }) {
  await checkCodex({
    label: 'user-scope',
    cwd,
    rulesPath: path.join(userHome, '.codex', 'rules', 'wrapper-deny.rules'),
    env: { HOME: userHome }
  });
}

async function checkCodex({ label, cwd, rulesPath, env }) {
  /* global process */
  const fullEnv = { ...process.env, ...env };

  const policy = await spawnCapture(
    'codex',
    ['execpolicy', 'check', '--pretty', '--rules', rulesPath, '--', 'git', 'push'],
    cwd,
    fullEnv
  );
  assert(policy.code === 0, `Codex execpolicy (${label}) failed with code ${policy.code}\nstdout:\n${policy.stdout}\nstderr:\n${policy.stderr}`);
  const decoded = JSON.parse(policy.stdout);
  assert(decoded.decision === 'forbidden', `Codex execpolicy (${label}) did not apply generated deny rule\nstdout:\n${policy.stdout}\nstderr:\n${policy.stderr}`);

  const mcpList = await spawnCapture('codex', ['mcp', 'list', '--json'], cwd, fullEnv);
  assert(mcpList.code === 0, `Codex MCP discovery (${label}) failed with code ${mcpList.code}\nstdout:\n${mcpList.stdout}\nstderr:\n${mcpList.stderr}`);
  const mcps = JSON.parse(mcpList.stdout);
  assert(Array.isArray(mcps), `Codex MCP discovery (${label}) output is not a JSON array`);
  assert(mcps.some((entry) => entry?.name === 'project-rules'), `Codex MCP discovery (${label}) output missing project-rules`);

  const promptInput = await spawnCapture('codex', ['debug', 'prompt-input', 'smoke'], cwd, fullEnv);
  assert(promptInput.code === 0, `Codex prompt input (${label}) failed with code ${promptInput.code}\nstdout:\n${promptInput.stdout}\nstderr:\n${promptInput.stderr}`);
  assert(promptInput.stdout.includes('project-gates'), `Codex prompt input (${label}) missing project-gates skill`);
}
