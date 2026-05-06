import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it, afterEach } from 'vitest';

import { adapterFor, TARGET_ADAPTERS } from '../src/adapters/target-adapters.js';
import { buildRuntimeConfig } from '../src/core/config-model.js';
import { doctor, initProject, install } from '../src/core/install.js';
import { addProjectPack, listProjectPacks, removeProjectPack } from '../src/core/pack-config.js';
import { loadAgents, loadMcps, loadProjectPackConfig, loadRules, loadSharedPackConfig, loadSkills } from '../src/core/parsers.js';
import { MANAGED_JSONC_WARNING, MANAGED_MARKDOWN_WARNING, MANAGED_TOML_WARNING } from '../src/core/util.js';

const tempDirs: string[] = [];
let cliBuilt = false;

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rac-'));
  tempDirs.push(dir);
  return dir;
}

async function readJsoncFile<T>(filePath: string): Promise<T> {
  return parseJsonc(await readFile(filePath, 'utf8')) as T;
}

function runCli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  if (!cliBuilt) {
    const build = spawnSync('npm', ['run', 'build'], { cwd: process.cwd(), encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`failed building CLI for tests: ${build.stderr || build.stdout}`);
    cliBuilt = true;
  }
  const result = spawnSync('node', [path.join(process.cwd(), 'dist/cli.js'), ...args], { cwd, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function seed(root: string): Promise<void> {
  await mkdir(path.join(root, '.rac/agents'), { recursive: true });
  await mkdir(path.join(root, '.rac/skills/project-gates'), { recursive: true });
  await mkdir(path.join(root, '.rac/mcps'), { recursive: true });
  await mkdir(path.join(root, '.rac/rules'), { recursive: true });
  await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');

  await writeFile(path.join(root, '.rac/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "./reviewer.md"\n[vendor.codex]\nemit = "instruction-only"\n[vendor.opencode]\ntools = ["legacy"]\n', 'utf8');
  await writeFile(path.join(root, '.rac/agents/reviewer.md'), 'Review this project.\n', 'utf8');

  await writeFile(path.join(root, '.rac/skills/project-gates/SKILL.md'), '+++\ndescription = "project checks"\nassets = ["checklist.md"]\n[vendor.claude.frontmatter]\naudience = "claude"\n[vendor.codex.frontmatter]\naudience = "codex"\n[vendor.opencode.frontmatter]\naudience = "opencode"\n+++\nRun checks\n', 'utf8');
  await writeFile(path.join(root, '.rac/skills/project-gates/checklist.md'), '- test\n', 'utf8');

  await writeFile(path.join(root, '.rac/mcps/project-rules.toml'), 'id = "project-rules"\ncommand = "node"\nargs = ["./mcp.js", "${PROJECT_RULES_TOKEN}"]\nstartup_timeout_ms = 1200\n', 'utf8');

  await writeFile(path.join(root, '.rac/rules/wrappers.toml'), '[[rule]]\nid = "deny-gh-pr-merge"\ndecision = "forbidden"\njustification = "Use wrapper"\ncommand = ["gh", ["pr", "issue"], "merge"]\n\n[[rule]]\nid = "deny-git-push"\ndecision = "forbidden"\njustification = "Use wrapper"\ncommand = ["git", "push"]\nappend_wildcard = false\n', 'utf8');
}

describe('parsers', () => {
  it('pack config add/list/remove enforces validation and preserves unrelated content', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });

    await expect(listProjectPacks(root)).rejects.toThrow('missing required config');
    await expect(addProjectPack(root, { id: 'a', repo: 'github:owner/repo', ref: 'main' })).rejects.toThrow('missing required config');
    await expect(removeProjectPack(root, 'a')).rejects.toThrow('missing required config');

    await writeFile(path.join(root, '.rac/config.toml'), 'title = "demo"\n', 'utf8');

    await expect(addProjectPack(root, { id: 'bad id', repo: 'github:owner/repo', ref: 'main' })).rejects.toThrow('invalid pack id');
    await expect(addProjectPack(root, { id: 'project', repo: 'github:owner/repo', ref: 'main' })).rejects.toThrow('project is reserved');
    await expect(addProjectPack(root, { id: 'good', repo: 'https://github.com/owner/repo', ref: 'main' })).rejects.toThrow('invalid pack repo');
    await expect(addProjectPack(root, { id: 'good', repo: 'github:owner/repo', ref: 'bad ref' })).rejects.toThrow('invalid pack ref');

    const before = await readFile(path.join(root, '.rac/config.toml'), 'utf8');
    await addProjectPack(root, { id: 'alpha', repo: 'github:owner/alpha', ref: 'main' });
    const afterOne = await readFile(path.join(root, '.rac/config.toml'), 'utf8');
    expect(afterOne.startsWith(before)).toBe(true);
    expect(afterOne).toContain('[[packs]]\nid = "alpha"\nrepo = "github:owner/alpha"\nref = "main"\n');

    await addProjectPack(root, { id: 'beta', repo: 'github:owner/beta', ref: 'v1' });
    await expect(addProjectPack(root, { id: 'alpha', repo: 'github:owner/alpha', ref: 'main' })).rejects.toThrow('duplicate pack id');

    const listed = await listProjectPacks(root);
    expect(listed.map((pack) => `${pack.id} ${pack.repo} ${pack.ref}`)).toEqual([
      'alpha github:owner/alpha main',
      'beta github:owner/beta v1'
    ]);

    await expect(removeProjectPack(root, 'missing')).rejects.toThrow('pack not found');
    await removeProjectPack(root, 'alpha');
    const afterRemove = await readFile(path.join(root, '.rac/config.toml'), 'utf8');
    expect(afterRemove).toContain('title = "demo"');
    expect(afterRemove).not.toContain('id = "alpha"');
    expect(afterRemove).toContain('id = "beta"');
    expect((await listProjectPacks(root)).map((pack) => pack.id)).toEqual(['beta']);
  });

  it('cli pack add/list/remove wiring handles required ref, list formatting, escaping, and errors', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), 'title = "demo"\r\n\r\n\r\n[other]\r\nvalue = "keep"\r\n', 'utf8');

    const listEmpty = runCli(root, ['pack', 'list']);
    expect(listEmpty.status).toBe(0);
    expect(listEmpty.stdout).toBe('-\n');

    const missingRef = runCli(root, ['pack', 'add', 'alpha', 'github:owner/alpha']);
    expect(missingRef.status).toBe(2);
    expect(missingRef.stderr).toContain("required option '--ref <ref>'");

    const add = runCli(root, ['pack', 'add', 'alpha', 'github:owner/alpha', '--ref', 'tag"\\candidate']);
    expect(add.status).toBe(0);
    const parsed = parseToml(await readFile(path.join(root, '.rac/config.toml'), 'utf8')) as {
      packs?: Array<{ id?: string; repo?: string; ref?: string }>;
    };
    expect(parsed.packs?.[0]).toEqual({
      id: 'alpha',
      repo: 'github:owner/alpha',
      ref: 'tag"\\candidate'
    });

    const listOne = runCli(root, ['pack', 'list']);
    expect(listOne.status).toBe(0);
    expect(listOne.stdout).toBe('alpha github:owner/alpha tag"\\candidate\n');

    const removeMissing = runCli(root, ['pack', 'remove', 'missing']);
    expect(removeMissing.status).toBe(1);
    expect(removeMissing.stderr).toContain('pack not found: missing');
  });

  it('cli pack remove matches whitespace/commented [[ packs ]] headers and preserves unrelated file fidelity', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    await writeFile(
      path.join(root, '.rac/config.toml'),
      'title = "demo"\r\n\r\n   [[ packs ]]   # keep-comment\r\nid = "alpha"\r\nrepo = "github:owner/alpha"\r\nref = "main"\r\n\r\n\r\n[other]\r\nvalue = "keep"\r\n',
      'utf8'
    );

    const remove = runCli(root, ['pack', 'remove', 'alpha']);
    expect(remove.status).toBe(0);

    const updated = await readFile(path.join(root, '.rac/config.toml'), 'utf8');
    expect(updated).toBe('title = "demo"\r\n\r\n[other]\r\nvalue = "keep"\r\n');
  });

  it('agent parser validates TOML and duplicate ids', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await writeFile(path.join(root, '.rac/agents/a.toml'), 'id = "x"\ninstructions = "hello"\n', 'utf8');
    await writeFile(path.join(root, '.rac/agents/b.toml'), 'id = "x"\ninstructions = "hello"\n', 'utf8');
    await expect(loadAgents(path.join(root, '.rac'), 'project')).rejects.toThrow('duplicate agent id');

    await writeFile(path.join(root, '.rac/agents/b.toml'), 'id = "y"\ninstructions = [broken\n', 'utf8');
    await expect(loadAgents(path.join(root, '.rac'), 'project')).rejects.toThrow('invalid TOML');
  });

  it('skill parser requires +++ at byte 0 and closing delimiter', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/skills/s1'), { recursive: true });
    await writeFile(path.join(root, '.rac/skills/s1/SKILL.md'), 'bad\n+++\ndescription = "x"\n+++\nbody\n', 'utf8');
    await expect(loadSkills(path.join(root, '.rac'), 'project')).rejects.toThrow('byte 0');

    await writeFile(path.join(root, '.rac/skills/s1/SKILL.md'), '+++\ndescription = "x"\nbody\n', 'utf8');
    await expect(loadSkills(path.join(root, '.rac'), 'project')).rejects.toThrow('missing closing +++ delimiter');
  });

  it('mcp parser enforces local xor remote and collects env vars', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/mcps'), { recursive: true });
    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "a"\n', 'utf8');
    await expect(loadMcps(path.join(root, '.rac'), 'project')).rejects.toThrow('local command OR remote type+url');

    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "a"\ncommand = "node"\nargs = ["${X}"]\ntype = "remote"\nurl = "https://x"\n', 'utf8');
    await expect(loadMcps(path.join(root, '.rac'), 'project')).rejects.toThrow('cannot define both local and remote transport');

    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "a"\ncommand = "node"\nargs = ["${X}", "${Y}"]\n', 'utf8');
    const parsed = await loadMcps(path.join(root, '.rac'), 'project');
    expect(parsed[0].envVars).toEqual(['X', 'Y']);
  });

  it('rule parser enforces [[rule]] entries, unique ids, and command validation', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/rules'), { recursive: true });
    await writeFile(path.join(root, '.rac/rules/a.toml'), 'id = "x"\n', 'utf8');
    await expect(loadRules(path.join(root, '.rac'), 'project')).rejects.toThrow('missing [[rule]] entries');

    await writeFile(path.join(root, '.rac/rules/a.toml'), '[[rule]]\nid = "r1"\ndecision = "allow"\njustification = "x"\ncommand = ["git"]\n', 'utf8');
    await expect(loadRules(path.join(root, '.rac'), 'project')).rejects.toThrow('unsupported rule decision');

    await writeFile(path.join(root, '.rac/rules/a.toml'), '[[rule]]\nid = "r1"\ndecision = "forbidden"\njustification = ""\ncommand = ["git"]\n', 'utf8');
    await expect(loadRules(path.join(root, '.rac'), 'project')).rejects.toThrow();

    await writeFile(path.join(root, '.rac/rules/a.toml'), '[[rule]]\nid = "r1"\ndecision = "forbidden"\njustification = "x"\ncommand = []\n', 'utf8');
    await expect(loadRules(path.join(root, '.rac'), 'project')).rejects.toThrow('empty command list');

    await writeFile(path.join(root, '.rac/rules/a.toml'), '[[rule]]\nid = "r1"\ndecision = "forbidden"\njustification = "x"\ncommand = [["git"], []]\n', 'utf8');
    await expect(loadRules(path.join(root, '.rac'), 'project')).rejects.toThrow('empty command alternative array');

    await writeFile(path.join(root, '.rac/rules/a.toml'), '[[rule]]\nid = "r1"\ndecision = "forbidden"\njustification = "x"\ncommand = ["git"]\n', 'utf8');
    await writeFile(path.join(root, '.rac/rules/b.toml'), '[[rule]]\nid = "r1"\ndecision = "forbidden"\njustification = "x"\ncommand = ["gh"]\n', 'utf8');
    await expect(loadRules(path.join(root, '.rac'), 'project')).rejects.toThrow('duplicate rule id');
  });

  it('normalizes definition ids to NFC, rejects unsafe ids, and detects duplicates after normalization', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await mkdir(path.join(root, '.rac/mcps'), { recursive: true });
    await mkdir(path.join(root, '.rac/rules'), { recursive: true });

    await writeFile(path.join(root, '.rac/agents/a.toml'), 'id = "agént"\ninstructions = "ok"\n', 'utf8');
    await writeFile(path.join(root, '.rac/agents/b.toml'), 'id = "age\u0301nt"\ninstructions = "ok"\n', 'utf8');
    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "srv"\ncommand = "node"\n', 'utf8');
    await writeFile(path.join(root, '.rac/rules/a.toml'), '[[rule]]\nid = "rulé"\ndecision = "forbidden"\njustification = "x"\ncommand = ["git"]\n', 'utf8');

    await expect(loadAgents(path.join(root, '.rac'), 'project')).rejects.toThrow('duplicate agent id');

    await writeFile(path.join(root, '.rac/agents/b.toml'), 'id = "helper"\ninstructions = "ok"\n', 'utf8');
    const agents = await loadAgents(path.join(root, '.rac'), 'project');
    expect(agents[0].id).toBe('agént');

    await writeFile(path.join(root, '.rac/agents/b.toml'), 'id = " bad "\ninstructions = "x"\n', 'utf8');
    await expect(loadAgents(path.join(root, '.rac'), 'project')).rejects.toThrow('leading/trailing whitespace');
    await writeFile(path.join(root, '.rac/agents/b.toml'), 'id = ".."\ninstructions = "x"\n', 'utf8');
    await expect(loadAgents(path.join(root, '.rac'), 'project')).rejects.toThrow('invalid agent id');
    await writeFile(path.join(root, '.rac/agents/b.toml'), 'id = "bad/name"\ninstructions = "x"\n', 'utf8');
    await expect(loadAgents(path.join(root, '.rac'), 'project')).rejects.toThrow('path separators');
  });
});

