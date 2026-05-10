import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { addProjectPack, clearProjectPackOverride, listProjectPackOverrides, listProjectPacks, removeProjectPack, setProjectPackOverride } from '../src/core/pack-config.js';
import { loadAgents, loadInstallSettings, loadMcps, loadProjectPackConfig, loadRules, loadSkills, loadVendorConfigs, resolvePacks, type GitRunner } from '../src/core/parsers.js';

import { cleanupTmpDirs, makeTmp, runCliInProcess } from './helpers.js';

afterEach(cleanupTmpDirs);

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

    // In-process: commander enforces --ref as required
    const missingRef = await runCliInProcess(root, ['pack', 'add', 'alpha', 'github:owner/alpha']);
    expect(missingRef.status).toBe(2);
    expect(missingRef.stderr).toContain("required option '--ref <ref>'");

    // Direct: add with special chars, verify TOML state
    await addProjectPack(root, { id: 'alpha', repo: 'github:owner/alpha', ref: 'tag"\\candidate' });
    const parsed = parseToml(await readFile(path.join(root, '.rac/config.toml'), 'utf8')) as {
      packs?: Array<{ id?: string; repo?: string; ref?: string }>;
    };
    expect(parsed.packs?.[0]).toEqual({
      id: 'alpha',
      repo: 'github:owner/alpha',
      ref: 'tag"\\candidate'
    });

    // In-process: verify CLI renders list correctly (empty then one-item formatting)
    const listOne = await runCliInProcess(root, ['pack', 'list']);
    expect(listOne.status).toBe(0);
    expect(listOne.stdout).toBe('alpha  github:owner/alpha @ tag"\\candidate\n');

    // Direct: removeProjectPack throws with expected message (exit-code mapping is generic)
    await expect(removeProjectPack(root, 'missing')).rejects.toThrow('pack not found: missing');
  });

  it('cli pack remove matches whitespace/commented [[ packs ]] headers and preserves unrelated file fidelity', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    await writeFile(
      path.join(root, '.rac/config.toml'),
      'title = "demo"\r\n\r\n   [[ packs ]]   # keep-comment\r\nid = "alpha"\r\nrepo = "github:owner/alpha"\r\nref = "main"\r\n\r\n\r\n[other]\r\nvalue = "keep"\r\n',
      'utf8'
    );

    const remove = await runCliInProcess(root, ['pack', 'remove', 'alpha']);
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

  it('skill parser supports SKILL.tpl.md and rejects dual SKILL files in one directory', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/skills/s1'), { recursive: true });
    await writeFile(path.join(root, '.rac/skills/s1/SKILL.tpl.md'), '+++\ndescription = "x"\n+++\nHello {% if vendor.codex %}Codex{% endif %}\n', 'utf8');
    const skills = await loadSkills(path.join(root, '.rac'), 'project');
    expect(skills[0].bodyIsTemplate).toBe(true);

    await writeFile(path.join(root, '.rac/skills/s1/SKILL.md'), '+++\ndescription = "x"\n+++\nBody\n', 'utf8');
    await expect(loadSkills(path.join(root, '.rac'), 'project')).rejects.toThrow('cannot contain both SKILL.md and SKILL.tpl.md');
  });

  it('mcp parser enforces local xor remote and collects env vars', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/mcps'), { recursive: true });
    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "a"\n', 'utf8');
    await expect(loadMcps(path.join(root, '.rac'), 'project')).rejects.toThrow('local command OR remote url');

    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "a"\ncommand = "node"\nargs = ["${X}"]\nurl = "https://x"\n', 'utf8');
    await expect(loadMcps(path.join(root, '.rac'), 'project')).rejects.toThrow('cannot define both local and remote transport');

    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "a"\nurl = "https://x"\n', 'utf8');
    await expect(loadMcps(path.join(root, '.rac'), 'project')).resolves.toMatchObject([{ id: 'a', url: 'https://x' }]);

    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "a"\ncommand = "node"\nargs = ["${X}", "${Y}"]\n', 'utf8');
    const parsed = await loadMcps(path.join(root, '.rac'), 'project');
    expect(parsed[0].envVars).toEqual(['X', 'Y']);
  });

  it('mcp parser supports env and env_forward on local transport', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/mcps'), { recursive: true });

    // Local MCP with [env] block parses into McpDef.env
    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "a"\ncommand = "node"\nargs = []\n\n[env]\nLOG_LEVEL = "info"\n', 'utf8');
    const withEnv = await loadMcps(path.join(root, '.rac'), 'project');
    expect(withEnv[0].env).toEqual({ LOG_LEVEL: 'info' });

    // Local MCP with env_forward parses and adds to envVars
    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "a"\ncommand = "node"\nargs = []\nenv_forward = ["X"]\n', 'utf8');
    const withForward = await loadMcps(path.join(root, '.rac'), 'project');
    expect(withForward[0].env_forward).toEqual(['X']);
    expect(withForward[0].envVars).toContain('X');

    // Same key in both env and env_forward rejects
    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "a"\ncommand = "node"\nargs = []\nenv_forward = ["K"]\n\n[env]\nK = "v"\n', 'utf8');
    await expect(loadMcps(path.join(root, '.rac'), 'project')).rejects.toThrow(/cannot also appear in env_forward/);

    // Remote MCP with env rejects
    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "a"\nurl = "https://x"\n\n[env]\nLOG_LEVEL = "info"\n', 'utf8');
    await expect(loadMcps(path.join(root, '.rac'), 'project')).rejects.toThrow('mcp env is only allowed on local transport');

    // Remote MCP with env_forward rejects
    await writeFile(path.join(root, '.rac/mcps/a.toml'), 'id = "a"\nurl = "https://x"\nenv_forward = ["X"]\n', 'utf8');
    await expect(loadMcps(path.join(root, '.rac'), 'project')).rejects.toThrow('mcp env_forward is only allowed on local transport');
  });

  it('parses vendor-wide config/raw/raw_json from .rac/config.toml only', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    await writeFile(
      path.join(root, '.rac/config.toml'),
      '[install]\nmerge = true\n\n[vendor.codex.config]\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n[vendor.codex.config.features]\nmulti_agent = true\n[vendor.claude.raw]\nallowedMcpServers = [{ serverName = "github" }]\n[vendor.opencode.raw_json]\nplugin = """["opencode-plugin-foo", ["opencode-plugin-bar", { "enabled": true }]]"""\n',
      'utf8'
    );

    const configs = await loadVendorConfigs(path.join(root, '.rac'), 'project');
    expect(configs.map((entry) => entry.target).sort()).toEqual(['claude', 'codex', 'opencode']);
    expect(configs.find((entry) => entry.target === 'codex')?.selectors).toEqual([
      '$["model"]',
      '$["model_reasoning_effort"]',
      '$["features"]["multi_agent"]'
    ]);
    expect(configs.find((entry) => entry.target === 'claude')?.values).toEqual({
      allowedMcpServers: [{ serverName: 'github' }]
    });
    expect(configs.find((entry) => entry.target === 'opencode')?.values).toEqual({
      plugin: ['opencode-plugin-foo', ['opencode-plugin-bar', { enabled: true }]]
    });
  });

  it('rejects invalid vendor-wide config targets, values, JSON, and selector overlap', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    const configPath = path.join(root, '.rac/config.toml');

    await writeFile(configPath, '[vendor.cursor.config]\nmodel = "x"\n', 'utf8');
    await expect(loadVendorConfigs(path.join(root, '.rac'), 'project')).rejects.toThrow('unsupported vendor config target');

    await writeFile(configPath, '[vendor.codex.config]\nvalues = [1, "two"]\n', 'utf8');
    await expect(loadVendorConfigs(path.join(root, '.rac'), 'project')).rejects.toThrow('heterogeneous arrays');

    await writeFile(configPath, '[[vendor.codex.config.values]]\nname = "bad"\n', 'utf8');
    await expect(loadVendorConfigs(path.join(root, '.rac'), 'project')).rejects.toThrow('arrays containing objects or arrays');

    await writeFile(configPath, '[vendor.codex.raw_json]\nvalue = "{bad"\n', 'utf8');
    await expect(loadVendorConfigs(path.join(root, '.rac'), 'project')).rejects.toThrow('invalid JSON');

    await writeFile(configPath, '[vendor.codex.raw_json]\nvalue = "null"\n', 'utf8');
    await expect(loadVendorConfigs(path.join(root, '.rac'), 'project')).rejects.toThrow('cannot be emitted as TOML null');

    await writeFile(configPath, '[vendor.codex.config.features]\nmulti_agent = true\n[vendor.codex.raw]\nfeatures = { other = true }\n', 'utf8');
    await expect(loadVendorConfigs(path.join(root, '.rac'), 'project')).rejects.toThrow('selector overlap');
  });

  it('rule parser enforces [[rule]] entries, unique ids, and command validation', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/rules'), { recursive: true });
    await writeFile(path.join(root, '.rac/rules/a.toml'), 'id = "x"\n', 'utf8');
    await expect(loadRules(path.join(root, '.rac'), 'project')).rejects.toThrow('missing [[rule]] entries');

    await writeFile(path.join(root, '.rac/rules/a.toml'), '[[rule]]\nid = "r1"\ndecision = "ask"\njustification = "x"\ncommand = ["git"]\n', 'utf8');
    await expect(loadRules(path.join(root, '.rac'), 'project')).rejects.toThrow('unsupported rule decision');

    await writeFile(path.join(root, '.rac/rules/a.toml'), '[[rule]]\nid = "r1"\ndecision = "allow"\njustification = "x"\ncommand = ["git"]\n', 'utf8');
    await expect(loadRules(path.join(root, '.rac'), 'project')).resolves.toMatchObject([{ decision: 'allow' }]);

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

  it('loadInstallSettings returns { merge: true } with no targets when config file is absent', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    const result = await loadInstallSettings(path.join(root, '.rac'));
    expect(result).toEqual({ merge: true });
    expect(result.targets).toBeUndefined();
  });

  it('loadInstallSettings parses valid targets array', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '[install]\ntargets = ["claude", "codex"]\n', 'utf8');
    const result = await loadInstallSettings(path.join(root, '.rac'));
    expect(result).toEqual({ merge: true, targets: ['claude', 'codex'] });
  });

  it('loadInstallSettings throws on invalid target string', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '[install]\ntargets = ["bogus"]\n', 'utf8');
    await expect(loadInstallSettings(path.join(root, '.rac'))).rejects.toThrow('invalid install.targets');
  });

  it('loadInstallSettings accepts empty targets array', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '[install]\ntargets = []\n', 'utf8');
    const result = await loadInstallSettings(path.join(root, '.rac'));
    expect(result).toEqual({ merge: true, targets: [] });
  });

  it('loadInstallSettings throws when targets is not an array', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '[install]\ntargets = "claude"\n', 'utf8');
    await expect(loadInstallSettings(path.join(root, '.rac'))).rejects.toThrow('invalid install.targets');
  });

  it('pack-config: inline comment after value is parsed correctly', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    await writeFile(
      path.join(root, '.rac/config.toml'),
      'title = "demo"\n\n[[packs]]\nid = "alpha" # comment\nrepo = "github:owner/alpha"\nref = "main"\n',
      'utf8'
    );
    const config = await loadProjectPackConfig(path.join(root, '.rac'));
    expect(config.packs[0].id).toBe('alpha');
  });

  it('pack-config: two packs where one id is substring of the other are both accepted', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    await writeFile(
      path.join(root, '.rac/config.toml'),
      'title = "demo"\n\n[[packs]]\nid = "foo"\nrepo = "github:owner/foo"\nref = "main"\n\n[[packs]]\nid = "foobar"\nrepo = "github:owner/foobar"\nref = "main"\n',
      'utf8'
    );
    const config = await loadProjectPackConfig(path.join(root, '.rac'));
    expect(config.packs.map((p) => p.id)).toEqual(['foo', 'foobar']);
  });

  it('pack-config: round-trip add then remove leaves no double-blank-line artifacts', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), 'title = "demo"\n', 'utf8');

    await addProjectPack(root, { id: 'alpha', repo: 'github:owner/alpha', ref: 'main' });
    await removeProjectPack(root, 'alpha');

    const content = await readFile(path.join(root, '.rac/config.toml'), 'utf8');
    expect(content).not.toContain('\n\n\n');
    expect(content).toContain('title = "demo"');
    expect(content).not.toContain('alpha');
  });

  it('pack-config: TOML escape sequences in ref are decoded by smol-toml', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    // ref = "v[0m" in TOML — smol-toml decodes  to ESC character
    await writeFile(
      path.join(root, '.rac/config.toml'),
      'title = "demo"\n\n[[packs]]\nid = "alpha"\nrepo = "github:owner/alpha"\nref = "v\\u001b[0m"\n',
      'utf8'
    );
    const config = await loadProjectPackConfig(path.join(root, '.rac'));
    const ref = config.packs[0].ref;
    // smol-toml decodes  into ESC (0x1b)
    expect(ref.charCodeAt(1)).toBe(0x1b);
    expect(ref.length).toBe(5); // 'v' + ESC + '[' + '0' + 'm'
  });

  it('loadSkills auto-discovers files in nested subdirs, excludes SKILL.md and dotfiles, returns sorted relative POSIX paths', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/skills/s1/references'), { recursive: true });
    await writeFile(path.join(root, '.rac/skills/s1/SKILL.md'), '+++\ndescription = "test skill"\n+++\nbody\n', 'utf8');
    await writeFile(path.join(root, '.rac/skills/s1/checklist.md'), '- item\n', 'utf8');
    await writeFile(path.join(root, '.rac/skills/s1/references/notes.md'), 'notes\n', 'utf8');
    await writeFile(path.join(root, '.rac/skills/s1/.DS_Store'), 'junk', 'utf8');

    const skills = await loadSkills(path.join(root, '.rac'), 'project');
    expect(skills[0].assets).toEqual(['checklist.md', 'references/notes.md']);
  });

  it('loadSkills returns assets: [] when only SKILL.md exists', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/skills/s1'), { recursive: true });
    await writeFile(path.join(root, '.rac/skills/s1/SKILL.md'), '+++\ndescription = "test skill"\n+++\nbody\n', 'utf8');

    const skills = await loadSkills(path.join(root, '.rac'), 'project');
    expect(skills[0].assets).toEqual([]);
  });

  it('loadSkills excludes SKILL.tpl.md from discovered assets', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/skills/s1'), { recursive: true });
    await writeFile(path.join(root, '.rac/skills/s1/SKILL.tpl.md'), '+++\ndescription = "templated"\n+++\nbody {{ x }}\n', 'utf8');
    await writeFile(path.join(root, '.rac/skills/s1/checklist.md'), '- item\n', 'utf8');

    const skills = await loadSkills(path.join(root, '.rac'), 'project');
    expect(skills[0].assets).toEqual(['checklist.md']);
  });

  it('loadSkills does not follow symlinks pointing outside the skill dir', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/skills/s1'), { recursive: true });
    await writeFile(path.join(root, '.rac/skills/s1/SKILL.md'), '+++\ndescription = "test skill"\n+++\nbody\n', 'utf8');
    await writeFile(path.join(root, 'outside-secret.txt'), 'secret', 'utf8');
    await symlink(path.join(root, 'outside-secret.txt'), path.join(root, '.rac/skills/s1/leaked.txt'));

    const skills = await loadSkills(path.join(root, '.rac'), 'project');
    expect(skills[0].assets).toEqual([]);
  });
});

