#!/usr/bin/env node
/* global console, process */
import { cp, mkdtemp, access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseToml } from 'smol-toml';

import { checkClaudeProject, checkClaudeUser } from './harness/claude.mjs';
import { checkCodexProject, checkCodexUser } from './harness/codex.mjs';
import { assert, makeRunCli, spawnCapture } from './harness/lib.mjs';
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

/**
 * Create a minimal local bare git repo that looks like a valid pack remote.
 * Returns the file:// URL for the bare repo.
 */
async function setupLocalBarePackRepo(dir) {
  await mkdir(dir, { recursive: true });

  // Init a regular repo, add .rac/config.toml, commit, then bare-clone it.
  const src = path.join(dir, 'src');
  await mkdir(path.join(src, '.rac'), { recursive: true });
  await writeFile(path.join(src, '.rac', 'config.toml'), '', 'utf8');

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Harness',
    GIT_AUTHOR_EMAIL: 'harness@rac.test',
    GIT_COMMITTER_NAME: 'Harness',
    GIT_COMMITTER_EMAIL: 'harness@rac.test',
  };
  const git = (args, cwd) => spawnCapture('git', args, cwd, gitEnv);
  await git(['init', '-b', 'main', src], dir);
  await git(['add', '.'], src);
  await git(['commit', '-m', 'init'], src);

  const bareDir = path.join(dir, 'bare.git');
  await git(['clone', '--bare', src, bareDir], dir);

  return `file://${bareDir}`;
}

async function setupPackOverrideScope(tmpRoot) {
  const proj = path.join(tmpRoot, 'override-project');
  const pack = path.join(tmpRoot, 'override-local-pack');
  await mkdir(proj, { recursive: true });
  await mkdir(pack, { recursive: true });

  await runCli(proj, ['init', '--empty']);
  const gi = await readFile(path.join(proj, '.rac', '.gitignore'), 'utf8');
  assert(gi.includes('config.local.toml'), `.gitignore: ${gi}`);

  await mkdir(path.join(pack, '.rac', 'agents'), { recursive: true });
  await writeFile(path.join(pack, '.rac', 'config.toml'), '', 'utf8');
  await writeFile(
    path.join(pack, '.rac', 'agents', 'override-agent.toml'),
    'id = "override-agent"\nname = "Override Agent"\ndescription = "x."\ninstructions = "./override-agent.instructions.md"\n',
    'utf8'
  );
  await writeFile(path.join(pack, '.rac', 'agents', 'override-agent.instructions.md'), 'x', 'utf8');

  // Set up a local bare git repo and redirect the github: URL to it so
  // `pack add` can clone without network access.
  const bareRepoDir = path.join(tmpRoot, 'override-bare-pack');
  const bareUrl = await setupLocalBarePackRepo(bareRepoDir);
  const tmpGitConfig = path.join(tmpRoot, 'override-gitconfig');
  await writeFile(
    tmpGitConfig,
    `[url "${bareUrl}"]\n\tinsteadOf = https://github.com/smoke/demo.git\n`,
    'utf8'
  );
  const overrideEnv = { ...process.env, GIT_CONFIG_GLOBAL: tmpGitConfig };

  await runCli(proj, ['pack', 'add', 'demo', 'github:smoke/demo', '--ref', 'main'], overrideEnv);
  await runCli(proj, ['pack', 'override', 'demo', pack]);
  const localConfig = await readFile(path.join(proj, '.rac', 'config.local.toml'), 'utf8');
  assert(localConfig.includes('id = "demo"'), `config.local.toml missing demo id: ${localConfig}`);
  const list = await runCli(proj, ['pack', 'list', '--plain']);
  assert(list.stdout.includes(`(override → ${pack})`), `pack list missing override: ${list.stdout}`);
  const doctor = await runCli(proj, ['doctor', '--plain']);
  assert(doctor.stdout.includes('pack override active: demo →'), `doctor missing override warn: ${doctor.stdout}`);
  const dryRun = await runCli(proj, ['install', '--dry-run', '--targets', 'claude', '--kind', 'agent', '--plain']);
  assert(dryRun.stdout.includes('pack override active: demo →'), `install --dry-run missing override warn: ${dryRun.stdout}`);
  await runCli(proj, ['install', '--targets', 'claude', '--kind', 'agent', '--plain']);
  await stat(path.join(proj, '.claude', 'agents', 'override-agent.md'));
  await runCli(proj, ['pack', 'override', 'demo', '--clear']);
  await assertAbsent(path.join(proj, '.rac', 'config.local.toml'), '.rac/config.local.toml after clear');
}

/**
 * Advance "upstream" by committing a new file to the bare repo.
 * Returns the new HEAD SHA (40-char hex).
 */
