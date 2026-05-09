import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { adapterFor, TARGET_ADAPTERS } from '../src/adapters/target-adapters.js';
import { buildRuntimeConfig, type RuntimeConfig } from '../src/core/config-model.js';
import { install } from '../src/core/install.js';
import { loadAgents, loadMcps, loadRules, loadSkills } from '../src/core/parsers.js';

import { cleanupTmpDirs, makeTmp, seed } from './helpers.js';

afterEach(cleanupTmpDirs);

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

    const claude = adapterFor('claude').plan(config, 'project');
    const codex = adapterFor('codex').plan(config, 'project');
    const opencode = adapterFor('opencode').plan(config, 'project');

    expect(claude.some((entry) => entry.relPath === '.claude/agents/reviewer.md')).toBe(true);
    expect(codex.some((entry) => entry.relPath === '.codex/agents/reviewer.toml')).toBe(true);
    expect(opencode.some((entry) => entry.relPath === '.opencode/agents/reviewer.md')).toBe(true);
  });

  it('renders vendor templates per target with if/elsif/else branching and fails on unknown variables', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await mkdir(path.join(root, '.rac/skills/s1'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');
    await writeFile(path.join(root, '.rac/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "./reviewer.tpl.md"\n', 'utf8');
    await writeFile(path.join(root, '.rac/agents/reviewer.tpl.md'), 'For {% if vendor.codex %}Codex{% elsif vendor.claude %}Claude{% else %}Other{% endif %}\n', 'utf8');
    await writeFile(path.join(root, '.rac/skills/s1/SKILL.tpl.md'), '+++\ndescription = "skill"\n+++\nHello {% if vendor.opencode %}OpenCode{% endif %}\n', 'utf8');

    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['agent', 'skill'] });
    const codexToml = await readFile(path.join(root, '.codex/agents/reviewer.toml'), 'utf8');
    expect(codexToml).toContain('For Codex');
    const claudeAgent = await readFile(path.join(root, '.claude/agents/reviewer.md'), 'utf8');
    expect(claudeAgent).toContain('For Claude');
    const opencodeAgent = await readFile(path.join(root, '.opencode/agents/reviewer.md'), 'utf8');
    expect(opencodeAgent).toContain('For Other');
    const opencodeSkill = await readFile(path.join(root, '.opencode/skills/s1/SKILL.md'), 'utf8');
    expect(opencodeSkill).toContain('Hello OpenCode');

    await writeFile(path.join(root, '.rac/agents/reviewer.tpl.md'), 'Bad {{ vendor.missing }}\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('template render failed');

    await writeFile(path.join(root, '.rac/agents/reviewer.tpl.md'), 'Bad {% if vendor.cursor %}Cursor{% endif %}\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('template render failed');
  });

  it('rejects include/render tags in templates, including whitespace-control forms', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');
    await writeFile(path.join(root, '.rac/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "./reviewer.tpl.md"\n', 'utf8');

    await writeFile(path.join(root, '.rac/agents/reviewer.tpl.md'), '{% include "partial.md" %}\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('includes/partials are not supported');

    await writeFile(path.join(root, '.rac/agents/reviewer.tpl.md'), '{%- include "partial.md" -%}\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('includes/partials are not supported');

    await writeFile(path.join(root, '.rac/agents/reviewer.tpl.md'), '{% render "partial.md" %}\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('includes/partials are not supported');

    await writeFile(path.join(root, '.rac/agents/reviewer.tpl.md'), '{%- render "partial.md" -%}\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('includes/partials are not supported');
  });

  it('reports malformed liquid with source-aware context for agents and skills', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await mkdir(path.join(root, '.rac/skills/s1'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');

    await writeFile(path.join(root, '.rac/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "./reviewer.tpl.md"\n', 'utf8');
    await writeFile(path.join(root, '.rac/agents/reviewer.tpl.md'), '{% if vendor.codex %}Codex\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('agent reviewer: template render failed');

    await writeFile(path.join(root, '.rac/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "plain"\n', 'utf8');
    await writeFile(path.join(root, '.rac/skills/s1/SKILL.tpl.md'), '+++\ndescription = "skill"\n+++\n{% if vendor.codex %}Codex\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['skill'] })).rejects.toThrow('skill s1: template render failed');
  });

  it('keeps liquid syntax literal in non-template agent instructions and skill bodies', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await mkdir(path.join(root, '.rac/skills/s1'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');

    await writeFile(path.join(root, '.rac/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "./reviewer.md"\n', 'utf8');
    await writeFile(path.join(root, '.rac/agents/reviewer.md'), 'Literal {% if vendor.codex %}Codex{% endif %} and {{ vendor.cursor }}\n', 'utf8');
    await writeFile(path.join(root, '.rac/skills/s1/SKILL.md'), '+++\ndescription = "skill"\n+++\nLiteral {% if vendor.codex %}Codex{% endif %} and {{ vendor.cursor }}\n', 'utf8');

    await install({ cwd: root, targets: ['codex'], kinds: ['agent', 'skill'] });

    const agentOutput = await readFile(path.join(root, '.codex/agents/reviewer.toml'), 'utf8');
    expect(agentOutput).toContain('Literal {% if vendor.codex %}Codex{% endif %} and {{ vendor.cursor }}');
    const skillOutput = await readFile(path.join(root, '.agents/skills/s1/SKILL.md'), 'utf8');
    expect(skillOutput).toContain('Literal {% if vendor.codex %}Codex{% endif %} and {{ vendor.cursor }}');
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
      .plan(config, 'project')
      .find((entry) => entry.kind === 'skill' && entry.relPath === '.claude/skills/project-gates/SKILL.md');
    const codexSkill = adapterFor('codex')
      .plan(config, 'project')
      .find((entry) => entry.kind === 'skill' && entry.relPath === '.agents/skills/project-gates/SKILL.md');
    const opencodeSkill = adapterFor('opencode')
      .plan(config, 'project')
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

  it('env and envForward render correctly per target adapter', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/mcps'), { recursive: true });

    const config: RuntimeConfig = {
      pack: 'project',
      agents: [],
      skills: [],
      mcps: [{
        pack: 'project',
        id: 'test-mcp',
        source: { pack: 'project', absPath: '/fake/mcps/test-mcp.toml', relPath: 'mcps/test-mcp.toml' },
        envRefs: ['T'],
        env: { L: 'v' },
        envForward: ['T'],
        transport: { kind: 'local', command: 'node', args: ['./mcp.js'] }
      }],
      rules: [],
      configs: [],
      warnings: []
    };

    // Claude: merged env map with ${K} for forwards
    const claudeOutputs = adapterFor('claude').plan(config, 'project');
    const claudeMcpOutput = claudeOutputs.find((o) => o.kind === 'mcp');
    expect(claudeMcpOutput).toBeDefined();
    const claudeParsed = JSON.parse(claudeMcpOutput!.content!) as { mcpServers: Record<string, { env?: Record<string, string> }> };
    expect(claudeParsed.mcpServers['test-mcp'].env).toEqual({ L: 'v', T: '${T}' });

    // Codex: separate env (literals) and env_vars (forwards)
    const { parse: parseToml } = await import('smol-toml');
    const codexOutputs = adapterFor('codex').plan(config, 'project');
    const codexMcpOutput = codexOutputs.find((o) => o.kind === 'mcp');
    expect(codexMcpOutput).toBeDefined();
    const codexParsed = parseToml(codexMcpOutput!.content!) as { mcp_servers: Record<string, { env?: Record<string, string>; env_vars?: string[] }> };
    expect(codexParsed.mcp_servers['test-mcp'].env).toEqual({ L: 'v' });
    expect(codexParsed.mcp_servers['test-mcp'].env_vars).toEqual(['T']);

    // OpenCode: merged environment map with {env:K} for forwards
    const opencodeOutputs = adapterFor('opencode').plan(config, 'project');
    const opencodeMcpOutput = opencodeOutputs.find((o) => o.kind === 'mcp');
    expect(opencodeMcpOutput).toBeDefined();
    const opencodeRaw = opencodeMcpOutput!.content!.replace(/^\/\/.*\n/, '');
    const opencodeParsed = JSON.parse(opencodeRaw) as { mcp: Record<string, { environment?: Record<string, string> }> };
    expect(opencodeParsed.mcp['test-mcp'].environment).toEqual({ L: 'v', T: '{env:T}' });
  });

  it('env and envForward vendor-key collision detection per target', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/mcps'), { recursive: true });

    const baseConfig = (vendorConfig?: RuntimeConfig['mcps'][0]['vendorConfig']): RuntimeConfig => ({
      pack: 'project',
      agents: [],
      skills: [],
      mcps: [{
        pack: 'project',
        id: 'test-mcp',
        source: { pack: 'project', absPath: '/fake/mcps/test-mcp.toml', relPath: 'mcps/test-mcp.toml' },
        envRefs: ['K'],
        env: { K: 'v' },
        envForward: ['K2'],
        transport: { kind: 'local', command: 'node', args: ['./mcp.js'] },
        vendorConfig
      }],
      rules: [],
      configs: [],
      warnings: []
    });

    // Claude: top-level env conflicts with vendor.claude.config.env
    expect(() => adapterFor('claude').plan(baseConfig({ claude: { env: { K: 'other' } } }), 'project'))
      .toThrow();

    // Codex: top-level env conflicts with vendor.codex.config.env
    expect(() => adapterFor('codex').plan(baseConfig({ codex: { env: { K: 'other' } } }), 'project'))
      .toThrow();

    // Codex: top-level envForward conflicts with vendor.codex.config.env_vars
    const codexForwardConflictConfig: RuntimeConfig = {
      pack: 'project',
      agents: [],
      skills: [],
      mcps: [{
        pack: 'project',
        id: 'test-mcp',
        source: { pack: 'project', absPath: '/fake/mcps/test-mcp.toml', relPath: 'mcps/test-mcp.toml' },
        envRefs: ['K'],
        envForward: ['K'],
        transport: { kind: 'local', command: 'node', args: ['./mcp.js'] },
        vendorConfig: { codex: { env_vars: ['K'] } }
      }],
      rules: [],
      configs: [],
      warnings: []
    };
    expect(() => adapterFor('codex').plan(codexForwardConflictConfig, 'project')).toThrow();

    // OpenCode: top-level env conflicts with vendor.opencode.config.environment
    expect(() => adapterFor('opencode').plan(baseConfig({ opencode: { environment: { K: 'other' } } }), 'project'))
      .toThrow();
  });
});