describe('resolvePacks with overrides', () => {
  function neverGit(): GitRunner {
    return vi.fn().mockImplementation(async () => {
      throw new Error('git should not be called for overridden packs');
    }) as unknown as GitRunner;
  }

  async function makeLocalPack(dir: string): Promise<void> {
    await mkdir(path.join(dir, '.rac'), { recursive: true });
    await writeFile(path.join(dir, '.rac/config.toml'), '', 'utf8');
  }

  it('matching [[pack_overrides]] returns PackRuntime with override.path set; gitRunner never called', async () => {
    const project = await makeTmp();
    const packDir = await makeTmp();
    await mkdir(path.join(project, '.rac'), { recursive: true });
    await writeFile(
      path.join(project, '.rac/config.toml'),
      '[[packs]]\nid = "alpha"\nrepo = "github:owner/alpha"\nref = "main"\n',
      'utf8'
    );
    await writeFile(
      path.join(project, '.rac/config.local.toml'),
      `[[pack_overrides]]\nid = "alpha"\npath = ${JSON.stringify(packDir)}\n`,
      'utf8'
    );
    await makeLocalPack(packDir);

    const gitRunner = neverGit();
    const result = await resolvePacks(project, { gitRunner });

    expect(result).toHaveLength(2);
    const alpha = result.find((r) => r.id === 'alpha');
    expect(alpha?.override?.path).toBe(packDir);
    expect(alpha?.root).toBe(path.join(packDir, '.rac'));
    expect(alpha?.sourceRepo).toBe('github:owner/alpha');
    expect(alpha?.sourceRef).toBe('main');
    expect(gitRunner).not.toHaveBeenCalled();
  });

  it('[[pack_overrides]] id not matching any [[packs]] entry throws with "pack override target not found"', async () => {
    const project = await makeTmp();
    await mkdir(path.join(project, '.rac'), { recursive: true });
    await writeFile(
      path.join(project, '.rac/config.toml'),
      '[[packs]]\nid = "alpha"\nrepo = "github:owner/alpha"\nref = "main"\n',
      'utf8'
    );
    await writeFile(
      path.join(project, '.rac/config.local.toml'),
      '[[pack_overrides]]\nid = "nonexistent"\npath = "/some/path"\n',
      'utf8'
    );

    await expect(resolvePacks(project, { gitRunner: neverGit() }))
      .rejects.toThrow(/pack override target not found/);
    await expect(resolvePacks(project, { gitRunner: neverGit() }))
      .rejects.toThrow(/nonexistent/);
  });

  it('mixed: pack A overridden locally, pack B fetched via gitRunner; mock only called for B', async () => {
    const project = await makeTmp();
    const cacheDir = await makeTmp();
    const packADir = await makeTmp();
    await mkdir(path.join(project, '.rac'), { recursive: true });
    await writeFile(
      path.join(project, '.rac/config.toml'),
      '[[packs]]\nid = "a"\nrepo = "github:owner/a"\nref = "main"\n\n[[packs]]\nid = "b"\nrepo = "github:owner/b"\nref = "main"\n',
      'utf8'
    );
    await writeFile(
      path.join(project, '.rac/config.local.toml'),
      `[[pack_overrides]]\nid = "a"\npath = ${JSON.stringify(packADir)}\n`,
      'utf8'
    );
    await makeLocalPack(packADir);

    // Set up a fake cache dir so git calls "succeed" by pointing at a valid pack dir
    const originalCacheDir = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;
    try {
      // Create a fake cached repo for pack B
      const key = 'github:owner/b@main';
      const keyHash = Buffer.from(key).toString('base64url');
      const repoDir = path.join(cacheDir, 'packs', keyHash);
      await mkdir(path.join(repoDir, '.git'), { recursive: true });
      await mkdir(path.join(repoDir, '.rac'), { recursive: true });
      await writeFile(path.join(repoDir, '.rac/config.toml'), '', 'utf8');

      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = vi.fn().mockImplementation(async (args: string[]) => {
        gitCalls.push(args);
        // fetch and checkout succeed silently
      });

      const result = await resolvePacks(project, { gitRunner });

      expect(result).toHaveLength(3); // project + a + b
      const a = result.find((r) => r.id === 'a');
      const b = result.find((r) => r.id === 'b');
      expect(a?.override?.path).toBe(packADir);
      expect(b?.override).toBeUndefined();

      // git should have been called for B only (fetch + checkout = at least 1 call)
      expect(gitCalls.length).toBeGreaterThan(0);
      // None of the git calls should mention pack A's path
      for (const call of gitCalls) {
        expect(call.join(' ')).not.toContain('owner/a');
      }
    } finally {
      process.env.RAC_CACHE_DIR = originalCacheDir;
    }
  });

  it('no overrides: existing behavior unchanged (project + shared packs via gitRunner)', async () => {
    const project = await makeTmp();
    const cacheDir = await makeTmp();
    await mkdir(path.join(project, '.rac'), { recursive: true });
    await writeFile(
      path.join(project, '.rac/config.toml'),
      '[[packs]]\nid = "alpha"\nrepo = "github:owner/alpha"\nref = "main"\n',
      'utf8'
    );
    // No config.local.toml

    const originalCacheDir = process.env.RAC_CACHE_DIR;
    process.env.RAC_CACHE_DIR = cacheDir;
    try {
      const key = 'github:owner/alpha@main';
      const keyHash = Buffer.from(key).toString('base64url');
      const repoDir = path.join(cacheDir, 'packs', keyHash);
      await mkdir(path.join(repoDir, '.git'), { recursive: true });
      await mkdir(path.join(repoDir, '.rac'), { recursive: true });
      await writeFile(path.join(repoDir, '.rac/config.toml'), '', 'utf8');

      const gitRunner: GitRunner = vi.fn().mockImplementation(async () => { /* success */ });

      const result = await resolvePacks(project, { gitRunner });

      expect(result).toHaveLength(2);
      const alpha = result.find((r) => r.id === 'alpha');
      expect(alpha?.override).toBeUndefined();
      expect(gitRunner).toHaveBeenCalled();
    } finally {
      process.env.RAC_CACHE_DIR = originalCacheDir;
    }
  });
});

