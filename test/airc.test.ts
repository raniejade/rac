import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';

import { adapterFor, TARGET_ADAPTERS } from '../src/adapters/target-adapters.js';
import { buildRuntimeConfig } from '../src/core/config-model.js';
import { doctor, initScope, install } from '../src/core/install.js';
import { loadAgents, loadMcps, loadSkills } from '../src/core/parsers.js';

const tempDirs: string[] = [];

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'airc-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function seed(root: string): Promise<void> {
  await mkdir(path.join(root, '.airc/agents'), { recursive: true });
  await mkdir(path.join(root, '.airc/skills/project-gates'), { recursive: true });
  await mkdir(path.join(root, '.airc/mcps'), { recursive: true });

  await writeFile(path.join(root, '.airc/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "./reviewer.md"\n[vendor.codex]\nemit = "instruction-only"\n[vendor.opencode]\ntools = ["legacy"]\n', 'utf8');
  await writeFile(path.join(root, '.airc/agents/reviewer.md'), 'Review this project.\n', 'utf8');

  await writeFile(path.join(root, '.airc/skills/project-gates/SKILL.md'), '+++\ndescription = "project checks"\nassets = ["checklist.md"]\n[vendor.claude.frontmatter]\ndescription = "claude override"\n+++\nRun checks\n', 'utf8');
  await writeFile(path.join(root, '.airc/skills/project-gates/checklist.md'), '- test\n', 'utf8');

  await writeFile(path.join(root, '.airc/mcps/project-rules.toml'), 'id = "project-rules"\ncommand = "node"\nargs = ["./mcp.js", "${PROJECT_RULES_TOKEN}"]\nstartup_timeout_ms = 1200\n', 'utf8');
}

describe('parsers', () => {
  it('agent parser validates TOML and duplicate ids', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.airc/agents'), { recursive: true });
    await writeFile(path.join(root, '.airc/agents/a.toml'), 'id = "x"\ninstructions = "hello"\n', 'utf8');
    await writeFile(path.join(root, '.airc/agents/b.toml'), 'id = "x"\ninstructions = "hello"\n', 'utf8');
    await expect(loadAgents(path.join(root, '.airc'))).rejects.toThrow('duplicate agent id');

    await writeFile(path.join(root, '.airc/agents/b.toml'), 'id = "y"\ninstructions = [broken\n', 'utf8');
    await expect(loadAgents(path.join(root, '.airc'))).rejects.toThrow('invalid TOML');
  });

  it('skill parser requires +++ at byte 0 and closing delimiter', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.airc/skills/s1'), { recursive: true });
    await writeFile(path.join(root, '.airc/skills/s1/SKILL.md'), 'bad\n+++\ndescription = "x"\n+++\nbody\n', 'utf8');
    await expect(loadSkills(path.join(root, '.airc'))).rejects.toThrow('byte 0');

    await writeFile(path.join(root, '.airc/skills/s1/SKILL.md'), '+++\ndescription = "x"\nbody\n', 'utf8');
    await expect(loadSkills(path.join(root, '.airc'))).rejects.toThrow('missing closing +++ delimiter');
  });

  it('mcp parser enforces local xor remote and collects env vars', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.airc/mcps'), { recursive: true });
    await writeFile(path.join(root, '.airc/mcps/a.toml'), 'id = "a"\n', 'utf8');
    await expect(loadMcps(path.join(root, '.airc'))).rejects.toThrow('local command OR remote type+url');

    await writeFile(path.join(root, '.airc/mcps/a.toml'), 'id = "a"\ncommand = "node"\nargs = ["${X}"]\ntype = "remote"\nurl = "https://x"\n', 'utf8');
    await expect(loadMcps(path.join(root, '.airc'))).rejects.toThrow('cannot define both local and remote transport');

    await writeFile(path.join(root, '.airc/mcps/a.toml'), 'id = "a"\ncommand = "node"\nargs = ["${X}", "${Y}"]\n', 'utf8');
    const parsed = await loadMcps(path.join(root, '.airc'));
    expect(parsed[0].envVars).toEqual(['X', 'Y']);
  });
});

