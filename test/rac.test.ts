import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { describe, expect, it, afterEach } from 'vitest';

import { adapterFor, TARGET_ADAPTERS } from '../src/adapters/target-adapters.js';
import { buildRuntimeConfig } from '../src/core/config-model.js';
import { doctor, initProject, install } from '../src/core/install.js';
import { loadAgents, loadMcps, loadSkills } from '../src/core/parsers.js';

const tempDirs: string[] = [];

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rac-'));
  tempDirs.push(dir);
  return dir;
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

  await writeFile(path.join(root, '.rac/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "./reviewer.md"\n[vendor.codex]\nemit = "instruction-only"\n[vendor.opencode]\ntools = ["legacy"]\n', 'utf8');
  await writeFile(path.join(root, '.rac/agents/reviewer.md'), 'Review this project.\n', 'utf8');

  await writeFile(path.join(root, '.rac/skills/project-gates/SKILL.md'), '+++\ndescription = "project checks"\nassets = ["checklist.md"]\n[vendor.claude.frontmatter]\naudience = "claude"\n[vendor.codex.frontmatter]\naudience = "codex"\n[vendor.opencode.frontmatter]\naudience = "opencode"\n+++\nRun checks\n', 'utf8');
  await writeFile(path.join(root, '.rac/skills/project-gates/checklist.md'), '- test\n', 'utf8');

  await writeFile(path.join(root, '.rac/mcps/project-rules.toml'), 'id = "project-rules"\ncommand = "node"\nargs = ["./mcp.js", "${PROJECT_RULES_TOKEN}"]\nstartup_timeout_ms = 1200\n', 'utf8');
}

describe('parsers', () => {
  it('agent parser validates TOML and duplicate ids', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await writeFile(path.join(root, '.rac/agents/a.toml'), 'id = "x"\ninstructions = "hello"\n', 'utf8');
    await writeFile(path.join(root, '.rac/agents/b.toml'), 'id = "x"\ninstructions = "hello"\n', 'utf8');
    await expect(loadAgents(path.join(root, '.rac'))).rejects.toThrow('duplicate agent id');

    await writeFile(path.join(root, '.rac/agents/b.toml'), 'id = "y"\ninstructions = [broken\n', 'utf8');
    await expect(loadAgents(path.join(root, '.rac'))).rejects.toThrow('invalid TOML');
  });

  it('skill parser requires +++ at byte 0 and closing delimiter', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/skills/s1'), { recursive: true });
    await writeFile(path.join(root, '.rac/skills/s1/SKILL.md'), 'bad\n+++\ndescription = "x"\n+++\nbody\n', 'utf8');
    await expect(loadSkills(path.join(root, '.rac'))).rejects.toThrow('byte 0');

    await writeFile(path.join(root, '.rac/skills/s1/SKILL.md'), '+++\ndescription = "x"\nbody\n', 'utf8');
    await expect(loadSkills(path.join(root, '.rac'))).rejects.toThrow('missing closing +++ delimiter');
  });

  it('mcp parser enforces local xor remote and collects env vars', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/mcps'), { recursive: true });
    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "a"\n', 'utf8');
    await expect(loadMcps(path.join(root, '.rac'))).rejects.toThrow('local command OR remote type+url');

    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "a"\ncommand = "node"\nargs = ["${X}"]\ntype = "remote"\nurl = "https://x"\n', 'utf8');
    await expect(loadMcps(path.join(root, '.rac'))).rejects.toThrow('cannot define both local and remote transport');

    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "a"\ncommand = "node"\nargs = ["${X}", "${Y}"]\n', 'utf8');
    const parsed = await loadMcps(path.join(root, '.rac'));
    expect(parsed[0].envVars).toEqual(['X', 'Y']);
  });
});

