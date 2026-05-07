#!/usr/bin/env node
/* global console, process */
import { mkdtemp, access, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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

async function checkCodexIntegration(sampleRepo) {
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
  // Codex CLI currently has no stable non-interactive surface in this harness to
  // prove generated project agents/skills are loaded. We do not claim integration
  // verification for those surfaces here.
}

async function checkClaudeIntegration(sampleRepo) {
  const claudeMcpList = await spawnCapture('claude', ['mcp', 'list'], sampleRepo);
  assert(claudeMcpList.code === 0, `Claude MCP discovery failed with code ${claudeMcpList.code}\nstdout:\n${claudeMcpList.stdout}\nstderr:\n${claudeMcpList.stderr}`);
  assert(/project-rules/.test(`${claudeMcpList.stdout}\n${claudeMcpList.stderr}`), 'Claude MCP discovery output missing project-rules');

  const claudeAgents = await spawnCapture('claude', ['agents', '--setting-sources', 'project'], sampleRepo);
  assert(claudeAgents.code === 0, `Claude agents discovery failed with code ${claudeAgents.code}\nstdout:\n${claudeAgents.stdout}\nstderr:\n${claudeAgents.stderr}`);
  assert(/reviewer/.test(`${claudeAgents.stdout}\n${claudeAgents.stderr}`), 'Claude agents output missing reviewer project agent');
  // Claude CLI has no stable project skills list/load command in this harness.
  // We do not claim integration verification for Claude skills here.
}

async function checkOpenCodeIntegration(sampleRepo) {
  const openCodeList = await spawnCapture(
    'opencode',
    ['mcp', 'list', '--pure'],
    sampleRepo,
    { ...process.env, XDG_DATA_HOME: path.join(sampleRepo, '.opencode-data') }
  );
  assert(openCodeList.code === 0, `OpenCode MCP load/list failed with code ${openCodeList.code}\nstdout:\n${openCodeList.stdout}\nstderr:\n${openCodeList.stderr}`);
}

async function checkHarnessOutputs(sampleRepo) {
  // RAC setup sanity only: make sure canonical source layout exists before install.
  await stat(path.join(sampleRepo, '.rac', 'agents', 'reviewer.toml'));
  await stat(path.join(sampleRepo, '.rac', 'skills', 'project-gates', 'SKILL.md'));
  await stat(path.join(sampleRepo, '.rac', 'mcps', 'project-rules.toml'));
  await stat(path.join(sampleRepo, '.rac', 'rules', 'wrapper-deny.toml'));
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
