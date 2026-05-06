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

async function runCli(cwd, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`rac ${args.join(' ')} failed with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

async function expectExists(filePath) {
  await stat(filePath);
}

async function readJsonc(filePath) {
  return parseJsonc(await readFile(filePath, 'utf8'));
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

    await expectExists(path.join(sampleRepo, '.rac', 'agents', 'reviewer.toml'));
    await expectExists(path.join(sampleRepo, '.rac', 'skills', 'project-gates', 'SKILL.md'));
    await expectExists(path.join(sampleRepo, '.rac', 'mcps', 'project-rules.toml'));
    await expectExists(path.join(sampleRepo, '.rac', 'rules', 'wrapper-deny.toml'));
    await expectExists(path.join(sampleRepo, '.codex', '.rac-install-manifest.json'));
    await expectExists(path.join(sampleRepo, '.agents', '.rac-install-manifest.json'));
    await expectExists(path.join(sampleRepo, '.claude', '.rac-install-manifest.json'));
    await expectExists(path.join(sampleRepo, '.opencode', '.rac-install-manifest.json'));

    await expectExists(path.join(sampleRepo, '.codex', 'agents', 'reviewer.toml'));
    await expectExists(path.join(sampleRepo, '.agents', 'skills', 'project-gates', 'SKILL.md'));
    await expectExists(path.join(sampleRepo, '.codex', 'config.toml'));
    await expectExists(path.join(sampleRepo, '.codex', 'rules', 'project', 'wrapper-deny.toml.rules'));
    await expectExists(path.join(sampleRepo, '.claude', 'settings.json'));

    await expectExists(path.join(sampleRepo, '.mcp.json'));
    await expectExists(path.join(sampleRepo, '.opencode', 'opencode.jsonc'));

    const opencode = await readJsonc(path.join(sampleRepo, '.opencode', 'opencode.jsonc'));
    const projectRules = opencode?.mcp?.['project-rules'];
    if (!projectRules || projectRules.type !== 'local' || projectRules.enabled !== true) {
      throw new Error('OpenCode MCP entry for project-rules missing required type/local enabled schema');
    }
    if (!Array.isArray(projectRules.command) || projectRules.command[0] !== 'node') {
      throw new Error('OpenCode MCP entry for project-rules has unexpected command shape');
    }
    if (!opencode?.permission?.bash || typeof opencode.permission.bash !== 'object' || Array.isArray(opencode.permission.bash)) {
      throw new Error('OpenCode permission.bash missing centralized rule map entries');
    }
    if (opencode.permission.bash['git push *'] !== 'deny') {
      throw new Error('OpenCode permission.bash rule map missing deny value for git push *');
    }

    const codexAgentToml = await readFile(path.join(sampleRepo, '.codex', 'agents', 'reviewer.toml'), 'utf8');
    if (!/^name = "reviewer"$/m.test(codexAgentToml)) {
      throw new Error('Codex reviewer agent TOML missing name field');
    }
    if (!/^description = /m.test(codexAgentToml)) {
      throw new Error('Codex reviewer agent TOML missing description field');
    }
    if (!/^developer_instructions = /m.test(codexAgentToml)) {
      throw new Error('Codex reviewer agent TOML missing developer_instructions field');
    }
    if (!/^model = "gpt-5"$/m.test(codexAgentToml)) {
      throw new Error('Codex reviewer agent TOML missing vendor.codex.config model field');
    }
    if (!/^model_reasoning_effort = "high"$/m.test(codexAgentToml)) {
      throw new Error('Codex reviewer agent TOML missing vendor.codex.config model_reasoning_effort field');
    }
    if (!/^sandbox_mode = "workspace-write"$/m.test(codexAgentToml)) {
      throw new Error('Codex reviewer agent TOML missing vendor.codex.config sandbox_mode field');
    }
    if (/^id = /m.test(codexAgentToml) || /^instructions = /m.test(codexAgentToml)) {
      throw new Error('Codex reviewer agent TOML still uses legacy id/instructions fields');
    }

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
