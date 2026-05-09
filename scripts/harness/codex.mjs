import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { assert, spawnCapture } from './lib.mjs';

export async function checkCodexProject(sampleRepo) {
  await checkCodex({
    label: 'project-scope',
    cwd: sampleRepo,
    configTomlPath: path.join(sampleRepo, '.codex', 'config.toml'),
    rulesPath: path.join(sampleRepo, '.codex', 'rules', 'wrapper-deny.rules'),
    allowRulesPath: path.join(sampleRepo, '.codex', 'rules', 'allow-git-status.rules'),
    env: { HOME: sampleRepo }
  });
}

export async function checkCodexUser({ userHome, cwd }) {
  await checkCodex({
    label: 'user-scope',
    cwd,
    configTomlPath: path.join(userHome, '.codex', 'config.toml'),
    rulesPath: path.join(userHome, '.codex', 'rules', 'wrapper-deny.rules'),
    allowRulesPath: path.join(userHome, '.codex', 'rules', 'allow-git-status.rules'),
    env: { HOME: userHome }
  });
}

async function checkCodex({ label, cwd, configTomlPath, rulesPath, allowRulesPath, env }) {
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

  const allowPolicy = await spawnCapture(
    'codex',
    ['execpolicy', 'check', '--pretty', '--rules', allowRulesPath, '--', 'git', 'status'],
    cwd,
    fullEnv
  );
  assert(allowPolicy.code === 0, `Codex execpolicy allow (${label}) failed with code ${allowPolicy.code}\nstdout:\n${allowPolicy.stdout}\nstderr:\n${allowPolicy.stderr}`);
  const allowDecoded = JSON.parse(allowPolicy.stdout);
  assert(allowDecoded.decision === 'allow', `Codex execpolicy (${label}) did not apply generated allow rule\nstdout:\n${allowPolicy.stdout}\nstderr:\n${allowPolicy.stderr}`);

  const mcpList = await spawnCapture('codex', ['mcp', 'list', '--json'], cwd, fullEnv);
  assert(mcpList.code === 0, `Codex MCP discovery (${label}) failed with code ${mcpList.code}\nstdout:\n${mcpList.stdout}\nstderr:\n${mcpList.stderr}`);
  const mcps = JSON.parse(mcpList.stdout);
  assert(Array.isArray(mcps), `Codex MCP discovery (${label}) output is not a JSON array`);
  assert(mcps.some((entry) => entry?.name === 'project-rules'), `Codex MCP discovery (${label}) output missing project-rules`);

  const codexToml = parseToml(await readFile(configTomlPath, 'utf8'));
  assert(codexToml.mcp_servers?.['project-rules']?.env?.LOG_LEVEL === 'info', `Codex ${label} config.toml missing project-rules env.LOG_LEVEL`);
  assert(Array.isArray(codexToml.mcp_servers?.['project-rules']?.env_vars) && codexToml.mcp_servers['project-rules'].env_vars.includes('PROJECT_RULES_TOKEN'), `Codex ${label} config.toml missing project-rules env_vars PROJECT_RULES_TOKEN`);

  const promptInput = await spawnCapture('codex', ['debug', 'prompt-input', 'smoke'], cwd, fullEnv);
  assert(promptInput.code === 0, `Codex prompt input (${label}) failed with code ${promptInput.code}\nstdout:\n${promptInput.stdout}\nstderr:\n${promptInput.stderr}`);
  assert(promptInput.stdout.includes('project-gates'), `Codex prompt input (${label}) missing project-gates skill`);
}