describe('runtime config + adapters', () => {
  it('resolves relative agent instructions and skill assets in runtime config', async () => {
    const root = await makeTmp();
    await seed(root);
    const sourceRoot = path.join(root, '.airc');
    const config = await buildRuntimeConfig({
      root: sourceRoot,
      agents: await loadAgents(sourceRoot),
      skills: await loadSkills(sourceRoot),
      mcps: await loadMcps(sourceRoot)
    });

    expect(config.agents[0].instructions).toContain('Review this project.');
    expect(config.skills[0].assets[0].relativePath).toBe('checklist.md');
    expect(config.skills[0].assets[0].hash.length).toBeGreaterThan(0);
  });

  it('adapters consume same runtime config and output vendor-specific files', async () => {
    const root = await makeTmp();
    await seed(root);
    const sourceRoot = path.join(root, '.airc');
    const config = await buildRuntimeConfig({
      root: sourceRoot,
      agents: await loadAgents(sourceRoot),
      skills: await loadSkills(sourceRoot),
      mcps: await loadMcps(sourceRoot)
    });

    const claude = adapterFor('claude').plan(config, 'project');
    const codex = adapterFor('codex').plan(config, 'project');
    const opencode = adapterFor('opencode').plan(config, 'project');

    expect(claude.some((entry) => entry.relPath === '.claude/agents/reviewer.md')).toBe(true);
    expect(codex.some((entry) => entry.relPath === '.codex/agents/reviewer.md')).toBe(true);
    expect(opencode.some((entry) => entry.relPath === '.opencode/agents/reviewer.md')).toBe(true);
  });

  it('preserves skill frontmatter semantics across codex/opencode/claude adapters', async () => {
    const root = await makeTmp();
    await seed(root);
    const sourceRoot = path.join(root, '.airc');
    const config = await buildRuntimeConfig({
      root: sourceRoot,
      agents: await loadAgents(sourceRoot),
      skills: await loadSkills(sourceRoot),
      mcps: await loadMcps(sourceRoot)
    });

    const claudeSkill = adapterFor('claude')
      .plan(config, 'project')
      .find((entry) => entry.kind === 'skill' && entry.relPath === '.claude/skills/project-gates/SKILL.md');
    const codexSkill = adapterFor('codex')
      .plan(config, 'project')
      .find((entry) => entry.kind === 'skill' && entry.relPath === '.agents/skills/project-gates/SKILL.md');
    const opencodeSkill = adapterFor('opencode')
      .plan(config, 'project')
      .find((entry) => entry.kind === 'skill' && entry.relPath === '.opencode/skills/project-gates/SKILL.md');

    expect(claudeSkill?.content).toContain('description: "claude override"');
    expect(claudeSkill?.content).not.toContain('vendor:');

    expect(codexSkill?.content).toContain('name: "project-gates"');
    expect(codexSkill?.content).toContain('description: "project checks"');
    expect(codexSkill?.content).not.toContain('vendor:');

    expect(opencodeSkill?.content).toContain('name: "project-gates"');
    expect(opencodeSkill?.content).toContain('description: "project checks"');
    expect(opencodeSkill?.content).not.toContain('vendor:');
  });

  it('registers adapters in table-driven list', () => {
    expect(TARGET_ADAPTERS.map((adapter) => adapter.target).sort()).toEqual(['claude', 'codex', 'opencode']);
  });
});