async function advanceUpstream(bareDir, gitEnv) {
  const workDir = path.join(path.dirname(bareDir), 'advance-work-' + Date.now());
  await mkdir(workDir, { recursive: true });
  const git = (args, cwd) => spawnCapture('git', args, cwd, gitEnv);
  await git(['clone', bareDir, workDir], path.dirname(bareDir));
  // Add a new file so the commit is non-empty
  await writeFile(path.join(workDir, `advance-${Date.now()}.txt`), `advance ${Date.now()}\n`, 'utf8');
  await git(['add', '.'], workDir);
  await git(['commit', '-m', 'advance upstream'], workDir);
  await git(['push', 'origin', 'HEAD:main'], workDir);
  const result = await git(['rev-parse', 'HEAD'], workDir);
  await rm(workDir, { recursive: true, force: true });
  return result.stdout.trim();
}

/**
 * Smoke test for rac-lock.json: all 7 end-to-end verification scenarios.
 */
async function setupLockfileSmokeBasic(proj, lockEnv, bareDir) {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Harness',
    GIT_AUTHOR_EMAIL: 'harness@rac.test',
    GIT_COMMITTER_NAME: 'Harness',
    GIT_COMMITTER_EMAIL: 'harness@rac.test',
    GIT_CONFIG_GLOBAL: lockEnv.GIT_CONFIG_GLOBAL,
  };

  // ── Scenario 1: clean install → lockfile created ──────────────────────────
  await runCli(proj, ['init', '--empty'], lockEnv);
  await runCli(proj, ['pack', 'add', 'lockfile-pack', 'github:smoke/lockfile-pack', '--ref', 'main'], lockEnv);

  // Lockfile must already exist after pack add.
  await stat(path.join(proj, '.rac', 'rac-lock.json'));
  const lockRaw1 = await readFile(path.join(proj, '.rac', 'rac-lock.json'), 'utf8');
  const lock1 = JSON.parse(lockRaw1);
  assert(lock1.version === 1, `scenario 1: expected version 1, got ${lock1.version}`);
  assert(Array.isArray(lock1.packs) && lock1.packs.length === 1, `scenario 1: expected 1 pack entry`);
  assert(lock1.packs[0].id === 'lockfile-pack', `scenario 1: wrong pack id`);
  const sha1 = lock1.packs[0].resolved;
  assert(/^[0-9a-f]{40}$/.test(sha1), `scenario 1: resolved is not a 40-char SHA: ${sha1}`);

  // Verify the SHA matches git rev-parse HEAD on the bare repo's main branch
  const headResult = await spawnCapture('git', ['rev-parse', 'refs/heads/main'], bareDir, gitEnv);
  const bareHead1 = headResult.stdout.trim();
  assert(sha1 === bareHead1, `scenario 1: lockfile SHA ${sha1} does not match bare repo HEAD ${bareHead1}`);

  // run rac install and verify lockfile is still present
  await runCli(proj, ['install', '--targets', 'codex'], lockEnv);
  await stat(path.join(proj, '.rac', 'rac-lock.json'));
  console.log('harness: rac-lock.json scenario 1 (clean install → lockfile created) ok');

  // ── Scenario 2: upstream advances, non-refresh install → SHA unchanged ────
  const sha2Upstream = await advanceUpstream(bareDir, gitEnv);
  assert(sha2Upstream !== sha1, `scenario 2: upstream SHA should have advanced (got same ${sha2Upstream})`);

  // Regular install: must NOT pick up the new commit
  await runCli(proj, ['install', '--targets', 'codex'], lockEnv);
  const lockRaw2 = await readFile(path.join(proj, '.rac', 'rac-lock.json'), 'utf8');
  const lock2 = JSON.parse(lockRaw2);
  assert(lock2.packs[0].resolved === sha1,
    `scenario 2: lockfile SHA changed after non-refresh install (expected ${sha1}, got ${lock2.packs[0].resolved})`);
  console.log('harness: rac-lock.json scenario 2 (upstream advances, non-refresh → SHA pinned) ok');

  // ── Scenario 3: --refresh-packs rewrites lockfile with new SHA ────────────
  await runCli(proj, ['install', '--targets', 'codex', '--refresh-packs'], lockEnv);
  const lockRaw3 = await readFile(path.join(proj, '.rac', 'rac-lock.json'), 'utf8');
  const lock3 = JSON.parse(lockRaw3);
  const sha3 = lock3.packs[0].resolved;
  assert(sha3 === sha2Upstream,
    `scenario 3: lockfile SHA after --refresh-packs should be ${sha2Upstream}, got ${sha3}`);
  console.log('harness: rac-lock.json scenario 3 (--refresh-packs rewrites lockfile) ok');

  // ── Scenario 4: --frozen-lockfile after scenario 3 → succeeds, no mutation ─
  const lockBytes4Before = await readFile(path.join(proj, '.rac', 'rac-lock.json'));
  await runCli(proj, ['install', '--targets', 'codex', '--frozen-lockfile'], lockEnv);
  const lockBytes4After = await readFile(path.join(proj, '.rac', 'rac-lock.json'));
  assert(lockBytes4Before.equals(lockBytes4After),
    `scenario 4: --frozen-lockfile mutated the lockfile`);
  console.log('harness: rac-lock.json scenario 4 (--frozen-lockfile succeeds, no mutation) ok');
}