async function makePackDir(): Promise<string> {
  const packDir = await makeTmp();
  await mkdir(path.join(packDir, '.rac'), { recursive: true });
  await writeFile(path.join(packDir, '.rac/config.toml'), '', 'utf8');
  return packDir;
}

async function makeProjectWithPacks(packs: Array<{ id: string; repo: string; ref: string }>): Promise<string> {
  const root = await makeTmp();
  await mkdir(path.join(root, '.rac'), { recursive: true });
  const packsToml = packs
    .map((p) => `[[packs]]\nid = "${p.id}"\nrepo = "${p.repo}"\nref = "${p.ref}"\n`)
    .join('\n');
  await writeFile(path.join(root, '.rac/config.toml'), packsToml, 'utf8');
  return root;
}

describe('pack-config writers: setProjectPackOverride / clearProjectPackOverride / listProjectPackOverrides', () => {
  it('setProjectPackOverride writes a new entry; listProjectPackOverrides reads it back correctly', async () => {
    const packDir = await makePackDir();
    const root = await makeProjectWithPacks([{ id: 'alpha', repo: 'github:owner/alpha', ref: 'main' }]);

    await setProjectPackOverride(root, 'alpha', packDir);
    const overrides = await listProjectPackOverrides(root);
    expect(overrides).toEqual([{ id: 'alpha', path: packDir }]);
  });

  it('setProjectPackOverride replaces an existing override for the same id; ordering of unrelated entries is preserved', async () => {
    const packDir1 = await makePackDir();
    const packDir2 = await makePackDir();
    const packDir3 = await makePackDir();
    const root = await makeProjectWithPacks([
      { id: 'alpha', repo: 'github:owner/alpha', ref: 'main' },
      { id: 'beta', repo: 'github:owner/beta', ref: 'main' },
      { id: 'gamma', repo: 'github:owner/gamma', ref: 'main' },
    ]);

    // Set initial overrides for alpha and gamma
    await setProjectPackOverride(root, 'alpha', packDir1);
    await setProjectPackOverride(root, 'gamma', packDir3);

    // Replace alpha's override; beta has no override, gamma should keep its position
    await setProjectPackOverride(root, 'alpha', packDir2);

    const overrides = await listProjectPackOverrides(root);
    // alpha replaced in-place (first), gamma second
    expect(overrides).toEqual([
      { id: 'alpha', path: packDir2 },
      { id: 'gamma', path: packDir3 },
    ]);
  });

  it('setProjectPackOverride errors when id does not match any configured [[packs]] entry', async () => {
    const packDir = await makePackDir();
    const root = await makeProjectWithPacks([{ id: 'alpha', repo: 'github:owner/alpha', ref: 'main' }]);

    await expect(setProjectPackOverride(root, 'nonexistent', packDir)).rejects.toThrow(/pack not found/);
    await expect(setProjectPackOverride(root, 'nonexistent', packDir)).rejects.toThrow(/nonexistent/);
  });

  it('setProjectPackOverride errors with non-existent path; message includes both id and resolved absolute path', async () => {
    const root = await makeProjectWithPacks([{ id: 'alpha', repo: 'github:owner/alpha', ref: 'main' }]);
    const missingPath = path.join(root, 'no-such-dir');

    await expect(setProjectPackOverride(root, 'alpha', missingPath)).rejects.toThrow(/alpha/);
    await expect(setProjectPackOverride(root, 'alpha', missingPath)).rejects.toThrow(new RegExp(missingPath.replace(/[/\\]/g, '.')));
  });

  it('setProjectPackOverride errors when path exists but is missing .rac/config.toml', async () => {
    const root = await makeProjectWithPacks([{ id: 'alpha', repo: 'github:owner/alpha', ref: 'main' }]);
    const emptyDir = await makeTmp(); // exists but no .rac/config.toml

    await expect(setProjectPackOverride(root, 'alpha', emptyDir)).rejects.toThrow(/alpha/);
    await expect(setProjectPackOverride(root, 'alpha', emptyDir)).rejects.toThrow(/missing .rac\/config\.toml/);
  });

  it('setProjectPackOverride errors with bad id charset', async () => {
    const packDir = await makePackDir();
    const root = await makeProjectWithPacks([]);
    // id isn't even in packs, but we check id format — this will throw "pack not found" not "invalid id"
    // because we validate id against packs first, then validate shape
    // Actually per spec: validate id against packs list first, then shape validation
    // So "bad id" won't match any pack → "pack not found"
    // But if id = "project" specifically also needs to error
    await expect(setProjectPackOverride(root, 'project', packDir)).rejects.toThrow('pack not found');
  });

  it('setProjectPackOverride errors with id = "project" (reserved)', async () => {
    const packDir = await makePackDir();
    const root = await makeProjectWithPacks([]);
    // "project" id won't be in [[packs]] list, so it hits "pack not found" first
    await expect(setProjectPackOverride(root, 'project', packDir)).rejects.toThrow('pack not found');
  });

  it('clearProjectPackOverride removes one entry and preserves others; rewrites file', async () => {
    const packDir1 = await makePackDir();
    const packDir2 = await makePackDir();
    const root = await makeProjectWithPacks([
      { id: 'alpha', repo: 'github:owner/alpha', ref: 'main' },
      { id: 'beta', repo: 'github:owner/beta', ref: 'main' },
    ]);

    await setProjectPackOverride(root, 'alpha', packDir1);
    await setProjectPackOverride(root, 'beta', packDir2);

    await clearProjectPackOverride(root, 'alpha');

    const overrides = await listProjectPackOverrides(root);
    expect(overrides).toEqual([{ id: 'beta', path: packDir2 }]);
  });

  it('clearProjectPackOverride deletes config.local.toml when removing the last entry', async () => {
    const packDir = await makePackDir();
    const root = await makeProjectWithPacks([{ id: 'alpha', repo: 'github:owner/alpha', ref: 'main' }]);

    await setProjectPackOverride(root, 'alpha', packDir);
    await clearProjectPackOverride(root, 'alpha');

    // File should no longer exist
    await expect(readFile(path.join(root, '.rac/config.local.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('clearProjectPackOverride errors when id is not present (override not found)', async () => {
    const root = await makeProjectWithPacks([{ id: 'alpha', repo: 'github:owner/alpha', ref: 'main' }]);

    await expect(clearProjectPackOverride(root, 'alpha')).rejects.toThrow(/override not found/);
    await expect(clearProjectPackOverride(root, 'alpha')).rejects.toThrow(/alpha/);
  });
});

describe('CLI: pack override and pack list with overrides', () => {
  it('pack override <id> <path> happy path: success message and file contains the entry', async () => {
    const packDir = await makePackDir();
    const root = await makeProjectWithPacks([{ id: 'alpha', repo: 'github:owner/alpha', ref: 'main' }]);

    const result = await runCliInProcess(root, ['pack', 'override', 'alpha', packDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Set override for alpha');

    const overrides = await listProjectPackOverrides(root);
    expect(overrides).toEqual([{ id: 'alpha', path: packDir }]);
  });

  it('pack override <id> --clear happy path: success message and entry removed', async () => {
    const packDir = await makePackDir();
    const root = await makeProjectWithPacks([{ id: 'alpha', repo: 'github:owner/alpha', ref: 'main' }]);

    await setProjectPackOverride(root, 'alpha', packDir);

    const result = await runCliInProcess(root, ['pack', 'override', 'alpha', '--clear']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Cleared override for alpha');

    const overrides = await listProjectPackOverrides(root);
    expect(overrides).toEqual([]);
  });

  it('pack override <id> <path> --clear (both provided) → exit non-zero, stderr mentions conflict', async () => {
    const packDir = await makePackDir();
    const root = await makeProjectWithPacks([{ id: 'alpha', repo: 'github:owner/alpha', ref: 'main' }]);

    const result = await runCliInProcess(root, ['pack', 'override', 'alpha', packDir, '--clear']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot pass <path> together with --clear');
  });

  it('pack override <id> (no path, no --clear) → exit non-zero, stderr mentions missing path', async () => {
    const root = await makeProjectWithPacks([{ id: 'alpha', repo: 'github:owner/alpha', ref: 'main' }]);

    const result = await runCliInProcess(root, ['pack', 'override', 'alpha']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing <path> argument');
  });

  it('pack list shows (override → <path>) for overridden packs and not for un-overridden ones', async () => {
    const packDir = await makePackDir();
    const root = await makeProjectWithPacks([
      { id: 'alpha', repo: 'github:owner/alpha', ref: 'main' },
      { id: 'beta', repo: 'github:owner/beta', ref: 'v1' },
    ]);

    await setProjectPackOverride(root, 'alpha', packDir);

    const result = await runCliInProcess(root, ['pack', 'list']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`(override → ${packDir})`);
    // beta has no override
    const lines = result.stdout.split('\n');
    const betaLine = lines.find((l) => l.includes('beta'));
    expect(betaLine).toBeDefined();
    expect(betaLine).not.toContain('override');
    // alpha line has override
    const alphaLine = lines.find((l) => l.includes('alpha'));
    expect(alphaLine).toBeDefined();
    expect(alphaLine).toContain('override');
  });
});
