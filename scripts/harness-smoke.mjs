#!/usr/bin/env node
/* global console, process */
import { mkdtemp, access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseToml } from 'smol-toml';

import { checkClaudeProject, checkClaudeUser } from './harness/claude.mjs';
import { checkCodexProject, checkCodexUser } from './harness/codex.mjs';
import { assert, makeRunCli } from './harness/lib.mjs';
import { checkOpenCodeProject, checkOpenCodeUser } from './harness/opencode.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const keepTemp = process.env.RAC_HARNESS_KEEP === '1';

const runCli = makeRunCli(cliPath);

async function checkHarnessOutputs(sampleRepo) {
  // RAC setup sanity only: make sure canonical source layout exists before install.
  await stat(path.join(sampleRepo, '.rac', 'agents', 'reviewer.toml'));
  await stat(path.join(sampleRepo, '.rac', 'skills', 'project-gates', 'SKILL.md'));
  await stat(path.join(sampleRepo, '.rac', 'mcps', 'project-rules.toml'));
  await stat(path.join(sampleRepo, '.rac', 'rules', 'wrapper-deny.toml'));
}

async function setupProjectScope(sampleRepo) {
  await mkdir(sampleRepo, { recursive: true });

  await runCli(sampleRepo, ['init']);
  await writeFile(
    path.join(sampleRepo, '.rac', 'rules', 'allow-git-status.toml'),
    '[[rule]]\nid = "allow-git-status"\ndecision = "allow"\njustification = "Status checks are safe."\ncommand = ["git", "status"]\nappend_wildcard = false\n',
    'utf8'
  );
  await writeFile(
    path.join(sampleRepo, '.rac', 'agents', 'reviewer.toml'),
    'id = "reviewer"\nname = "Reviewer"\ndescription = "Checks project rules and required gates"\ninstructions = "./reviewer.instructions.md"\n[vendor.codex.config]\nmodel = "gpt-5"\nmodel_reasoning_effort = "high"\nsandbox_mode = "workspace-write"\n',
    'utf8'
  );

  await runCli(sampleRepo, ['doctor', '--kind', 'mcp'], { ...process.env, PROJECT_RULES_TOKEN: 'harness-smoke' });
  await runCli(sampleRepo, ['install', '--targets', 'codex']);
  await runCli(sampleRepo, ['install', '--targets', 'claude,opencode']);
  await runCli(sampleRepo, ['install', '--check']);
}

async function assertAbsent(filePath, label) {
  try {
    await access(filePath);
    throw new Error(`expected ${label} to be absent but it exists: ${filePath}`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // file is absent as expected
  }
}

async function setupConfigTargetsScope(sampleRepo) {
  await mkdir(sampleRepo, { recursive: true });

  // 1. init
  await runCli(sampleRepo, ['init']);

  // 2. Write config restricting to codex only
  await writeFile(
    path.join(sampleRepo, '.rac', 'config.toml'),
    '[install]\ntargets = ["codex"]\n',
    'utf8'
  );

  // 3. Run install with NO --targets flag (config should drive target selection)
  await runCli(sampleRepo, ['install']);

  // 4a. Assert codex outputs exist
  await stat(path.join(sampleRepo, '.codex', 'rules', 'wrapper-deny.rules'));
  await stat(path.join(sampleRepo, '.codex', 'config.toml'));

  // 4b. Assert claude and opencode outputs do NOT exist
  await assertAbsent(path.join(sampleRepo, '.mcp.json'), 'claude .mcp.json');
  await assertAbsent(path.join(sampleRepo, '.claude', 'settings.json'), 'claude settings.json');
  await assertAbsent(path.join(sampleRepo, '.opencode', 'opencode.jsonc'), 'opencode opencode.jsonc');

  // 5. Run install --targets claude (CLI override) and assert claude outputs are produced
  await runCli(sampleRepo, ['install', '--targets', 'claude']);
  await stat(path.join(sampleRepo, '.mcp.json'));
  await stat(path.join(sampleRepo, '.claude', 'settings.json'));

  // 6. Run install --check to confirm idempotency
  await runCli(sampleRepo, ['install', '--check']);
}

async function preSeedUserScope(userHome, xdgConfig) {
  await mkdir(path.join(userHome, '.codex'), { recursive: true });
  await mkdir(path.join(userHome, '.claude'), { recursive: true });
  await mkdir(path.join(xdgConfig, 'opencode'), { recursive: true });

  await writeFile(
    path.join(userHome, '.codex', 'config.toml'),
    'approval_policy = "on-failure"\n\n[projects."/Users/me/foo"]\ntrust_level = "trusted"\n',
    'utf8'
  );
  await writeFile(
    path.join(userHome, '.claude.json'),
    JSON.stringify({ theme: 'dark', mcpServers: { user_one: { command: 'user-mcp' } } }, null, 2) + '\n',
    'utf8'
  );
  await writeFile(
    path.join(userHome, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { deny: ['Bash(rm -rf /)'] } }, null, 2) + '\n',
    'utf8'
  );
  await writeFile(
    path.join(xdgConfig, 'opencode', 'opencode.jsonc'),
    JSON.stringify({
      theme: 'opencode-dark',
      mcp: { user_oc_mcp: { type: 'local', enabled: true, command: ['user-oc-mcp'] } },
      permission: { bash: { 'rm -rf /': 'deny' } }
    }, null, 2) + '\n',
    'utf8'
  );
}

