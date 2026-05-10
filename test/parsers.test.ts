import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';

import { addProjectPack, listProjectPacks, removeProjectPack } from '../src/core/pack-config.js';
import { loadAgents, loadInstallSettings, loadMcps, loadProjectPackConfig, loadRules, loadSkills, loadVendorConfigs } from '../src/core/parsers.js';

import { cleanupTmpDirs, makeTmp, runCli } from './helpers.js';

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

    const listEmpty = runCli(root, ['pack', 'list']);
    expect(listEmpty.status).toBe(0);
    expect(listEmpty.stdout).toBe('No packs configured.\n');

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
    expect(listOne.stdout).toBe('alpha  github:owner/alpha @ tag"\\candidate\n');

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
});