describe('runtime config + adapters', () => {
  it('resolves relative agent instructions and skill assets in runtime config', async () => {
    const root = await makeTmp();
    await seed(root);
    const sourceRoot = path.join(root, '.rac');
    const config = await buildRuntimeConfig({
      root: sourceRoot,
      agents: await loadAgents(sourceRoot, 'project'),
      skills: await loadSkills(sourceRoot, 'project'),
      mcps: await loadMcps(sourceRoot, 'project'),
      rules: await loadRules(sourceRoot, 'project')
    });

    expect(config.agents[0].instructions).toContain('Review this project.');
    expect(config.skills[0].assets[0].relativePath).toBe('checklist.md');
    expect(config.skills[0].assets[0].hash.length).toBeGreaterThan(0);
  });

  it('adapters consume same runtime config and output vendor-specific files', async () => {
    const root = await makeTmp();
    await seed(root);
    const sourceRoot = path.join(root, '.rac');
    const config = await buildRuntimeConfig({
      root: sourceRoot,
      agents: await loadAgents(sourceRoot, 'project'),
      skills: await loadSkills(sourceRoot, 'project'),
      mcps: await loadMcps(sourceRoot, 'project'),
      rules: await loadRules(sourceRoot, 'project')
    });

    const claude = adapterFor('claude').plan(config);
    const codex = adapterFor('codex').plan(config);
    const opencode = adapterFor('opencode').plan(config);

    expect(claude.some((entry) => entry.relPath === '.claude/agents/reviewer.md')).toBe(true);
    expect(codex.some((entry) => entry.relPath === '.codex/agents/reviewer.md')).toBe(true);
    expect(opencode.some((entry) => entry.relPath === '.opencode/agents/reviewer.md')).toBe(true);
  });

  it('preserves skill frontmatter semantics across codex/opencode/claude adapters', async () => {
    const root = await makeTmp();
    await seed(root);
    const sourceRoot = path.join(root, '.rac');
    const config = await buildRuntimeConfig({
      root: sourceRoot,
      agents: await loadAgents(sourceRoot, 'project'),
      skills: await loadSkills(sourceRoot, 'project'),
      mcps: await loadMcps(sourceRoot, 'project'),
      rules: await loadRules(sourceRoot, 'project')
    });

    const claudeSkill = adapterFor('claude')
      .plan(config)
      .find((entry) => entry.kind === 'skill' && entry.relPath === '.claude/skills/project-gates/SKILL.md');
    const codexSkill = adapterFor('codex')
      .plan(config)
      .find((entry) => entry.kind === 'skill' && entry.relPath === '.agents/skills/project-gates/SKILL.md');
    const opencodeSkill = adapterFor('opencode')
      .plan(config)
      .find((entry) => entry.kind === 'skill' && entry.relPath === '.opencode/skills/project-gates/SKILL.md');

    expect(claudeSkill?.content).toContain('description: "project checks"');
    expect(claudeSkill?.content).toContain('audience: "claude"');
    expect(claudeSkill?.content).not.toContain('vendor:');

    expect(codexSkill?.content).toContain('name: "project-gates"');
    expect(codexSkill?.content).toContain('description: "project checks"');
    expect(codexSkill?.content).toContain('audience: "codex"');
    expect(codexSkill?.content).not.toContain('vendor:');

    expect(opencodeSkill?.content).toContain('name: "project-gates"');
    expect(opencodeSkill?.content).toContain('description: "project checks"');
    expect(opencodeSkill?.content).toContain('audience: "opencode"');
    expect(opencodeSkill?.content).not.toContain('vendor:');
  });

  it('registers adapters in table-driven list', () => {
    expect(TARGET_ADAPTERS.map((adapter) => adapter.target).sort()).toEqual(['claude', 'codex', 'opencode']);
  });
});