async function assertUninstallReverseProject(sampleRepo) {
  // dry-run must succeed (exit 0) without applying any changes
  await runCli(sampleRepo, ['uninstall', '--dry-run']);

  // Apply uninstall
  await runCli(sampleRepo, ['uninstall', '--yes']);

  // Whole-file deletes: agent and skill outputs
  await assertAbsent(path.join(sampleRepo, '.claude', 'agents', 'reviewer.md'), '.claude/agents/reviewer.md');
  await assertAbsent(path.join(sampleRepo, '.codex', 'agents', 'reviewer.toml'), '.codex/agents/reviewer.toml');
  await assertAbsent(path.join(sampleRepo, '.agents', 'skills', 'project-gates', 'SKILL.md'), '.agents/skills/project-gates/SKILL.md');
  await assertAbsent(path.join(sampleRepo, '.codex', 'rules', 'wrapper-deny.rules'), '.codex/rules/wrapper-deny.rules');
  await assertAbsent(path.join(sampleRepo, '.codex', 'rules', 'allow-git-status.rules'), '.codex/rules/allow-git-status.rules');

  // Manifests deleted
  await assertAbsent(path.join(sampleRepo, '.claude', '.rac-install-manifest.json'), '.claude/.rac-install-manifest.json');
  await assertAbsent(path.join(sampleRepo, '.codex', '.rac-install-manifest.json'), '.codex/.rac-install-manifest.json');
  await assertAbsent(path.join(sampleRepo, '.agents', '.rac-install-manifest.json'), '.agents/.rac-install-manifest.json');
  await assertAbsent(path.join(sampleRepo, '.opencode', '.rac-install-manifest.json'), '.opencode/.rac-install-manifest.json');

  // Shared files: RAC entries pruned but files may remain
  // .mcp.json: should have no RAC mcpServers entries (expect empty or no mcpServers)
  let mcpJson;
  try {
    const raw = await readFile(path.join(sampleRepo, '.mcp.json'), 'utf8');
    mcpJson = JSON.parse(raw);
  } catch {
    mcpJson = null;
  }
  if (mcpJson !== null) {
    assert(!mcpJson.mcpServers?.['project-rules'], 'uninstall left project-rules in .mcp.json');
  }

  // .claude/settings.json: no RAC deny entries remain
  let claudeSettings;
  try {
    const raw = await readFile(path.join(sampleRepo, '.claude', 'settings.json'), 'utf8');
    claudeSettings = JSON.parse(raw);
  } catch {
    claudeSettings = null;
  }
  if (claudeSettings !== null) {
    const denyEntries = claudeSettings.permissions?.deny ?? [];
    assert(!denyEntries.some((e) => e.startsWith('Bash(git push')), 'uninstall left rac deny entry in .claude/settings.json');
  }

  // .opencode/opencode.jsonc: no RAC mcp or permission entries remain
  let opencodeJson;
  try {
    const raw = await readFile(path.join(sampleRepo, '.opencode', 'opencode.jsonc'), 'utf8');
    opencodeJson = JSON.parse(raw.replace(/^\/\/.*\n/, ''));
  } catch {
    opencodeJson = null;
  }
  if (opencodeJson !== null) {
    assert(!opencodeJson.mcp?.['project-rules'], 'uninstall left project-rules in .opencode/opencode.jsonc');
    const bashKeys = Object.keys(opencodeJson.permission?.bash ?? {});
    assert(!bashKeys.some((cmd) => cmd.startsWith('git push')), 'uninstall left rac permission.bash entry in .opencode/opencode.jsonc');
  }

  // .codex/config.toml: no RAC mcp_servers entries remain
  let codexToml;
  try {
    const raw = await readFile(path.join(sampleRepo, '.codex', 'config.toml'), 'utf8');
    codexToml = parseToml(raw);
  } catch {
    codexToml = null;
  }
  if (codexToml !== null) {
    assert(!codexToml.mcp_servers?.['project-rules'], 'uninstall left project-rules in .codex/config.toml');
  }
}