describe('runtime config + adapters', () => {
  it('resolves relative agent instructions and skill assets in runtime config', async () => {
    const root = await makeTmp();
    await seed(root);
    const sourceRoot = path.join(root, '.rac');
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
    const sourceRoot = path.join(root, '.rac');
    const config = await buildRuntimeConfig({
      root: sourceRoot,
      agents: await loadAgents(sourceRoot),
      skills: await loadSkills(sourceRoot),
      mcps: await loadMcps(sourceRoot)
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
      agents: await loadAgents(sourceRoot),
      skills: await loadSkills(sourceRoot),
      mcps: await loadMcps(sourceRoot)
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
    await writeFile(path.join(root, '.opencode/opencode.json'), '{"external":true}\n', 'utf8');
    await expect(install({ cwd: root, targets: ['opencode'], kinds: ['mcp'] })).rejects.toThrow('refusing overwrite unmanaged file');
    await expect(install({ cwd: root, targets: ['opencode'], kinds: ['mcp'], dryRun: true })).rejects.toThrow('refusing overwrite unmanaged file');

    const beforeManifestMissing = stat(path.join(root, '.codex/.rac-install-manifest.json'));
    await expect(beforeManifestMissing).rejects.toThrow();
    await install({ cwd: root, targets: ['codex'], kinds: ['agent'], dryRun: true });
    await expect(stat(path.join(root, '.codex/.rac-install-manifest.json'))).rejects.toThrow();

    await expect(install({ cwd: root, targets: ['opencode'], kinds: ['mcp'], force: true })).resolves.toBeTruthy();
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
    expect(codexToml.indexOf('[mcp_servers.a-remote]')).toBeLessThan(codexToml.indexOf('[mcp_servers.project-rules]'));
    expect(codexToml.indexOf('[mcp_servers.project-rules]')).toBeLessThan(codexToml.indexOf('[mcp_servers.z-remote]'));
    expect(codexToml).toContain('startup_timeout_sec = 2');
    expect(codexToml).not.toContain('startup_timeout = ');

    const opencode = JSON.parse(await readFile(path.join(root, '.opencode/opencode.json'), 'utf8')) as { mcp: Record<string, { type: string; enabled: boolean; command?: string[]; url?: string }> };
    expect(Object.keys(opencode.mcp)).toEqual(['a-remote', 'project-rules', 'z-remote']);
  });

  it('vendor compatibility schema: OpenCode MCP emits local/remote typed entries and rejects legacy command object shape', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.rac/mcps/a-remote.toml'), 'id = "a-remote"\ntype = "sse"\nurl = "https://example.test/a"\n', 'utf8');

    await install({ cwd: root, targets: ['opencode'], kinds: ['mcp'] });

    const opencode = JSON.parse(await readFile(path.join(root, '.opencode/opencode.json'), 'utf8')) as {
      mcp: Record<string, { type: string; enabled: boolean; command?: unknown; url?: unknown }>;
    };

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

    for (const record of claudeManifest.records) expect(record.inventory[0]?.selector).toBe(`$.mcpServers.${record.id}`);
    for (const record of codexManifest.records) expect(record.inventory[0]?.selector).toBe(`mcp_servers.${record.id}`);
    for (const record of opencodeManifest.records) expect(record.inventory[0]?.selector).toBe(`$.mcp.${record.id}`);
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
    await writeFile(path.join(root, '.rac/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "./reviewer.md"\n', 'utf8');
    await writeFile(path.join(root, '.rac/agents/reviewer.md'), 'line "one"\nline two\n', 'utf8');

    await install({ cwd: root, targets: ['codex'], kinds: ['agent'] });
    const toml = await readFile(path.join(root, '.codex/agents/reviewer.toml'), 'utf8');
    const parsed = parseToml(toml.replace(/^<!-- managed-by-rac -->\n/, '')) as Record<string, unknown>;

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
    const assetRecord = manifestOne.records.find((record) => record.relPath.endsWith(path.join('project-gates', 'checklist.md')));
    expect(assetRecord?.kind).toBe('skill');
    expect(assetRecord?.hash && assetRecord.hash.length > 0).toBe(true);
    expect(assetRecord?.inventory[0]?.selector).toBe('$');

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

    const opencode = JSON.parse(await readFile(path.join(root, '.opencode/opencode.json'), 'utf8')) as { mcp: Record<string, Record<string, unknown>> };
    expect(opencode.mcp.server.readOnly).toBe(true);
  });

  it('vendor pass-through: skill vendor.<target>.config overlays markdown frontmatter for claude/codex/opencode', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/skills/s1'), { recursive: true });
    await writeFile(
      path.join(root, '.rac/skills/s1/SKILL.md'),
      '+++\ndescription = "skill"\n[vendor.claude.config]\naudience = "claude-config"\n[vendor.codex.config]\nmodel = "gpt-5"\n[vendor.opencode.config]\nenabled = true\n+++\nbody\n',
      'utf8'
    );

    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['skill'] });

    const claudeSkill = await readFile(path.join(root, '.claude/skills/s1/SKILL.md'), 'utf8');
    expect(claudeSkill).toContain('name: "s1"');
    expect(claudeSkill).toContain('description: "skill"');
    expect(claudeSkill).toContain('audience: "claude-config"');

    const codexSkill = await readFile(path.join(root, '.agents/skills/s1/SKILL.md'), 'utf8');
    expect(codexSkill).toContain('name: "s1"');
    expect(codexSkill).toContain('description: "skill"');
    expect(codexSkill).toContain('model: "gpt-5"');

    const opencodeSkill = await readFile(path.join(root, '.opencode/skills/s1/SKILL.md'), 'utf8');
    expect(opencodeSkill).toContain('name: "s1"');
    expect(opencodeSkill).toContain('description: "skill"');
    expect(opencodeSkill).toContain('enabled: true');
  });

  it('fails fast on vendor collision with generated keys and on instruction-only + codex config incompatibility', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
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
});