describe('install + doctor', () => {
  it('init refuses overwrite and install copies only declared assets', async () => {
    const root = await makeTmp();
    await initProject(root, false);
    await expect(initProject(root, false)).rejects.toThrow('refusing to overwrite existing init examples');

    await seed(root);
    await writeFile(path.join(root, '.rac/skills/project-gates/extra.txt'), 'ignored', 'utf8');
    await install({ cwd: root, targets: ['claude'], kinds: ['skill'] });

    await expect(stat(path.join(root, '.claude/skills/project-gates/checklist.md'))).resolves.toBeTruthy();
    await expect(stat(path.join(root, '.claude/skills/project-gates/extra.txt'))).rejects.toThrow();
  });

  it('rejects traversal from agent instructions and skill assets', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await mkdir(path.join(root, '.rac/skills/s1'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');

    await writeFile(path.join(root, '.rac/agents/a.toml'), 'id = "a"\ninstructions = "../../etc/passwd"\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('agent instructions traversal rejected');

    await writeFile(path.join(root, '.rac/agents/a.toml'), 'id = "a"\ninstructions = "inline"\n', 'utf8');
    await writeFile(path.join(root, '.rac/skills/s1/SKILL.md'), '+++\ndescription = "d"\nassets = ["../bad.txt"]\n+++\nbody\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['skill'] })).rejects.toThrow('skill asset traversal rejected');
  });

  it('refuses unmanaged json clobber unless manifest-owned or force, dry-run writes nothing', async () => {
    const root = await makeTmp();
    await seed(root);

    await mkdir(path.join(root, '.opencode'), { recursive: true });
    await writeFile(path.join(root, '.opencode/opencode.jsonc'), '{"external":true}\n', 'utf8');
    await expect(install({ cwd: root, targets: ['opencode'], kinds: ['mcp'] })).rejects.toThrow('refusing overwrite unmanaged file');
    await expect(install({ cwd: root, targets: ['opencode'], kinds: ['mcp'], dryRun: true })).rejects.toThrow('refusing overwrite unmanaged file');

    const beforeManifestMissing = stat(path.join(root, '.codex/.rac-install-manifest.json'));
    await expect(beforeManifestMissing).rejects.toThrow();
    await install({ cwd: root, targets: ['codex'], kinds: ['agent'], dryRun: true });
    await expect(stat(path.join(root, '.codex/.rac-install-manifest.json'))).rejects.toThrow();

    await expect(install({ cwd: root, targets: ['opencode'], kinds: ['mcp'], force: true })).resolves.toBeTruthy();
  });

  it('recognizes new markdown warnings and legacy markers for manifest-loss overwrite safety', async () => {
    const root = await makeTmp();
    await seed(root);

    const agentPath = path.join(root, '.codex/agents/reviewer.md');
    const manifestPath = path.join(root, '.codex/.rac-install-manifest.json');

    await install({ cwd: root, targets: ['codex'], kinds: ['agent'] });
    expect(await readFile(agentPath, 'utf8')).toContain(MANAGED_MARKDOWN_WARNING);

    await rm(manifestPath);
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).resolves.toBeTruthy();

    await rm(manifestPath);
    await writeFile(agentPath, '<!-- managed-by-rac -->\nold generated content\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).resolves.toBeTruthy();
  });

  it('recognizes managed hash and jsonc warnings with CRLF line endings for manifest-loss overwrite safety', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['codex'], kinds: ['mcp'] });
    await rm(path.join(root, '.codex/.rac-install-manifest.json'));
    await writeFile(path.join(root, '.codex/config.toml'), `${MANAGED_TOML_WARNING}\r\n[mcp_servers.project]\r\ncommand = "node"\r\n`, 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['mcp'] })).resolves.toBeTruthy();

    await install({ cwd: root, targets: ['opencode'], kinds: ['mcp'] });
    await rm(path.join(root, '.opencode/.rac-install-manifest.json'));
    await writeFile(path.join(root, '.opencode/opencode.jsonc'), `${MANAGED_JSONC_WARNING}\r\n{\r\n  "mcp": {}\r\n}\r\n`, 'utf8');
    await expect(install({ cwd: root, targets: ['opencode'], kinds: ['mcp'] })).resolves.toBeTruthy();
  });

  it('clean deletes only stale manifest-selected paths', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['codex'], kinds: ['agent'] });
    await rm(path.join(root, '.rac/agents/reviewer.toml'));
    await mkdir(path.join(root, '.codex/agents'), { recursive: true });
    await writeFile(path.join(root, '.codex/agents/keep.md'), 'keep', 'utf8');

    const result = await install({ cwd: root, targets: ['codex'], kinds: ['agent'], clean: true });
    expect(result.del.some((file) => file.endsWith('reviewer.md') || file.endsWith('reviewer.toml'))).toBe(true);
    expect(await readFile(path.join(root, '.codex/agents/keep.md'), 'utf8')).toBe('keep');
  });

  it('aggregates multiple MCP definitions into one shared target config write', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.rac/mcps/z-remote.toml'), 'id = "z-remote"\ntype = "sse"\nurl = "https://example.test/z"\n', 'utf8');
    await writeFile(path.join(root, '.rac/mcps/a-remote.toml'), 'id = "a-remote"\ntype = "sse"\nurl = "https://example.test/a"\n', 'utf8');

    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['mcp'] });

    const claudeProject = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(claudeProject.mcpServers)).toEqual(['a-remote', 'project-rules', 'z-remote']);

    const codexToml = await readFile(path.join(root, '.codex/config.toml'), 'utf8');
    expect(codexToml.startsWith(`${MANAGED_TOML_WARNING}\n`)).toBe(true);
    expect(codexToml.indexOf('[mcp_servers."a-remote"]')).toBeLessThan(codexToml.indexOf('[mcp_servers."project-rules"]'));
    expect(codexToml.indexOf('[mcp_servers."project-rules"]')).toBeLessThan(codexToml.indexOf('[mcp_servers."z-remote"]'));
    expect(codexToml).toContain('startup_timeout_sec = 2');
    expect(codexToml).not.toContain('startup_timeout = ');

    const opencodeRaw = await readFile(path.join(root, '.opencode/opencode.jsonc'), 'utf8');
    expect(opencodeRaw.startsWith(`${MANAGED_JSONC_WARNING}\n`)).toBe(true);
    const opencode = await readJsoncFile<{ mcp: Record<string, { type: string; enabled: boolean; command?: string[]; url?: string }> }>(path.join(root, '.opencode/opencode.jsonc'));
    expect(Object.keys(opencode.mcp)).toEqual(['a-remote', 'project-rules', 'z-remote']);
  });

  it('installs centralized rules for codex/claude/opencode and combines opencode mcp+rule payload', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['mcp', 'rule'] });

    const codexRules = await readFile(path.join(root, '.codex/rules/project/wrappers.toml.rules'), 'utf8');
    expect(codexRules.startsWith(`${MANAGED_TOML_WARNING}\n`)).toBe(true);
    expect(codexRules).toContain('prefix_rule([');
    expect(codexRules).toContain('["gh",["pr","issue"],"merge"]');

    const claudeSettings = JSON.parse(await readFile(path.join(root, '.claude/settings.json'), 'utf8')) as { permissions: { deny: string[] } };
    expect(claudeSettings.permissions.deny).toContain('Bash(gh pr merge *)');
    expect(claudeSettings.permissions.deny).toContain('Bash(gh issue merge *)');
    expect(claudeSettings.permissions.deny).toContain('Bash(git push)');

    const opencode = await readJsoncFile<{ mcp: Record<string, unknown>; permission: { bash: Record<string, string> } }>(path.join(root, '.opencode/opencode.jsonc'));
    expect(opencode.mcp).toBeTruthy();
    expect(opencode.permission.bash['gh pr merge *']).toBe('deny');
    expect(opencode.permission.bash['gh issue merge *']).toBe('deny');
    expect(opencode.permission.bash['git push']).toBe('deny');
  });

  it('preserves OpenCode shared mcp/rule sibling content across separate install/check/clean operations', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['opencode'], kinds: ['mcp'] });
    await install({ cwd: root, targets: ['opencode'], kinds: ['rule'] });

    const combined = await readJsoncFile<{
      mcp?: Record<string, unknown>;
      permission?: { bash?: Record<string, string> };
    }>(path.join(root, '.opencode/opencode.jsonc'));
    expect(combined.mcp).toBeTruthy();
    expect(combined.permission?.bash?.['git push']).toBe('deny');

    await expect(install({ cwd: root, targets: ['opencode'], kinds: ['mcp'], check: true })).resolves.toBeTruthy();

    await rm(path.join(root, '.rac/rules/wrappers.toml'));
    await install({ cwd: root, targets: ['opencode'], kinds: ['rule'], clean: true });
    const cleaned = await readJsoncFile<{
      mcp?: Record<string, unknown>;
      permission?: unknown;
    }>(path.join(root, '.opencode/opencode.jsonc'));
    expect(cleaned.mcp).toBeTruthy();
    expect(cleaned.permission).toBeUndefined();
  });

  it('migrates managed legacy OpenCode shared mcp/rule sibling manifest records during single-kind install', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['opencode'], kinds: ['mcp', 'rule'] });
    const legacyPath = path.join(root, '.opencode/opencode.json');
    const jsoncPath = path.join(root, '.opencode/opencode.jsonc');
    const manifestPath = path.join(root, '.opencode/.rac-install-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      version: number;
      records: Array<{ kind: string; relPath: string; hash: string }>;
    };
    manifest.records = manifest.records.map((record) => ({ ...record, relPath: '.opencode/opencode.json' }));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rm(jsoncPath);
    await writeFile(
      legacyPath,
      '{\n  "mcp": {\n    "legacy": { "type": "local", "enabled": true, "command": ["node"] }\n  },\n  "permission": {\n    "bash": {\n      "legacy cmd": "deny"\n    }\n  }\n}\n',
      'utf8'
    );

    await expect(install({ cwd: root, targets: ['opencode'], kinds: ['mcp'], check: true })).rejects.toThrow('stale managed output requires cleanup');
    await expect(stat(legacyPath)).resolves.toBeTruthy();

    await install({ cwd: root, targets: ['opencode'], kinds: ['mcp'] });
    await expect(stat(legacyPath)).rejects.toThrow();
    await expect(stat(jsoncPath)).resolves.toBeTruthy();
    const migrated = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      records: Array<{ kind: string; relPath: string; hash: string }>;
    };
    const mcpRecord = migrated.records.find((record) => record.kind === 'mcp');
    const ruleRecord = migrated.records.find((record) => record.kind === 'rule');
    expect(mcpRecord?.relPath).toBe('.opencode/opencode.jsonc');
    expect(ruleRecord?.relPath).toBe('.opencode/opencode.jsonc');
    expect(mcpRecord?.hash).toBe(ruleRecord?.hash);

    await expect(install({ cwd: root, targets: ['opencode'], kinds: ['mcp'], check: true })).resolves.toBeTruthy();
    await install({ cwd: root, targets: ['opencode'], kinds: ['rule'] });
    await expect(install({ cwd: root, targets: ['opencode'], kinds: ['rule'], check: true })).resolves.toBeTruthy();
  });

  it('vendor compatibility schema: OpenCode MCP emits local/remote typed entries and rejects legacy command object shape', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.rac/mcps/a-remote.toml'), 'id = "a-remote"\ntype = "sse"\nurl = "https://example.test/a"\n', 'utf8');

    await install({ cwd: root, targets: ['opencode'], kinds: ['mcp'] });

    const opencode = await readJsoncFile<{
      mcp: Record<string, { type: string; enabled: boolean; command?: unknown; url?: unknown }>;
    }>(path.join(root, '.opencode/opencode.jsonc'));

    expect(opencode.mcp['project-rules']).toEqual({
      type: 'local',
      enabled: true,
      command: ['node', './mcp.js', '${PROJECT_RULES_TOKEN}']
    });
    expect(opencode.mcp['a-remote']).toEqual({
      type: 'remote',
      enabled: true,
      url: 'https://example.test/a'
    });

    const local = opencode.mcp['project-rules'] as { command?: unknown; args?: unknown };
    expect(Array.isArray(local.command)).toBe(true);
    expect(local).not.toHaveProperty('args');
    expect(local.command).not.toEqual({ command: 'node', args: ['./mcp.js', '${PROJECT_RULES_TOKEN}'] });
  });

  it('vendor compatibility schema: Codex MCP config emits startup_timeout_sec and never startup_timeout', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['codex'], kinds: ['mcp'] });
    const codexToml = await readFile(path.join(root, '.codex/config.toml'), 'utf8');

    expect(codexToml).toContain('startup_timeout_sec = 2');
    expect(codexToml).not.toContain('startup_timeout = ');
  });

  it('clean keeps shared MCP config path when still used by current MCP set', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.rac/mcps/remote.toml'), 'id = "remote"\ntype = "sse"\nurl = "https://example.test/mcp"\n', 'utf8');
    await install({ cwd: root, targets: ['claude'], kinds: ['mcp'] });

    await rm(path.join(root, '.rac/mcps/remote.toml'));
    const result = await install({ cwd: root, targets: ['claude'], kinds: ['mcp'], clean: true });
    expect(result.del).not.toContain(path.join(root, '.mcp.json'));

    const kept = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(kept.mcpServers)).toEqual(['project-rules']);
  });

  it('real install writes vendor-local manifests and never central manifest', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['agent', 'skill', 'mcp'] });

    await expect(stat(path.join(root, '.claude/.rac-install-manifest.json'))).resolves.toBeTruthy();
    await expect(stat(path.join(root, '.codex/.rac-install-manifest.json'))).resolves.toBeTruthy();
    await expect(stat(path.join(root, '.agents/.rac-install-manifest.json'))).resolves.toBeTruthy();
    await expect(stat(path.join(root, '.opencode/.rac-install-manifest.json'))).resolves.toBeTruthy();
    await expect(stat(path.join(root, '.rac/.install-manifest.json'))).rejects.toThrow();
  });

  it('codex uses separate manifests for .codex outputs and .agents skills', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['codex'], kinds: ['agent', 'skill', 'mcp'] });

    const codexManifest = JSON.parse(await readFile(path.join(root, '.codex/.rac-install-manifest.json'), 'utf8')) as {
      records: Array<{ kind: string; relPath: string }>;
    };
    const agentsManifest = JSON.parse(await readFile(path.join(root, '.agents/.rac-install-manifest.json'), 'utf8')) as {
      records: Array<{ kind: string; relPath: string }>;
    };

    expect(codexManifest.records.every((record) => record.kind !== 'skill')).toBe(true);
    expect(codexManifest.records.every((record) => record.relPath.startsWith('.codex/'))).toBe(true);
    expect(agentsManifest.records.every((record) => record.kind === 'skill')).toBe(true);
    expect(agentsManifest.records.every((record) => record.relPath.startsWith('.agents/skills/'))).toBe(true);
  });

  it('claude mcp records live in .claude manifest while output file remains .mcp.json', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['claude'], kinds: ['mcp'] });

    const manifest = JSON.parse(await readFile(path.join(root, '.claude/.rac-install-manifest.json'), 'utf8')) as {
      records: Array<{ kind: string; relPath: string }>;
    };
    expect(manifest.records.every((record) => record.kind === 'mcp')).toBe(true);
    expect(manifest.records.every((record) => record.relPath === '.mcp.json')).toBe(true);
    await expect(stat(path.join(root, '.mcp.json'))).resolves.toBeTruthy();
  });

  it('manifest records include pack and inventory excludes relPath', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['codex'], kinds: ['agent'] });

    const manifest = JSON.parse(await readFile(path.join(root, '.codex/.rac-install-manifest.json'), 'utf8')) as {
      records: Array<Record<string, unknown>>;
    };
    expect(manifest.records.length).toBeGreaterThan(0);
    for (const record of manifest.records) {
      expect(record.pack).toBe('project');
      expect(typeof record.relPath).toBe('string');
      const inventory = (record.inventory as Array<Record<string, unknown>> | undefined) ?? [];
      for (const entry of inventory) expect(entry).not.toHaveProperty('relPath');
      expect(record).not.toHaveProperty('path');
    }
  });

  it('mcp inventory selectors are present for claude/codex/opencode shared config entries', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['mcp'] });

    const claudeManifest = JSON.parse(await readFile(path.join(root, '.claude/.rac-install-manifest.json'), 'utf8')) as {
      records: Array<{ id: string; inventory: Array<{ selector: string }> }>;
    };
    const codexManifest = JSON.parse(await readFile(path.join(root, '.codex/.rac-install-manifest.json'), 'utf8')) as {
      records: Array<{ id: string; inventory: Array<{ selector: string }> }>;
    };
    const opencodeManifest = JSON.parse(await readFile(path.join(root, '.opencode/.rac-install-manifest.json'), 'utf8')) as {
      records: Array<{ id: string; inventory: Array<{ selector: string }> }>;
    };

    for (const record of claudeManifest.records) expect(record.inventory[0]?.selector).toBe(`$["mcpServers"][${JSON.stringify(record.id)}]`);
    for (const record of codexManifest.records) expect(record.inventory[0]?.selector).toBe(`mcp_servers.${JSON.stringify(record.id)}`);
    for (const record of opencodeManifest.records) expect(record.inventory[0]?.selector).toBe(`$["mcp"][${JSON.stringify(record.id)}]`);
  });

  it('uses escaped toml keys and bracket-safe jsonpath selectors for dynamic ids', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.rac/mcps/special.toml'), 'id = "dot id \\"x\\".日本語"\ncommand = "node"\n', 'utf8');
    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['mcp'] });

    const codexToml = await readFile(path.join(root, '.codex/config.toml'), 'utf8');
    expect(codexToml).toContain('[mcp_servers."dot id \\"x\\".日本語"]');

    const claudeManifest = JSON.parse(await readFile(path.join(root, '.claude/.rac-install-manifest.json'), 'utf8')) as {
      records: Array<{ id: string; inventory: Array<{ selector: string }> }>;
    };
    const codexManifest = JSON.parse(await readFile(path.join(root, '.codex/.rac-install-manifest.json'), 'utf8')) as {
      records: Array<{ id: string; inventory: Array<{ selector: string }> }>;
    };
    const opencodeManifest = JSON.parse(await readFile(path.join(root, '.opencode/.rac-install-manifest.json'), 'utf8')) as {
      records: Array<{ id: string; inventory: Array<{ selector: string }> }>;
    };
    const wanted = 'dot id "x".日本語';
    expect(claudeManifest.records.find((r) => r.id === wanted)?.inventory[0]?.selector).toBe('$["mcpServers"]["dot id \\"x\\".日本語"]');
    expect(codexManifest.records.find((r) => r.id === wanted)?.inventory[0]?.selector).toBe('mcp_servers."dot id \\"x\\".日本語"');
    expect(opencodeManifest.records.find((r) => r.id === wanted)?.inventory[0]?.selector).toBe('$["mcp"]["dot id \\"x\\".日本語"]');
  });

  it('rejects invalid manifest schema and unsafe manifest record paths before deletes', async () => {
    const invalidJsonRoot = await makeTmp();
    await seed(invalidJsonRoot);
    await install({ cwd: invalidJsonRoot, targets: ['codex'], kinds: ['agent'] });
    await writeFile(path.join(invalidJsonRoot, '.codex/.rac-install-manifest.json'), '{invalid', 'utf8');
    await expect(install({ cwd: invalidJsonRoot, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('invalid RAC install manifest');

    const badVersionRoot = await makeTmp();
    await seed(badVersionRoot);
    await install({ cwd: badVersionRoot, targets: ['codex'], kinds: ['agent'] });
    await writeFile(path.join(badVersionRoot, '.codex/.rac-install-manifest.json'), JSON.stringify({ version: 2, records: [] }), 'utf8');
    await expect(install({ cwd: badVersionRoot, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('invalid RAC install manifest');

    const unsafePathRoot = await makeTmp();
    await seed(unsafePathRoot);
    await install({ cwd: unsafePathRoot, targets: ['codex'], kinds: ['agent'] });
    const outsideFile = path.join(path.dirname(unsafePathRoot), 'outside-should-stay.txt');
    await writeFile(outsideFile, 'dont touch', 'utf8');
    await writeFile(
      path.join(unsafePathRoot, '.codex/.rac-install-manifest.json'),
      JSON.stringify({
        version: 1,
        records: [{
          version: 1,
          pack: 'project',
          target: 'codex',
          kind: 'agent',
          id: 'x',
          source: 'agents/x.toml',
          relPath: '../outside-should-stay.txt',
          hash: 'abc',
          inventory: [{ version: 1, format: 'file', selector: '$' }]
        }]
      }),
      'utf8'
    );
    await expect(install({ cwd: unsafePathRoot, targets: ['codex'], kinds: ['agent'], clean: true })).rejects.toThrow('invalid RAC install manifest');
    expect(await readFile(outsideFile, 'utf8')).toBe('dont touch');
  });

  it('dry-run writes no vendor manifests and no central manifest', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['agent', 'skill', 'mcp'], dryRun: true });

    await expect(stat(path.join(root, '.claude/.rac-install-manifest.json'))).rejects.toThrow();
    await expect(stat(path.join(root, '.codex/.rac-install-manifest.json'))).rejects.toThrow();
    await expect(stat(path.join(root, '.agents/.rac-install-manifest.json'))).rejects.toThrow();
    await expect(stat(path.join(root, '.opencode/.rac-install-manifest.json'))).rejects.toThrow();
    await expect(stat(path.join(root, '.rac/.install-manifest.json'))).rejects.toThrow();
  });

  it('install --check passes after install and fails when generated outputs drift', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['agent', 'skill', 'mcp'] });
    await expect(install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['agent', 'skill', 'mcp'], check: true })).resolves.toBeTruthy();

    await rm(path.join(root, '.claude/agents/reviewer.md'));
    await expect(install({ cwd: root, targets: ['claude'], kinds: ['agent'], check: true })).rejects.toThrow('missing generated output');
    await install({ cwd: root, targets: ['claude'], kinds: ['agent'] });

    await writeFile(path.join(root, '.codex/agents/reviewer.md'), 'tampered\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'], check: true })).rejects.toThrow('different generated output');
  });

  it('install --check reports stale managed outputs needing cleanup and does not delete', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['codex'], kinds: ['agent'] });
    await rm(path.join(root, '.rac/agents/reviewer.toml'));
    await rm(path.join(root, '.rac/agents/reviewer.md'));

    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'], check: true })).rejects.toThrow('stale managed output requires cleanup');
    await expect(stat(path.join(root, '.codex/agents/reviewer.md'))).resolves.toBeTruthy();
  });

  it('vendor compatibility schema: Codex agent TOML emits name/description/developer_instructions and rejects id/instructions keys', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');
    await writeFile(path.join(root, '.rac/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "./reviewer.md"\n', 'utf8');
    await writeFile(path.join(root, '.rac/agents/reviewer.md'), 'line "one"\nline two\n', 'utf8');

    await install({ cwd: root, targets: ['codex'], kinds: ['agent'] });
    const toml = await readFile(path.join(root, '.codex/agents/reviewer.toml'), 'utf8');
    expect(toml.startsWith(`${MANAGED_TOML_WARNING}\n`)).toBe(true);
    const parsed = parseToml(toml) as Record<string, unknown>;

    expect(toml).toContain('name = "reviewer"');
    expect(toml).toContain('description = "reviewer"');
    expect(toml).toContain('developer_instructions = "line \\"one\\"\\nline two\\n"');
    expect(Object.keys(parsed).sort()).toEqual(['description', 'developer_instructions', 'name']);
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('instructions');
  });

  it('vendor pass-through: Codex agent TOML keeps model/model_reasoning_effort/sandbox_mode from vendor.codex.config', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');
    await writeFile(
      path.join(root, '.rac/agents/reviewer.toml'),
      'id = "reviewer"\ninstructions = "./reviewer.md"\n[vendor.codex.config]\nmodel = "gpt-5"\nmodel_reasoning_effort = "high"\nsandbox_mode = "workspace-write"\n',
      'utf8'
    );
    await writeFile(path.join(root, '.rac/agents/reviewer.md'), 'Review.\n', 'utf8');

    await install({ cwd: root, targets: ['codex'], kinds: ['agent'] });
    const toml = await readFile(path.join(root, '.codex/agents/reviewer.toml'), 'utf8');
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).toContain('model_reasoning_effort = "high"');
    expect(toml).toContain('sandbox_mode = "workspace-write"');
  });

  it('persists skill assets in manifest and keeps reinstall idempotent', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['codex'], kinds: ['skill'] });
    const manifestPath = path.join(root, '.agents/.rac-install-manifest.json');
    const manifestOne = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      records: Array<{ relPath: string; hash: string; kind: string; inventory: Array<{ selector: string }> }>;
    };
    const assetRecord = manifestOne.records.find((record) => record.relPath === '.agents/skills/project-gates/checklist.md');
    expect(assetRecord?.kind).toBe('skill');
    expect(assetRecord?.hash && assetRecord.hash.length > 0).toBe(true);
    expect(assetRecord?.inventory[0]?.selector).toBe('$');
    expect(assetRecord?.relPath.includes('\\')).toBe(false);

    await expect(install({ cwd: root, targets: ['codex'], kinds: ['skill'] })).resolves.toBeTruthy();
    const manifestTwo = JSON.parse(await readFile(manifestPath, 'utf8')) as { records: unknown[] };
    expect(manifestTwo.records).toEqual(manifestOne.records);
  });

  it('clean removes empty vendor manifest after last record is removed', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['codex'], kinds: ['agent'] });

    await rm(path.join(root, '.rac/agents/reviewer.toml'));
    await rm(path.join(root, '.rac/agents/reviewer.md'));
    await install({ cwd: root, targets: ['codex'], kinds: ['agent'], clean: true });

    await expect(stat(path.join(root, '.codex/.rac-install-manifest.json'))).rejects.toThrow();
  });

  it('doctor emits expected warnings for env, codex instruction-only, opencode legacy tools', async () => {
    const root = await makeTmp();
    await seed(root);

    const warnings = await doctor(root, ['codex', 'opencode'], ['agent', 'mcp']);
    expect(warnings.join('\n')).toContain('missing env var: PROJECT_RULES_TOKEN');
    expect(warnings.join('\n')).toContain('codex instruction-only emit configured for agent reviewer');
    expect(warnings.join('\n')).toContain('opencode vendor tools is legacy for agent reviewer');
  });

  it('vendor pass-through: MCP config supports vendor.<target>.config for claude/codex/opencode', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/mcps'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');
    await writeFile(
      path.join(root, '.rac/mcps/server.toml'),
      'id = "server"\ncommand = "node"\nargs = ["./mcp.js"]\n[vendor.claude.config]\nnotes = "claude"\n[vendor.codex.config]\nenabled = true\n[vendor.opencode.config]\nreadOnly = true\n',
      'utf8'
    );
    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['mcp'] });

    const claudeProject = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(claudeProject.mcpServers.server.notes).toBe('claude');

    const codexToml = await readFile(path.join(root, '.codex/config.toml'), 'utf8');
    expect(codexToml).toContain('enabled = true');

    const opencode = await readJsoncFile<{ mcp: Record<string, Record<string, unknown>> }>(path.join(root, '.opencode/opencode.jsonc'));
    expect(opencode.mcp.server.readOnly).toBe(true);
  });

  it('vendor pass-through: skill vendor.<target>.config overlays markdown frontmatter for claude/codex/opencode', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/skills/s1'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');
    await writeFile(
      path.join(root, '.rac/skills/s1/SKILL.md'),
      '+++\ndescription = "skill"\n[vendor.claude.config]\naudience = "claude-config"\n[vendor.codex.config]\nmodel = "gpt-5"\n[vendor.opencode.config]\nenabled = true\n+++\nbody\n',
      'utf8'
    );

    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['skill'] });

    const claudeSkill = await readFile(path.join(root, '.claude/skills/s1/SKILL.md'), 'utf8');
    expect(claudeSkill).toContain(MANAGED_MARKDOWN_WARNING);
    expect(claudeSkill).not.toContain('managed-by-rac');
    expect(claudeSkill).not.toContain('rac-frontmatter-sensitive');
    expect(claudeSkill).toContain('name: "s1"');
    expect(claudeSkill).toContain('description: "skill"');
    expect(claudeSkill).toContain('audience: "claude-config"');

    const codexSkill = await readFile(path.join(root, '.agents/skills/s1/SKILL.md'), 'utf8');
    expect(codexSkill).toContain(MANAGED_MARKDOWN_WARNING);
    expect(codexSkill).not.toContain('managed-by-rac');
    expect(codexSkill).not.toContain('rac-frontmatter-sensitive');
    expect(codexSkill).toContain('name: "s1"');
    expect(codexSkill).toContain('description: "skill"');
    expect(codexSkill).toContain('model: "gpt-5"');

    const opencodeSkill = await readFile(path.join(root, '.opencode/skills/s1/SKILL.md'), 'utf8');
    expect(opencodeSkill).toContain(MANAGED_MARKDOWN_WARNING);
    expect(opencodeSkill).not.toContain('managed-by-rac');
    expect(opencodeSkill).not.toContain('rac-frontmatter-sensitive');
    expect(opencodeSkill).toContain('name: "s1"');
    expect(opencodeSkill).toContain('description: "skill"');
    expect(opencodeSkill).toContain('enabled: true');
  });

  it('fails fast on vendor collision with generated keys and on instruction-only + codex config incompatibility', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');
    await writeFile(
      path.join(root, '.rac/agents/reviewer.toml'),
      'id = "reviewer"\ninstructions = "inline"\n[vendor.codex.config]\nname = "nope"\n',
      'utf8'
    );
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('collides with generated key: name');

    await writeFile(
      path.join(root, '.rac/agents/reviewer.toml'),
      'id = "reviewer"\ninstructions = "inline"\n[vendor.codex]\nemit = "instruction-only"\n[vendor.codex.config]\nmodel = "gpt-5"\n',
      'utf8'
    );
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('cannot combine vendor.codex.emit=instruction-only with vendor.codex.config');

    await mkdir(path.join(root, '.rac/skills/s1'), { recursive: true });
    await writeFile(
      path.join(root, '.rac/skills/s1/SKILL.md'),
      '+++\ndescription = "skill"\n[vendor.claude.frontmatter]\nname = "bad"\n+++\nbody\n',
      'utf8'
    );
    await expect(install({ cwd: root, targets: ['claude'], kinds: ['skill'] })).rejects.toThrow('vendor.claude.frontmatter collides with generated keys: name');

    await writeFile(
      path.join(root, '.rac/skills/s1/SKILL.md'),
      '+++\ndescription = "skill"\n[vendor.codex.config]\nname = "bad"\n+++\nbody\n',
      'utf8'
    );
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['skill'] })).rejects.toThrow('vendor.codex.config collides with generated keys: name');

    await writeFile(
      path.join(root, '.rac/skills/s1/SKILL.md'),
      '+++\ndescription = "skill"\n[vendor.opencode.config]\naudience = "config"\n[vendor.opencode.frontmatter]\naudience = "frontmatter"\n+++\nbody\n',
      'utf8'
    );
    await expect(install({ cwd: root, targets: ['opencode'], kinds: ['skill'] })).rejects.toThrow('vendor.opencode.config conflicts with vendor.opencode.frontmatter: audience');
  });

  it('package scripts include lint and lint:fix', async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.lint).toBeDefined();
    expect(packageJson.scripts?.['lint:fix']).toBeDefined();
  });

  it('init and init --empty always create .rac/config.toml', async () => {
    const root = await makeTmp();
    await initProject(root, true);
    await expect(stat(path.join(root, '.rac/config.toml'))).resolves.toBeTruthy();

    await writeFile(path.join(root, '.rac/config.toml'), '[[packs]]\nid = "shared"\nrepo = "github:owner/repo"\nref = "main"\n', 'utf8');
    await initProject(root, true);
    expect(await readFile(path.join(root, '.rac/config.toml'), 'utf8')).toContain('id = "shared"');
  });

  it('requires project .rac/config.toml and validates packs config', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await writeFile(path.join(root, '.rac/agents/a.toml'), 'id = "a"\ninstructions = "x"\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('missing required config');

    await writeFile(path.join(root, '.rac/config.toml'), '[[packs]]\nid = "bad id"\nrepo = "github:owner/repo"\nref = "main"\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('invalid pack id');

    await writeFile(path.join(root, '.rac/config.toml'), '[[packs]]\nid = "project"\nrepo = "github:owner/repo"\nref = "main"\n', 'utf8');
    await expect(loadProjectPackConfig(path.join(root, '.rac'))).rejects.toThrow('project is reserved');

    await writeFile(path.join(root, '.rac/config.toml'), '[[packs]]\nid = "shared"\nrepo = "github:owner/repo"\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('missing packs.ref');

    await writeFile(path.join(root, '.rac/config.toml'), '[[packs]]\nid = "shared"\nrepo = "https://github.com/owner/repo"\nref = "main"\n', 'utf8');
    await expect(loadProjectPackConfig(path.join(root, '.rac'))).rejects.toThrow('invalid pack repo');

    await writeFile(path.join(root, '.rac/config.toml'), '[[packs]]\nid = "shared"\nrepo = "github:owner/repo"\nref = "bad ref"\n', 'utf8');
    await expect(loadProjectPackConfig(path.join(root, '.rac'))).rejects.toThrow('invalid pack ref');
  });

  it('accepts empty shared config and rejects shared transitive packs', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');
    await expect(loadSharedPackConfig(path.join(root, '.rac'))).resolves.toBeUndefined();

    await writeFile(path.join(root, '.rac/config.toml'), '[[packs]]\nid = "nested"\nrepo = "github:owner/repo"\nref = "main"\n', 'utf8');
    await expect(loadSharedPackConfig(path.join(root, '.rac'))).rejects.toThrow('shared pack config cannot contain [[packs]]');
  });

  it('fails fast on duplicate kind/id across active packs', async () => {
    if (spawnSync('git', ['--version']).status !== 0) return;
    const root = await makeTmp();
    const cacheRoot = path.join(root, '.cache');
    process.env.RAC_CACHE_DIR = cacheRoot;
    try {
      const remote = path.join(root, 'remote');
      await mkdir(path.join(remote, '.rac/agents'), { recursive: true });
      await writeFile(path.join(remote, '.rac/config.toml'), '', 'utf8');
      await writeFile(path.join(remote, '.rac/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "shared"\n', 'utf8');
      spawnSync('git', ['init'], { cwd: remote });
      spawnSync('git', ['add', '.'], { cwd: remote });
      spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: remote });
      await mkdir(path.join(root, '.rac/agents'), { recursive: true });
      await writeFile(path.join(root, '.rac/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "project"\n', 'utf8');
      await writeFile(path.join(root, '.rac/config.toml'), '[[packs]]\nid = "shared"\nrepo = "github:owner/repo"\nref = "HEAD"\n', 'utf8');

      const key = Buffer.from('github:owner/repo@HEAD').toString('base64url');
      const cachedRepo = path.join(cacheRoot, 'packs', key);
      await mkdir(path.dirname(cachedRepo), { recursive: true });
      spawnSync('git', ['clone', remote, cachedRepo]);

      await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('duplicate agent id across packs');
      await expect(doctor(root, ['codex'], ['agent'])).rejects.toThrow('duplicate agent id across packs');
    } finally {
      delete process.env.RAC_CACHE_DIR;
    }
  });

  it('uses pack-aware codex rule paths', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['codex'], kinds: ['rule'] });
    await expect(stat(path.join(root, '.codex/rules/project/wrappers.toml.rules'))).resolves.toBeTruthy();
  });

  it('rejects planned-output collisions when different content targets same path', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');
    await writeFile(path.join(root, '.rac/agents/a.toml'), 'id = "same"\ninstructions = "A"\n', 'utf8');
    await writeFile(path.join(root, '.rac/agents/b.toml'), 'id = "same"\ninstructions = "B"\n', 'utf8');
    await expect(install({ cwd: root, targets: ['claude'], kinds: ['agent'] })).rejects.toThrow();
  });
});