async function assertUninstallPreservesUserScope(userHome, xdgConfig, cwd, env) {
  // Run uninstall in user scope
  await runCli(cwd, ['uninstall', '--scope', 'user', '--yes'], env);

  // ~/.codex/config.toml: user keys preserved, RAC entries gone
  const codexToml = parseToml(await readFile(path.join(userHome, '.codex', 'config.toml'), 'utf8'));
  assert(codexToml.approval_policy === 'on-failure', 'uninstall dropped user approval_policy from .codex/config.toml');
  assert(codexToml.projects?.['/Users/me/foo']?.trust_level === 'trusted', 'uninstall dropped user [projects.*] from .codex/config.toml');
  assert(!codexToml.mcp_servers?.['project-rules'], 'uninstall left rac mcp_servers.project-rules in .codex/config.toml');

  // ~/.claude.json: user keys preserved, RAC entries gone
  const claudeJson = JSON.parse(await readFile(path.join(userHome, '.claude.json'), 'utf8'));
  assert(claudeJson.theme === 'dark', 'uninstall dropped user theme from .claude.json');
  assert(claudeJson.mcpServers?.user_one, 'uninstall dropped user mcpServers.user_one from .claude.json');
  assert(!claudeJson.mcpServers?.['project-rules'], 'uninstall left rac mcpServers.project-rules in .claude.json');

  // ~/.claude/settings.json: user deny preserved, RAC deny entries gone
  const claudeSettings = JSON.parse(await readFile(path.join(userHome, '.claude', 'settings.json'), 'utf8'));
  assert(claudeSettings.permissions?.deny?.includes('Bash(rm -rf /)'), 'uninstall dropped user deny entry from .claude/settings.json');
  assert(!claudeSettings.permissions?.deny?.some((e) => e.startsWith('Bash(git push')), 'uninstall left rac git push deny entry in .claude/settings.json');

  // $XDG_CONFIG_HOME/opencode/opencode.jsonc: user keys preserved, RAC entries gone
  const opencodeRaw = await readFile(path.join(xdgConfig, 'opencode', 'opencode.jsonc'), 'utf8');
  const opencodeJson = JSON.parse(opencodeRaw.replace(/^\/\/.*\n/, ''));
  assert(opencodeJson.theme === 'opencode-dark', 'uninstall dropped user theme from opencode.jsonc');
  assert(opencodeJson.mcp?.user_oc_mcp, 'uninstall dropped user mcp.user_oc_mcp from opencode.jsonc');
  assert(!opencodeJson.mcp?.['project-rules'], 'uninstall left rac mcp.project-rules in opencode.jsonc');
  assert(opencodeJson.permission?.bash?.['rm -rf /'] === 'deny', 'uninstall dropped user permission.bash entry from opencode.jsonc');
  assert(!Object.keys(opencodeJson.permission?.bash ?? {}).some((cmd) => cmd.startsWith('git push')), 'uninstall left rac permission.bash git push entry in opencode.jsonc');

  // Manifests deleted
  await assertAbsent(path.join(userHome, '.claude', '.rac-install-manifest.json'), '~/.claude/.rac-install-manifest.json');
  await assertAbsent(path.join(userHome, '.codex', '.rac-install-manifest.json'), '~/.codex/.rac-install-manifest.json');
  await assertAbsent(path.join(userHome, '.agents', '.rac-install-manifest.json'), '~/.agents/.rac-install-manifest.json');
  await assertAbsent(path.join(xdgConfig, 'opencode', '.rac-install-manifest.json'), '$XDG_CONFIG_HOME/opencode/.rac-install-manifest.json');
}

async function assertMergePreservedUserKeys(userHome, xdgConfig) {
  const codexToml = parseToml(await readFile(path.join(userHome, '.codex', 'config.toml'), 'utf8'));
  assert(codexToml.approval_policy === 'on-failure', 'codex merge dropped user approval_policy');
  assert(codexToml.projects?.['/Users/me/foo']?.trust_level === 'trusted', 'codex merge dropped user [projects.*]');
  assert(codexToml.mcp_servers?.['project-rules'], 'codex merge missing rac mcp entry');

  const claudeJson = JSON.parse(await readFile(path.join(userHome, '.claude.json'), 'utf8'));
  assert(claudeJson.theme === 'dark', 'claude.json merge dropped user theme');
  assert(claudeJson.mcpServers?.user_one, 'claude.json merge dropped user mcpServers entry');
  assert(claudeJson.mcpServers?.['project-rules'], 'claude.json merge missing rac mcp entry');

  const claudeSettings = JSON.parse(await readFile(path.join(userHome, '.claude', 'settings.json'), 'utf8'));
  assert(claudeSettings.permissions?.deny?.includes('Bash(rm -rf /)'), 'claude settings merge dropped user deny entry');
  assert(claudeSettings.permissions?.deny?.some((entry) => entry.startsWith('Bash(git push')), 'claude settings merge missing rac deny entry');

  const opencodeRaw = await readFile(path.join(xdgConfig, 'opencode', 'opencode.jsonc'), 'utf8');
  const opencodeJson = JSON.parse(opencodeRaw.replace(/^\/\/.*\n/, ''));
  assert(opencodeJson.theme === 'opencode-dark', 'opencode merge dropped user theme');
  assert(opencodeJson.mcp?.user_oc_mcp, 'opencode merge dropped user mcp entry');
  assert(opencodeJson.mcp?.['project-rules'], 'opencode merge missing rac mcp entry');
  assert(opencodeJson.permission?.bash?.['rm -rf /'] === 'deny', 'opencode merge dropped user permission.bash entry');
  assert(Object.keys(opencodeJson.permission?.bash ?? {}).some((cmd) => cmd.startsWith('git push')), 'opencode merge missing rac permission.bash entry');
}