async function setupLockfileSmokeAdvanced(proj, lockEnv) {

  // ── Scenario 5: delete pack from config.toml, doctor warns, install prunes ──
  // Read config.toml, remove the [[packs]] block for lockfile-pack directly
  const configPath5 = path.join(proj, '.rac', 'config.toml');
  const configRaw5 = await readFile(configPath5, 'utf8');
  // Remove the [[packs]] block (everything from [[packs]] to next blank line or EOF)
  const configStripped5 = configRaw5.replace(/\n?\[\[packs\]\]\nid = "lockfile-pack"\nrepo = "github:smoke\/lockfile-pack"\nref = "main"\n/g, '\n').replace(/^\n/, '');
  await writeFile(configPath5, configStripped5, 'utf8');

  // doctor should emit stale_lockfile_entry warning
  const doctorResult5 = await runCli(proj, ['doctor', '--plain'], lockEnv);
  assert(doctorResult5.stdout.includes('stale_lockfile_entry'),
    `scenario 5: doctor should emit stale_lockfile_entry warning, got:\n${doctorResult5.stdout}`);

  // rac install should prune the stale entry from the lockfile
  await runCli(proj, ['install', '--targets', 'codex'], lockEnv);
  const lockRaw5 = await readFile(path.join(proj, '.rac', 'rac-lock.json'), 'utf8');
  const lock5 = JSON.parse(lockRaw5);
  assert(lock5.packs.length === 0,
    `scenario 5: expected 0 pack entries after install with stale entry pruned, got ${lock5.packs.length}`);
  console.log('harness: rac-lock.json scenario 5 (stale entry → doctor warns, install prunes) ok');

  // Re-add the pack so we can test scenario 6
  await runCli(proj, ['pack', 'add', 'lockfile-pack', 'github:smoke/lockfile-pack', '--ref', 'main'], lockEnv);
  const lockRaw5b = await readFile(path.join(proj, '.rac', 'rac-lock.json'), 'utf8');
  const lock5b = JSON.parse(lockRaw5b);
  assert(lock5b.packs.length === 1 && lock5b.packs[0].id === 'lockfile-pack',
    `scenario 5 re-add: expected lockfile-pack entry back, got ${JSON.stringify(lock5b.packs)}`);

  // ── Scenario 6: pack override → lockfile entry pruned; clear → re-resolves ──
  // Set up a local override pack directory
  const overridePackDir = path.join(path.dirname(proj), 'lockfile-override-pack');
  await mkdir(path.join(overridePackDir, '.rac'), { recursive: true });
  await writeFile(path.join(overridePackDir, '.rac', 'config.toml'), '', 'utf8');

  await runCli(proj, ['pack', 'override', 'lockfile-pack', overridePackDir]);

  // install with override active → lockfile entry should be pruned
  await runCli(proj, ['install', '--targets', 'codex'], lockEnv);
  const lockRaw6 = await readFile(path.join(proj, '.rac', 'rac-lock.json'), 'utf8');
  const lock6 = JSON.parse(lockRaw6);
  const overrideEntry = lock6.packs.find((p) => p.id === 'lockfile-pack');
  assert(overrideEntry === undefined,
    `scenario 6: lockfile entry for overridden pack should be pruned, but found: ${JSON.stringify(overrideEntry)}`);
  console.log('harness: rac-lock.json scenario 6a (pack override → lockfile entry pruned) ok');

  // Clear the override → install re-resolves and adds back
  await runCli(proj, ['pack', 'override', 'lockfile-pack', '--clear']);
  await runCli(proj, ['install', '--targets', 'codex'], lockEnv);
  const lockRaw6b = await readFile(path.join(proj, '.rac', 'rac-lock.json'), 'utf8');
  const lock6b = JSON.parse(lockRaw6b);
  const reResolvedEntry = lock6b.packs.find((p) => p.id === 'lockfile-pack');
  assert(reResolvedEntry !== undefined,
    `scenario 6b: lockfile entry should be re-added after clear+install`);
  assert(/^[0-9a-f]{40}$/.test(reResolvedEntry.resolved),
    `scenario 6b: re-resolved SHA should be 40-char hex, got: ${reResolvedEntry.resolved}`);
  console.log('harness: rac-lock.json scenario 6b (override cleared → lockfile entry re-resolved) ok');

  // ── Scenario 7: two "clones" with --frozen-lockfile produce byte-identical output ──
  // Add a rule to the project so install produces at least one rendered output file.
  await mkdir(path.join(proj, '.rac', 'rules'), { recursive: true });
  await writeFile(
    path.join(proj, '.rac', 'rules', 'scenario7-rule.toml'),
    '[[rule]]\nid = "scenario7-allow-echo"\ndecision = "allow"\njustification = "Scenario 7 smoke test."\ncommand = ["echo"]\nappend_wildcard = false\n',
    'utf8'
  );
  // Run install in proj to get baseline rendered outputs
  await runCli(proj, ['install', '--targets', 'codex'], lockEnv);

  // Collect rendered output paths (.codex directory)
  const codexDir = path.join(proj, '.codex');
  const { stdout: findOut } = await spawnCapture('find', [codexDir, '-type', 'f'], proj);
  const renderedPaths = findOut.trim().split('\n').filter(Boolean).sort();
  assert(renderedPaths.length > 0, `scenario 7: no rendered outputs found in ${codexDir}`);

  // Read baseline content
  const baseline = new Map();
  for (const absPath of renderedPaths) {
    baseline.set(absPath, await readFile(absPath));
  }

  // Set up "second clone": copy project root + lockfile to fresh tempdir
  const clone2 = path.join(path.dirname(proj), 'lockfile-clone2');
  await mkdir(clone2, { recursive: true });
  await cp(path.join(proj, '.rac'), path.join(clone2, '.rac'), { recursive: true });

  // Simulate a fresh clone with an isolated cache dir so the clone must
  // re-clone the pack from the bare repo instead of reusing the shared cache.
  const freshCache = path.join(path.dirname(proj), 'lockfile-fresh-cache');
  await mkdir(freshCache, { recursive: true });
  const clone2Env = { ...lockEnv, RAC_CACHE_DIR: freshCache };

  // Run --frozen-lockfile in the second clone
  await runCli(clone2, ['install', '--targets', 'codex', '--frozen-lockfile'], clone2Env);

  // Compare rendered outputs
  const clone2CodexDir = path.join(clone2, '.codex');
  const { stdout: findOut2 } = await spawnCapture('find', [clone2CodexDir, '-type', 'f'], clone2);
  const clone2Paths = findOut2.trim().split('\n').filter(Boolean).sort();

  // Map clone2 paths to their relative equivalents for comparison
  for (const clone2AbsPath of clone2Paths) {
    const rel = path.relative(clone2, clone2AbsPath);
    const origAbsPath = path.join(proj, rel);
    const origContent = baseline.get(origAbsPath);
    assert(origContent !== undefined,
      `scenario 7: clone2 produced unexpected output ${rel} (not in baseline)`);
    const clone2Content = await readFile(clone2AbsPath);
    assert(origContent.equals(clone2Content),
      `scenario 7: output ${rel} differs between original and clone2`);
  }
  assert(clone2Paths.length === renderedPaths.length,
    `scenario 7: clone2 produced ${clone2Paths.length} files vs baseline ${renderedPaths.length}`);
  console.log('harness: rac-lock.json scenario 7 (two clones --frozen-lockfile → byte-identical) ok');
}

async function setupLockfileSmoke(tmpRoot) {
  const proj = path.join(tmpRoot, 'lockfile-project');
  await mkdir(proj, { recursive: true });

  // Create a local bare repo to act as the pack remote.
  // setupLocalBarePackRepo creates the bare repo at <dir>/bare.git
  const bareParentDir = path.join(tmpRoot, 'lockfile-bare-pack');
  const bareUrl = await setupLocalBarePackRepo(bareParentDir);
  const bareDir = path.join(bareParentDir, 'bare.git');
  const tmpGitConfig = path.join(tmpRoot, 'lockfile-gitconfig');
  await writeFile(
    tmpGitConfig,
    `[url "${bareUrl}"]\n\tinsteadOf = https://github.com/smoke/lockfile-pack.git\n`,
    'utf8'
  );
  const lockEnv = { ...process.env, GIT_CONFIG_GLOBAL: tmpGitConfig };

  await setupLockfileSmokeBasic(proj, lockEnv, bareDir);
  await setupLockfileSmokeAdvanced(proj, lockEnv);

  console.log('harness: rac-lock.json all scenarios ok');
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
    await setupLockfileSmoke(tmpRoot);
    await setupPackOverrideScope(tmpRoot);

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