describe('install + doctor', () => {
  it('init refuses overwrite and install copies only declared assets', async () => {
    const root = await makeTmp();
    await initScope('project', root, false);
    await expect(initScope('project', root, false)).rejects.toThrow('refusing to overwrite existing init examples');

    await seed(root);
    await writeFile(path.join(root, '.airc/skills/project-gates/extra.txt'), 'ignored', 'utf8');
    await install({ scope: 'project', cwd: root, targets: ['claude'], kinds: ['skill'] });

    await expect(stat(path.join(root, '.claude/skills/project-gates/checklist.md'))).resolves.toBeTruthy();
    await expect(stat(path.join(root, '.claude/skills/project-gates/extra.txt'))).rejects.toThrow();
  });

  it('rejects traversal from agent instructions and skill assets', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.airc/agents'), { recursive: true });
    await mkdir(path.join(root, '.airc/skills/s1'), { recursive: true });

    await writeFile(path.join(root, '.airc/agents/a.toml'), 'id = "a"\ninstructions = "../../etc/passwd"\n', 'utf8');
    await expect(install({ scope: 'project', cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('agent instructions traversal rejected');

    await writeFile(path.join(root, '.airc/agents/a.toml'), 'id = "a"\ninstructions = "inline"\n', 'utf8');
    await writeFile(path.join(root, '.airc/skills/s1/SKILL.md'), '+++\ndescription = "d"\nassets = ["../bad.txt"]\n+++\nbody\n', 'utf8');
    await expect(install({ scope: 'project', cwd: root, targets: ['codex'], kinds: ['skill'] })).rejects.toThrow('skill asset traversal rejected');
  });

  it('refuses unmanaged json clobber unless manifest-owned or force, dry-run writes nothing', async () => {
    const root = await makeTmp();
    await seed(root);

    await mkdir(path.join(root, '.opencode'), { recursive: true });
    await writeFile(path.join(root, '.opencode/opencode.json'), '{"external":true}\n', 'utf8');
    await expect(install({ scope: 'project', cwd: root, targets: ['opencode'], kinds: ['mcp'] })).rejects.toThrow('refusing overwrite unmanaged file');
    await expect(install({ scope: 'project', cwd: root, targets: ['opencode'], kinds: ['mcp'], dryRun: true })).rejects.toThrow('refusing overwrite unmanaged file');

    const beforeManifestMissing = stat(path.join(root, '.airc/.install-manifest.json'));
    await expect(beforeManifestMissing).rejects.toThrow();
    await install({ scope: 'project', cwd: root, targets: ['codex'], kinds: ['agent'], dryRun: true });
    await expect(stat(path.join(root, '.airc/.install-manifest.json'))).rejects.toThrow();

    await expect(install({ scope: 'project', cwd: root, targets: ['opencode'], kinds: ['mcp'], force: true })).resolves.toBeTruthy();
  });

  it('clean deletes only stale manifest-selected paths', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ scope: 'project', cwd: root, targets: ['codex'], kinds: ['agent'] });
    await rm(path.join(root, '.airc/agents/reviewer.toml'));
    await mkdir(path.join(root, '.codex/agents'), { recursive: true });
    await writeFile(path.join(root, '.codex/agents/keep.md'), 'keep', 'utf8');

    const result = await install({ scope: 'project', cwd: root, targets: ['codex'], kinds: ['agent'], clean: true });
    expect(result.del.some((file) => file.endsWith('reviewer.md') || file.endsWith('reviewer.toml'))).toBe(true);
    expect(await readFile(path.join(root, '.codex/agents/keep.md'), 'utf8')).toBe('keep');
  });

  it('aggregates multiple MCP definitions into one shared target config write', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.airc/mcps/z-remote.toml'), 'id = "z-remote"\ntype = "sse"\nurl = "https://example.test/z"\n', 'utf8');
    await writeFile(path.join(root, '.airc/mcps/a-remote.toml'), 'id = "a-remote"\ntype = "sse"\nurl = "https://example.test/a"\n', 'utf8');

    await install({ scope: 'project', cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['mcp'] });

    const claudeProject = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(claudeProject.mcpServers)).toEqual(['a-remote', 'project-rules', 'z-remote']);

    const codexToml = await readFile(path.join(root, '.codex/config.toml'), 'utf8');
    expect(codexToml.indexOf('[mcp_servers.a-remote]')).toBeLessThan(codexToml.indexOf('[mcp_servers.project-rules]'));
    expect(codexToml.indexOf('[mcp_servers.project-rules]')).toBeLessThan(codexToml.indexOf('[mcp_servers.z-remote]'));

    const opencode = JSON.parse(await readFile(path.join(root, '.opencode/opencode.json'), 'utf8')) as { mcp: Record<string, unknown> };
    expect(Object.keys(opencode.mcp)).toEqual(['a-remote', 'project-rules', 'z-remote']);
  });

  it('clean keeps shared MCP config path when still used by current MCP set', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.airc/mcps/remote.toml'), 'id = "remote"\ntype = "sse"\nurl = "https://example.test/mcp"\n', 'utf8');
    await install({ scope: 'project', cwd: root, targets: ['claude'], kinds: ['mcp'] });

    await rm(path.join(root, '.airc/mcps/remote.toml'));
    const result = await install({ scope: 'project', cwd: root, targets: ['claude'], kinds: ['mcp'], clean: true });
    expect(result.del).not.toContain(path.join(root, '.mcp.json'));

    const kept = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(kept.mcpServers)).toEqual(['project-rules']);
  });

  it('escapes codex TOML instructions when agent instructions come from relative file', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.airc/agents'), { recursive: true });
    await writeFile(path.join(root, '.airc/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "./reviewer.md"\n', 'utf8');
    await writeFile(path.join(root, '.airc/agents/reviewer.md'), 'line "one"\nline two\n', 'utf8');

    await install({ scope: 'project', cwd: root, targets: ['codex'], kinds: ['agent'] });
    const toml = await readFile(path.join(root, '.codex/agents/reviewer.toml'), 'utf8');
    expect(toml).toContain('instructions = "line \\"one\\"\\nline two\\n"');
  });

  it('persists skill assets in manifest and keeps reinstall idempotent', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ scope: 'project', cwd: root, targets: ['codex'], kinds: ['skill'] });
    const manifestOne = JSON.parse(await readFile(path.join(root, '.airc/.install-manifest.json'), 'utf8')) as { records: Array<{ path: string; hash: string; kind: string }> };
    const assetRecord = manifestOne.records.find((record) => record.path.endsWith(path.join('project-gates', 'checklist.md')));
    expect(assetRecord?.kind).toBe('skill');
    expect(assetRecord?.hash && assetRecord.hash.length > 0).toBe(true);

    await expect(install({ scope: 'project', cwd: root, targets: ['codex'], kinds: ['skill'] })).resolves.toBeTruthy();
    const manifestTwo = JSON.parse(await readFile(path.join(root, '.airc/.install-manifest.json'), 'utf8')) as { records: unknown[] };
    expect(manifestTwo.records).toEqual(manifestOne.records);
  });

  it('doctor emits expected warnings for env, codex instruction-only, opencode legacy tools', async () => {
    const root = await makeTmp();
    await seed(root);

    const warnings = await doctor('project', root, ['codex', 'opencode'], ['agent', 'mcp']);
    expect(warnings.join('\n')).toContain('missing env var: PROJECT_RULES_TOKEN');
    expect(warnings.join('\n')).toContain('codex instruction-only emit configured for agent reviewer');
    expect(warnings.join('\n')).toContain('opencode vendor tools is legacy for agent reviewer');
  });

  it('package scripts include lint and lint:fix', async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.lint).toBeDefined();
    expect(packageJson.scripts?.['lint:fix']).toBeDefined();
  });
});