async function setupUserScope(tmpRoot, { suffix = '', noMerge = false, preSeed = false } = {}) {
  const userHome = path.join(tmpRoot, `user-home${suffix}`);
  const xdgConfig = path.join(userHome, '.config');
  const cwd = path.join(tmpRoot, `cwd-neutral${suffix}`);
  await mkdir(userHome, { recursive: true });
  await mkdir(xdgConfig, { recursive: true });
  await mkdir(cwd, { recursive: true });

  const env = { ...process.env, RAC_HOME: userHome, XDG_CONFIG_HOME: xdgConfig };
  await runCli(cwd, ['init', '--scope', 'user'], env);
  await writeFile(
    path.join(userHome, '.rac', 'rules', 'allow-git-status.toml'),
    '[[rule]]\nid = "allow-git-status"\ndecision = "allow"\njustification = "Status checks are safe."\ncommand = ["git", "status"]\nappend_wildcard = false\n',
    'utf8'
  );
  if (preSeed) await preSeedUserScope(userHome, xdgConfig);
  const installArgs = ['install', '--scope', 'user', ...(noMerge ? ['--no-merge'] : [])];
  await runCli(cwd, installArgs, env);
  await runCli(cwd, [...installArgs, '--check'], env);

  // Sanity: outputs landed in the expected user-scope locations.
  await stat(path.join(userHome, '.codex', 'config.toml'));
  await stat(path.join(userHome, '.codex', 'rules', 'allow-git-status.rules'));
  await stat(path.join(userHome, '.codex', 'rules', 'wrapper-deny.rules'));
  await stat(path.join(userHome, '.claude.json'));
  await stat(path.join(userHome, '.claude', 'settings.json'));
  await stat(path.join(userHome, '.agents', 'skills', 'project-gates', 'SKILL.md'));
  await stat(path.join(xdgConfig, 'opencode', 'opencode.jsonc'));

  return { userHome, xdgConfig, cwd };
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
  const configTargetsRepo = path.join(tmpRoot, 'config-targets-repo');

  try {
    await setupProjectScope(sampleRepo);
    await checkHarnessOutputs(sampleRepo);
    await checkCodexProject(sampleRepo);
    await checkClaudeProject(sampleRepo);
    await checkOpenCodeProject(sampleRepo);
    await assertUninstallReverseProject(sampleRepo);

    await setupConfigTargetsScope(configTargetsRepo);

    const userScope = await setupUserScope(tmpRoot, { preSeed: true });
    await assertMergePreservedUserKeys(userScope.userHome, userScope.xdgConfig);
    await checkCodexUser(userScope);
    await checkClaudeUser(userScope);
    await checkOpenCodeUser(userScope);

    // Use a separate isolated scope for uninstall checks: external vendor CLIs (e.g. claude mcp list)
    // can rewrite shared files like .claude.json, losing user-seeded keys before we can verify them.
    const userScopeUninstall = await setupUserScope(tmpRoot, { suffix: '-uninstall', preSeed: true });
    await assertMergePreservedUserKeys(userScopeUninstall.userHome, userScopeUninstall.xdgConfig);
    await assertUninstallPreservesUserScope(
      userScopeUninstall.userHome,
      userScopeUninstall.xdgConfig,
      userScopeUninstall.cwd,
      { ...process.env, RAC_HOME: userScopeUninstall.userHome, XDG_CONFIG_HOME: userScopeUninstall.xdgConfig }
    );

    const userScopeNoMerge = await setupUserScope(tmpRoot, { suffix: '-nomerge', noMerge: true });
    await checkCodexUser(userScopeNoMerge);
    await checkClaudeUser(userScopeNoMerge);
    await checkOpenCodeUser(userScopeNoMerge);

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
