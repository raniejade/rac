#!/usr/bin/env node
/* global console, process */
import { mkdtemp, access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { parse as parseJsonc } from 'jsonc-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const keepTemp = process.env.RAC_HARNESS_KEEP === '1';

async function spawnCapture(command, args, cwd, env = undefined) {
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

async function runCli(cwd, args) {
  const result = await spawnCapture(process.execPath, [cliPath, ...args], cwd);
  if (result.code === 0) return result;
  throw new Error(`rac ${args.join(' ')} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectExists(filePath) {
  await stat(filePath);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readJsonc(filePath) {
  return parseJsonc(await readFile(filePath, 'utf8'));
}

async function checkCodexIntegration(sampleRepo) {
  const codexDir = path.join(sampleRepo, '.codex');
  const codexAgent = path.join(codexDir, 'agents', 'reviewer.toml');
  const codexConfig = path.join(codexDir, 'config.toml');
  const codexRule = path.join(codexDir, 'rules', 'wrapper-deny.toml.rules');

  await expectExists(codexAgent);
  await expectExists(codexConfig);
  await expectExists(codexRule);

  const codexAgentToml = await readFile(codexAgent, 'utf8');
  assert(/^name = "reviewer"$/m.test(codexAgentToml), 'Codex reviewer agent TOML missing name field');
  assert(/^developer_instructions = /m.test(codexAgentToml), 'Codex reviewer agent TOML missing developer_instructions field');
  assert(/^model = "gpt-5"$/m.test(codexAgentToml), 'Codex reviewer agent TOML missing vendor.codex.config model field');
  assert(/^model_reasoning_effort = "high"$/m.test(codexAgentToml), 'Codex reviewer agent TOML missing vendor.codex.config model_reasoning_effort field');
  assert(/^sandbox_mode = "workspace-write"$/m.test(codexAgentToml), 'Codex reviewer agent TOML missing vendor.codex.config sandbox_mode field');

  const codexMcpList = await spawnCapture(
    'codex',
    ['mcp', 'list', '--json'],
    sampleRepo,
    { ...process.env, HOME: sampleRepo }
  );
  assert(codexMcpList.code === 0, `Codex MCP discovery failed with code ${codexMcpList.code}\nstdout:\n${codexMcpList.stdout}\nstderr:\n${codexMcpList.stderr}`);
  const codexMcp = JSON.parse(codexMcpList.stdout);
  assert(Array.isArray(codexMcp), 'Codex MCP discovery output is not a JSON array');
  assert(codexMcp.some((entry) => entry?.name === 'project-rules'), 'Codex MCP discovery output missing project-rules');

}

async function checkClaudeIntegration(sampleRepo) {
  const claudeSettingsPath = path.join(sampleRepo, '.claude', 'settings.json');
  await expectExists(claudeSettingsPath);
  await expectExists(path.join(sampleRepo, '.claude', 'agents', 'reviewer.md'));
  await expectExists(path.join(sampleRepo, '.claude', 'skills', 'project-gates', 'SKILL.md'));

  const mcpJson = await readJson(path.join(sampleRepo, '.mcp.json'));
  assert(typeof mcpJson === 'object' && mcpJson !== null, '.mcp.json failed to parse as object');
  assert(typeof mcpJson.mcpServers === 'object' && mcpJson.mcpServers !== null, '.mcp.json missing mcpServers object');
  assert(typeof mcpJson.mcpServers['project-rules'] === 'object', '.mcp.json missing project-rules MCP entry');

  const claudeMcpList = await spawnCapture('claude', ['mcp', 'list'], sampleRepo);
  assert(claudeMcpList.code === 0, `Claude MCP discovery failed with code ${claudeMcpList.code}\nstdout:\n${claudeMcpList.stdout}\nstderr:\n${claudeMcpList.stderr}`);
  assert(/project-rules/.test(`${claudeMcpList.stdout}\n${claudeMcpList.stderr}`), 'Claude MCP discovery output missing project-rules');

  // Claude's project agent listing can be unavailable in some local environments
  // depending on CLI auth/session state. We prefer CLI verification when available
  // and otherwise fall back to file-surface checks for this one surface.
  const claudeAgents = await spawnCapture('claude', ['agents', '--setting-sources', 'project'], sampleRepo);
  if (claudeAgents.code === 0) {
    assert(/reviewer/.test(`${claudeAgents.stdout}\n${claudeAgents.stderr}`), 'Claude agents output missing reviewer project agent');
  } else {
    console.warn(`harness smoke: warning: skipped Claude agent CLI assertion due to non-zero exit (${claudeAgents.code}); using file-surface check only for project agent output`);
  }

  const claudeSettings = await readJson(claudeSettingsPath);
  assert(typeof claudeSettings === 'object' && claudeSettings !== null, '.claude/settings.json failed to parse as object');
  const claudeDeny = claudeSettings?.permissions?.deny;
  if (claudeDeny !== undefined) {
    assert(Array.isArray(claudeDeny), 'Claude permissions.deny exists but is not an array');
  }
}

async function checkOpenCodeIntegration(sampleRepo) {
  const opencodePath = path.join(sampleRepo, '.opencode', 'opencode.jsonc');
  await expectExists(opencodePath);
  await expectExists(path.join(sampleRepo, '.opencode', 'agents', 'reviewer.md'));
  await expectExists(path.join(sampleRepo, '.opencode', 'skills', 'project-gates', 'SKILL.md'));

  const opencode = await readJsonc(opencodePath);
  assert(typeof opencode === 'object' && opencode !== null, 'OpenCode config failed to parse');
  assert(typeof opencode.mcp === 'object' && opencode.mcp !== null, 'OpenCode config missing mcp object');
  assert(typeof opencode.mcp['project-rules'] === 'object', 'OpenCode config missing project-rules MCP entry');

  const projectRules = opencode.mcp['project-rules'];
  assert(projectRules.type === 'local', 'OpenCode MCP entry for project-rules missing type=local');
  assert(projectRules.enabled === true, 'OpenCode MCP entry for project-rules missing enabled=true');
  assert(Array.isArray(projectRules.command), 'OpenCode MCP entry for project-rules command must be an array');

  const openCodeList = await spawnCapture(
    'opencode',
    ['mcp', 'list', '--pure'],
    sampleRepo,
    { ...process.env, XDG_DATA_HOME: path.join(sampleRepo, '.opencode-data') }
  );
  assert(openCodeList.code === 0, `OpenCode MCP load/list failed with code ${openCodeList.code}\nstdout:\n${openCodeList.stdout}\nstderr:\n${openCodeList.stderr}`);
}

async function checkHarnessOutputs(sampleRepo) {
  await expectExists(path.join(sampleRepo, '.rac', 'agents', 'reviewer.toml'));
  await expectExists(path.join(sampleRepo, '.rac', 'skills', 'project-gates', 'SKILL.md'));
  await expectExists(path.join(sampleRepo, '.rac', 'mcps', 'project-rules.toml'));
  await expectExists(path.join(sampleRepo, '.rac', 'rules', 'wrapper-deny.toml'));

  await expectExists(path.join(sampleRepo, '.codex', '.rac-install-manifest.json'));
  await expectExists(path.join(sampleRepo, '.agents', '.rac-install-manifest.json'));
  await expectExists(path.join(sampleRepo, '.claude', '.rac-install-manifest.json'));
  await expectExists(path.join(sampleRepo, '.opencode', '.rac-install-manifest.json'));
}

async function main() {
  try {
    await access(cliPath);
  } catch {
    console.error(`harness smoke failed: missing built CLI at ${cliPath}`);
    console.error('run `npm run build` first or use `npm run test:harness`');
    process.exit(1);
  }

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'rac-harness-'));
  const sampleRepo = path.join(tmpRoot, 'sample-repo');

  try {
    await mkdir(sampleRepo, { recursive: true });

    await runCli(sampleRepo, ['init']);
    await writeFile(
      path.join(sampleRepo, '.rac', 'agents', 'reviewer.toml'),
      'id = "reviewer"\nname = "Reviewer"\ndescription = "Checks project rules and required gates"\ninstructions = "./reviewer.instructions.md"\n[vendor.codex.config]\nmodel = "gpt-5"\nmodel_reasoning_effort = "high"\nsandbox_mode = "workspace-write"\n',
      'utf8'
    );

    await runCli(sampleRepo, ['doctor', '--kind', 'mcp']);
    await runCli(sampleRepo, ['install', '--target', 'codex']);
    await runCli(sampleRepo, ['install', '--target', 'claude,opencode']);
    await runCli(sampleRepo, ['install', '--check']);

    await checkHarnessOutputs(sampleRepo);
    await checkCodexIntegration(sampleRepo);
    await checkClaudeIntegration(sampleRepo);
    await checkOpenCodeIntegration(sampleRepo);

    console.log('harness smoke: ok');
  } catch (error) {
    console.error('harness smoke: failed');
    console.error(error instanceof Error ? error.message : String(error));
    if (keepTemp) console.error(`kept temp dir: ${tmpRoot}`);
    process.exitCode = 1;
  } finally {
    if (!keepTemp) await rm(tmpRoot, { recursive: true, force: true });
  }
}

await main();
