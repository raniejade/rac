import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';

import { doctor, initProject, install } from '../src/core/install.js';
import { loadProjectPackConfig, loadSharedPackConfig } from '../src/core/parsers.js';
import { MANAGED_JSONC_WARNING, MANAGED_MARKDOWN_WARNING, MANAGED_TOML_WARNING } from '../src/core/util.js';

import { cleanupTmpDirs, makeTmp, readJsoncFile, runCliInProcess, seed } from './helpers.js';

afterEach(cleanupTmpDirs);

describe('install + doctor', () => {
  it('init refuses overwrite and install auto-discovers all non-SKILL files', async () => {
    const root = await makeTmp();
    await initProject(root, false);
    await expect(initProject(root, false)).rejects.toThrow('refusing to overwrite existing init examples');

    await seed(root);
    await writeFile(path.join(root, '.rac/skills/project-gates/extra.txt'), 'extra', 'utf8');
    await mkdir(path.join(root, '.rac/skills/project-gates/references'), { recursive: true });
    await writeFile(path.join(root, '.rac/skills/project-gates/references/notes.md'), 'notes', 'utf8');
    await writeFile(path.join(root, '.rac/skills/project-gates/.DS_Store'), 'junk', 'utf8');
    await install({ cwd: root, targets: ['claude'], kinds: ['skill'] });

    await expect(stat(path.join(root, '.claude/skills/project-gates/checklist.md'))).resolves.toBeTruthy();
    await expect(stat(path.join(root, '.claude/skills/project-gates/extra.txt'))).resolves.toBeTruthy();
    await expect(stat(path.join(root, '.claude/skills/project-gates/references/notes.md'))).resolves.toBeTruthy();
    await expect(stat(path.join(root, '.claude/skills/project-gates/.DS_Store'))).rejects.toThrow();
  });

  it('rejects traversal from agent instructions', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');

    await writeFile(path.join(root, '.rac/agents/a.toml'), 'id = "a"\ninstructions = "../../etc/passwd"\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('agent instructions traversal rejected');
  });

  it('surgically merges existing unmanaged shared json by default; --no-merge refuses without --force; dry-run writes nothing', async () => {
    const root = await makeTmp();
    await seed(root);

    await mkdir(path.join(root, '.opencode'), { recursive: true });
    await writeFile(path.join(root, '.opencode/opencode.jsonc'), '{"external":true}\n', 'utf8');

    await install({ cwd: root, targets: ['opencode'], kinds: ['mcp'] });
    const merged = await readJsoncFile<{ external?: boolean; mcp?: Record<string, unknown> }>(path.join(root, '.opencode/opencode.jsonc'));
    expect(merged.external).toBe(true);
    expect(Object.keys(merged.mcp ?? {}).length).toBeGreaterThan(0);

    const root2 = await makeTmp();
    await seed(root2);
    await mkdir(path.join(root2, '.opencode'), { recursive: true });
    await writeFile(path.join(root2, '.opencode/opencode.jsonc'), '{"external":true}\n', 'utf8');

    await expect(install({ cwd: root2, targets: ['opencode'], kinds: ['mcp'], noMerge: true })).rejects.toThrow('refusing overwrite unmanaged file');
    await expect(install({ cwd: root2, targets: ['opencode'], kinds: ['mcp'], noMerge: true, dryRun: true })).rejects.toThrow('refusing overwrite unmanaged file');

    const beforeManifestMissing = stat(path.join(root2, '.codex/.rac-install-manifest.json'));
    await expect(beforeManifestMissing).rejects.toThrow();
    await install({ cwd: root2, targets: ['codex'], kinds: ['agent'], dryRun: true });
    await expect(stat(path.join(root2, '.codex/.rac-install-manifest.json'))).rejects.toThrow();

    await expect(install({ cwd: root2, targets: ['opencode'], kinds: ['mcp'], noMerge: true, force: true })).resolves.toBeTruthy();
  });

  it('recognizes managed warnings for manifest-loss overwrite safety and rejects legacy marker-only files', async () => {
    const root = await makeTmp();
    await seed(root);

    const agentPath = path.join(root, '.codex/agents/reviewer.toml');
    const manifestPath = path.join(root, '.codex/.rac-install-manifest.json');

    await install({ cwd: root, targets: ['codex'], kinds: ['agent'] });
    expect(await readFile(agentPath, 'utf8')).toContain(MANAGED_TOML_WARNING);

    await rm(manifestPath);
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).resolves.toBeTruthy();

    await rm(manifestPath);
    await writeFile(agentPath, '<!-- managed-by-rac -->\nold generated content\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('refusing overwrite unmanaged file');

    await writeFile(agentPath, '<!-- rac-frontmatter-sensitive -->\nold generated content\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('refusing overwrite unmanaged file');
  });

  it('treats markdown marker in body as unmanaged when manifest is missing', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['codex'], kinds: ['skill'] });
    const skillPath = path.join(root, '.agents/skills/project-gates/SKILL.md');
    const manifestPath = path.join(root, '.agents/.rac-install-manifest.json');

    await rm(manifestPath);
    await writeFile(skillPath, `Intro line\n${MANAGED_MARKDOWN_WARNING}\nGenerated-like body\n`, 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['skill'] })).rejects.toThrow('refusing overwrite unmanaged file');
  });

  it('accepts canonical post-frontmatter markdown marker when manifest is missing', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: ['codex'], kinds: ['skill'] });
    const skillPath = path.join(root, '.agents/skills/project-gates/SKILL.md');
    const skillAssetPath = path.join(root, '.agents/skills/project-gates/checklist.md');
    const manifestPath = path.join(root, '.agents/.rac-install-manifest.json');

    await rm(manifestPath);
    await rm(skillAssetPath);
    await writeFile(skillPath, `---\nname: "project-gates"\ndescription: "project checks"\n---\n${MANAGED_MARKDOWN_WARNING}\nGenerated-like body\n`, 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['skill'] })).resolves.toBeTruthy();
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
    expect(result.del.some((file) => file.endsWith('reviewer.toml'))).toBe(true);
    expect(await readFile(path.join(root, '.codex/agents/keep.md'), 'utf8')).toBe('keep');
  });

  it('aggregates multiple MCP definitions into one shared target config write', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.rac/mcps/z-remote.toml'), 'id = "z-remote"\nurl = "https://example.test/z"\n', 'utf8');
    await writeFile(path.join(root, '.rac/mcps/a-remote.toml'), 'id = "a-remote"\nurl = "https://example.test/a"\n', 'utf8');

    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['mcp'] });

    const claudeProject = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(claudeProject.mcpServers)).toEqual(['a-remote', 'project-rules', 'z-remote']);

    const codexToml = await readFile(path.join(root, '.codex/config.toml'), 'utf8');
    expect(codexToml.indexOf('[mcp_servers.a-remote]')).toBeLessThan(codexToml.indexOf('[mcp_servers.project-rules]'));
    expect(codexToml.indexOf('[mcp_servers.project-rules]')).toBeLessThan(codexToml.indexOf('[mcp_servers.z-remote]'));
    expect(codexToml).toContain('startup_timeout_sec = 2');
    expect(codexToml).not.toContain('startup_timeout = ');

    const opencodeRaw = await readFile(path.join(root, '.opencode/opencode.jsonc'), 'utf8');
    expect(opencodeRaw.startsWith(`${MANAGED_JSONC_WARNING}\n`)).toBe(true);
    const opencode = await readJsoncFile<{ mcp: Record<string, { type: string; enabled: boolean; command?: string[]; url?: string }> }>(path.join(root, '.opencode/opencode.jsonc'));
    expect(Object.keys(opencode.mcp)).toEqual(['a-remote', 'project-rules', 'z-remote']);
  });

  it('installs vendor-wide config for codex, claude, and opencode with selector manifests', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    await writeFile(
      path.join(root, '.rac/config.toml'),
      '[vendor.codex.config]\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n[vendor.codex.config.features]\nmulti_agent = true\n[vendor.claude.raw]\nallowedMcpServers = [{ serverName = "github" }]\n[vendor.opencode.raw_json]\nplugin = """["opencode-plugin-foo", ["opencode-plugin-bar", { "enabled": true }]]"""\n',
      'utf8'
    );

    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['config'] });

    const codex = parseToml(await readFile(path.join(root, '.codex/config.toml'), 'utf8')) as {
      model?: string;
      model_reasoning_effort?: string;
      features?: { multi_agent?: boolean };
    };
    expect(codex.model).toBe('gpt-5.5');
    expect(codex.model_reasoning_effort).toBe('medium');
    expect(codex.features?.multi_agent).toBe(true);

    const claude = JSON.parse(await readFile(path.join(root, '.claude/settings.json'), 'utf8')) as { allowedMcpServers?: Array<{ serverName?: string }> };
    expect(claude.allowedMcpServers?.[0]?.serverName).toBe('github');

    const opencodeRaw = await readFile(path.join(root, '.opencode/opencode.jsonc'), 'utf8');
    expect(opencodeRaw.startsWith(`${MANAGED_JSONC_WARNING}\n`)).toBe(true);
    const opencode = await readJsoncFile<{ plugin?: unknown[] }>(path.join(root, '.opencode/opencode.jsonc'));
    expect(opencode.plugin).toEqual(['opencode-plugin-foo', ['opencode-plugin-bar', { enabled: true }]]);

    const codexManifest = JSON.parse(await readFile(path.join(root, '.codex/.rac-install-manifest.json'), 'utf8')) as {
      records: Array<{ kind: string; id: string; inventory: Array<{ selector: string }> }>;
    };
    const codexConfigRecord = codexManifest.records.find((record) => record.kind === 'config');
    expect(codexConfigRecord?.id).toBe('config');
    expect(codexConfigRecord?.inventory.map((entry) => entry.selector)).toEqual([
      '$["model"]',
      '$["model_reasoning_effort"]',
      '$["features"]["multi_agent"]'
    ]);
  });

  it('merges config with generated mcp/rule shared files and preserves user-owned siblings', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(
      path.join(root, '.rac/config.toml'),
      '[vendor.codex.config]\nmodel = "gpt-5.5"\n[vendor.claude.config.ui]\ntheme = "dark"\n[vendor.opencode.config]\nplugin = ["opencode-plugin-foo"]\n',
      'utf8'
    );
    await mkdir(path.join(root, '.codex'), { recursive: true });
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await mkdir(path.join(root, '.opencode'), { recursive: true });
    await writeFile(path.join(root, '.codex/config.toml'), 'approval_policy = "on-request"\n', 'utf8');
    await writeFile(path.join(root, '.claude/settings.json'), JSON.stringify({ external: true }, null, 2) + '\n', 'utf8');
    await writeFile(path.join(root, '.opencode/opencode.jsonc'), '{"external":true}\n', 'utf8');

    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['mcp', 'rule', 'config'] });

    const codex = parseToml(await readFile(path.join(root, '.codex/config.toml'), 'utf8')) as {
      approval_policy?: string;
      model?: string;
      mcp_servers?: Record<string, unknown>;
    };
    expect(codex.approval_policy).toBe('on-request');
    expect(codex.model).toBe('gpt-5.5');
    expect(codex.mcp_servers?.['project-rules']).toBeTruthy();

    const claude = JSON.parse(await readFile(path.join(root, '.claude/settings.json'), 'utf8')) as {
      external?: boolean;
      ui?: { theme?: string };
      permissions?: { deny?: string[] };
    };
    expect(claude.external).toBe(true);
    expect(claude.ui?.theme).toBe('dark');
    expect(claude.permissions?.deny).toContain('Bash(git push)');

    const opencode = await readJsoncFile<{
      external?: boolean;
      plugin?: string[];
      mcp?: Record<string, unknown>;
      permission?: { bash?: Record<string, string> };
    }>(path.join(root, '.opencode/opencode.jsonc'));
    expect(opencode.external).toBe(true);
    expect(opencode.plugin).toEqual(['opencode-plugin-foo']);
    expect(opencode.mcp?.['project-rules']).toBeTruthy();
    expect(opencode.permission?.bash?.['git push']).toBe('deny');
  });

  it('config clean/check/dry-run update only owned selectors', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '[vendor.codex.config]\nmodel = "gpt-5.5"\n', 'utf8');
    await mkdir(path.join(root, '.codex'), { recursive: true });
    await writeFile(path.join(root, '.codex/config.toml'), 'approval_policy = "on-request"\n', 'utf8');

    const dryRun = await install({ cwd: root, targets: ['codex'], kinds: ['config'], dryRun: true });
    expect(dryRun.update).toContain(path.join(root, '.codex/config.toml'));
    expect(await readFile(path.join(root, '.codex/config.toml'), 'utf8')).not.toContain('gpt-5.5');

    await install({ cwd: root, targets: ['codex'], kinds: ['config'] });
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['config'], check: true })).resolves.toBeTruthy();

    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['config'], check: true })).rejects.toThrow('stale managed output requires cleanup');
    await install({ cwd: root, targets: ['codex'], kinds: ['config'], clean: true });
    const cleaned = parseToml(await readFile(path.join(root, '.codex/config.toml'), 'utf8')) as { approval_policy?: string; model?: string };
    expect(cleaned.approval_policy).toBe('on-request');
    expect(cleaned.model).toBeUndefined();
  });

  it('rejects config selectors that overlap generated mcp or rule ownership', async () => {
    const root = await makeTmp();
    await seed(root);

    await writeFile(path.join(root, '.rac/config.toml'), '[vendor.codex.raw]\nmcp_servers = { other = { command = "node" } }\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['mcp', 'config'] })).rejects.toThrow('selector conflict');

    await writeFile(path.join(root, '.rac/config.toml'), '[vendor.claude.raw]\npermissions = { deny = ["Bash(ls)"] }\n', 'utf8');
    await expect(install({ cwd: root, targets: ['claude'], kinds: ['rule', 'config'] })).rejects.toThrow('selector conflict');

    await writeFile(path.join(root, '.rac/rules/allow.toml'), '[[rule]]\nid = "allow-ls"\ndecision = "allow"\njustification = "safe"\ncommand = ["ls"]\nappend_wildcard = false\n', 'utf8');
    await writeFile(path.join(root, '.rac/config.toml'), '[vendor.claude.raw]\npermissions = { allow = ["Bash(pwd)"] }\n', 'utf8');
    await expect(install({ cwd: root, targets: ['claude'], kinds: ['rule', 'config'] })).rejects.toThrow('selector conflict');

    await writeFile(path.join(root, '.rac/config.toml'), '[vendor.opencode.raw]\nmcp = { other = { type = "local" } }\n', 'utf8');
    await expect(install({ cwd: root, targets: ['opencode'], kinds: ['mcp', 'config'] })).rejects.toThrow('selector conflict');
  });

  it('installs centralized rules for codex/claude/opencode and combines opencode mcp+rule payload', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.rac/rules/allow.toml'), '[[rule]]\nid = "allow-git-status"\ndecision = "allow"\njustification = "Safe status"\ncommand = ["git", "status"]\nappend_wildcard = false\n', 'utf8');

    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['mcp', 'rule'] });

    const codexRules = await readFile(path.join(root, '.codex/rules/wrappers.rules'), 'utf8');
    expect(codexRules.startsWith(`${MANAGED_TOML_WARNING}\n`)).toBe(true);
    expect(codexRules).toContain([
      'prefix_rule(',
      '  pattern = ["gh", "pr", "merge"],',
      '  decision = "forbidden",',
      '  justification = "Use wrapper",',
      ')'
    ].join('\n'));
    expect(codexRules).toContain([
      'prefix_rule(',
      '  pattern = ["gh", "issue", "merge"],',
      '  decision = "forbidden",',
      '  justification = "Use wrapper",',
      ')'
    ].join('\n'));
    expect(codexRules).toContain([
      'prefix_rule(',
      '  pattern = ["git", "push"],',
      '  decision = "forbidden",',
      '  justification = "Use wrapper",',
      ')'
    ].join('\n'));
    const codexAllowRules = await readFile(path.join(root, '.codex/rules/allow.rules'), 'utf8');
    expect(codexAllowRules).toContain([
      'prefix_rule(',
      '  pattern = ["git", "status"],',
      '  decision = "allow",',
      '  justification = "Safe status",',
      ')'
    ].join('\n'));
    expect(codexRules).not.toContain('append_wildcard');
    expect(codexRules).not.toContain('true');
    expect(codexRules).not.toContain('false');

    const claudeSettings = JSON.parse(await readFile(path.join(root, '.claude/settings.json'), 'utf8')) as { permissions: { allow: string[]; deny: string[] } };
    expect(claudeSettings.permissions.allow).toContain('Bash(git status)');
    expect(claudeSettings.permissions.deny).toContain('Bash(gh pr merge *)');
    expect(claudeSettings.permissions.deny).toContain('Bash(gh issue merge *)');
    expect(claudeSettings.permissions.deny).toContain('Bash(git push)');

    const opencode = await readJsoncFile<{ mcp: Record<string, unknown>; permission: { bash: Record<string, string> } }>(path.join(root, '.opencode/opencode.jsonc'));
    expect(opencode.mcp).toBeTruthy();
    expect(opencode.permission.bash['gh pr merge *']).toBe('deny');
    expect(opencode.permission.bash['gh issue merge *']).toBe('deny');
    expect(opencode.permission.bash['git push']).toBe('deny');
    expect(opencode.permission.bash['git status']).toBe('allow');

    const claudeManifest = JSON.parse(await readFile(path.join(root, '.claude/.rac-install-manifest.json'), 'utf8')) as {
      records: Array<{ id: string; inventory: Array<{ selector: string; entries?: string[] }> }>;
    };
    expect(claudeManifest.records.find((record) => record.id === 'allow-git-status')?.inventory[0]).toEqual({
      version: 1,
      format: 'json',
      selector: '$.permissions.allow',
      entries: ['Bash(git status)']
    });
    expect(claudeManifest.records.find((record) => record.id === 'deny-git-push')?.inventory[0].selector).toBe('$.permissions.deny');

    const opencodeManifest = JSON.parse(await readFile(path.join(root, '.opencode/.rac-install-manifest.json'), 'utf8')) as {
      records: Array<{ id: string; inventory: Array<{ selector: string; entries?: string[] }> }>;
    };
    expect(opencodeManifest.records.find((record) => record.id === 'allow-git-status')?.inventory[0]).toEqual({
      version: 1,
      format: 'json',
      selector: '$.permission.bash',
      entries: ['git status']
    });
  });

  it('rejects exact expanded command conflicts across allow and forbidden rules', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(
      path.join(root, '.rac/rules/allow-conflict.toml'),
      '[[rule]]\nid = "allow-git-push"\ndecision = "allow"\njustification = "safe"\ncommand = ["git", "push"]\nappend_wildcard = false\n',
      'utf8'
    );

    await expect(install({ cwd: root, targets: ['codex'], kinds: ['rule'] })).rejects.toThrow('conflicting rule decisions for command "git push": allow-git-push, deny-git-push');
  });

  it('preserves OpenCode shared mcp/rule sibling content across separate install/check/clean operations', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.rac/rules/allow.toml'), '[[rule]]\nid = "allow-git-status"\ndecision = "allow"\njustification = "Safe status"\ncommand = ["git", "status"]\nappend_wildcard = false\n', 'utf8');

    await install({ cwd: root, targets: ['opencode'], kinds: ['mcp'] });
    await install({ cwd: root, targets: ['opencode'], kinds: ['rule'] });

    const combined = await readJsoncFile<{
      mcp?: Record<string, unknown>;
      permission?: { bash?: Record<string, string> };
    }>(path.join(root, '.opencode/opencode.jsonc'));
    expect(combined.mcp).toBeTruthy();
    expect(combined.permission?.bash?.['git push']).toBe('deny');
    expect(combined.permission?.bash?.['git status']).toBe('allow');

    await expect(install({ cwd: root, targets: ['opencode'], kinds: ['mcp'], check: true })).resolves.toBeTruthy();

    await rm(path.join(root, '.rac/rules/wrappers.toml'));
    await rm(path.join(root, '.rac/rules/allow.toml'));
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
    await writeFile(path.join(root, '.rac/mcps/a-remote.toml'), 'id = "a-remote"\nurl = "https://example.test/a"\n', 'utf8');

    await install({ cwd: root, targets: ['opencode'], kinds: ['mcp'] });

    const opencode = await readJsoncFile<{
      mcp: Record<string, { type: string; enabled: boolean; command?: unknown; url?: unknown }>;
    }>(path.join(root, '.opencode/opencode.jsonc'));

    expect(opencode.mcp['project-rules']).toEqual({
      type: 'local',
      enabled: true,
      command: ['node', './mcp.js'],
      environment: { LOG_LEVEL: 'info', PROJECT_RULES_TOKEN: '{env:PROJECT_RULES_TOKEN}' }
    });
    expect(opencode.mcp['a-remote']).toEqual({
      type: 'remote',
      enabled: true,
      url: 'https://example.test/a'
    });

    const local = opencode.mcp['project-rules'] as { command?: unknown; args?: unknown };
    expect(Array.isArray(local.command)).toBe(true);
    expect(local).not.toHaveProperty('args');
    expect(local.command).not.toEqual({ command: 'node', args: ['./mcp.js'] });
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
    await writeFile(path.join(root, '.rac/mcps/remote.toml'), 'id = "remote"\nurl = "https://example.test/mcp"\n', 'utf8');
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
    await writeFile(path.join(root, '.rac/config.toml'), '[vendor.codex.config]\nmodel = "gpt-5.5"\n', 'utf8');
    await writeFile(path.join(root, '.rac/mcps/special.toml'), 'id = "dot id \\"x\\".日本語"\ncommand = "node"\n', 'utf8');
    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['mcp', 'config'] });

    const codexToml = await readFile(path.join(root, '.codex/config.toml'), 'utf8');
    expect(codexToml).toContain('[mcp_servers."dot id \\"x\\".日本語"]');
    expect(codexToml).toContain('model = "gpt-5.5"');

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

    await writeFile(path.join(root, '.codex/agents/reviewer.toml'), 'tampered\n', 'utf8');
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'], check: true })).rejects.toThrow('different generated output');
  });

  it('install --check reports stale managed outputs needing cleanup and does not delete', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['codex'], kinds: ['agent'] });
    await rm(path.join(root, '.rac/agents/reviewer.toml'));
    await rm(path.join(root, '.rac/agents/reviewer.md'));

    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'], check: true })).rejects.toThrow('stale managed output requires cleanup');
    await expect(stat(path.join(root, '.codex/agents/reviewer.toml'))).resolves.toBeTruthy();
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
    expect(toml).toContain('developer_instructions = """');
    expect((parsed.developer_instructions as string)).toBe('line "one"\nline two\n');
    expect(Object.keys(parsed).sort()).toEqual(['description', 'developer_instructions', 'name']);
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('instructions');
  });

  it('Codex multiline TOML instructions round-trip quotes, triple quotes, backslashes, and trailing newline', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');
    await writeFile(path.join(root, '.rac/agents/reviewer.toml'), 'id = "reviewer"\ninstructions = "./reviewer.md"\n', 'utf8');
    await writeFile(
      path.join(root, '.rac/agents/reviewer.md'),
      'line "one"\ntriple """ quote\npath C:\\tmp\\repo\nslash \\\n',
      'utf8'
    );

    await install({ cwd: root, targets: ['codex'], kinds: ['agent'] });
    const toml = await readFile(path.join(root, '.codex/agents/reviewer.toml'), 'utf8');
    const parsed = parseToml(toml) as Record<string, unknown>;
    expect(toml).toContain('developer_instructions = """');
    expect(parsed.developer_instructions).toBe('line "one"\ntriple """ quote\npath C:\\tmp\\repo\nslash \\\n');
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

  it('doctor emits expected warnings for env and opencode legacy tools', async () => {
    const root = await makeTmp();
    await seed(root);

    const warnings = await doctor(root, ['codex', 'opencode'], ['agent', 'mcp']);
    expect(warnings.some((w) => w.code === 'missing_env_var' && w.message.includes('PROJECT_RULES_TOKEN'))).toBe(true);
    expect(warnings.some((w) => w.code === 'opencode_legacy_tools' && w.message.includes('reviewer'))).toBe(true);
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
    await writeFile(
      path.join(root, '.rac/mcps/remote-server.toml'),
      'id = "remote-server"\nurl = "https://example.test/mcp"\n[vendor.claude.config]\ntype = "sse"\n[vendor.codex.config]\ntype = "streamable-http"\n[vendor.opencode.config]\nreadOnly = true\n',
      'utf8'
    );
    await install({ cwd: root, targets: ['claude', 'codex', 'opencode'], kinds: ['mcp'] });

    const claudeProject = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(claudeProject.mcpServers.server.notes).toBe('claude');
    expect(claudeProject.mcpServers['remote-server']).toEqual({
      type: 'sse',
      url: 'https://example.test/mcp'
    });

    const codexToml = await readFile(path.join(root, '.codex/config.toml'), 'utf8');
    expect(codexToml).toContain('enabled = true');
    expect(codexToml).toContain('[mcp_servers.remote-server]');
    expect(codexToml).toContain('type = "streamable-http"');
    expect(codexToml).toContain('url = "https://example.test/mcp"');

    const opencode = await readJsoncFile<{ mcp: Record<string, Record<string, unknown>> }>(path.join(root, '.opencode/opencode.jsonc'));
    expect(opencode.mcp.server.readOnly).toBe(true);
    expect(opencode.mcp['remote-server'].readOnly).toBe(true);
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
    expect(claudeSkill.startsWith('---\n')).toBe(true);
    expect(claudeSkill).toMatch(/^---\r?\n[\s\S]*?\r?\n---\r?\n<!-- DO NOT EDIT; managed by rac -->\r?\n/);
    expect(claudeSkill).toContain(MANAGED_MARKDOWN_WARNING);
    expect(claudeSkill).not.toContain('managed-by-rac');
    expect(claudeSkill).not.toContain('rac-frontmatter-sensitive');
    expect(claudeSkill).toContain('name: "s1"');
    expect(claudeSkill).toContain('description: "skill"');
    expect(claudeSkill).toContain('audience: "claude-config"');

    const codexSkill = await readFile(path.join(root, '.agents/skills/s1/SKILL.md'), 'utf8');
    expect(codexSkill.startsWith('---\n')).toBe(true);
    expect(codexSkill).toMatch(/^---\r?\n[\s\S]*?\r?\n---\r?\n<!-- DO NOT EDIT; managed by rac -->\r?\n/);
    expect(codexSkill).toContain(MANAGED_MARKDOWN_WARNING);
    expect(codexSkill).not.toContain('managed-by-rac');
    expect(codexSkill).not.toContain('rac-frontmatter-sensitive');
    expect(codexSkill).toContain('name: "s1"');
    expect(codexSkill).toContain('description: "skill"');
    expect(codexSkill).toContain('model: "gpt-5"');

    const opencodeSkill = await readFile(path.join(root, '.opencode/skills/s1/SKILL.md'), 'utf8');
    expect(opencodeSkill.startsWith('---\n')).toBe(true);
    expect(opencodeSkill).toMatch(/^---\r?\n[\s\S]*?\r?\n---\r?\n<!-- DO NOT EDIT; managed by rac -->\r?\n/);
    expect(opencodeSkill).toContain(MANAGED_MARKDOWN_WARNING);
    expect(opencodeSkill).not.toContain('managed-by-rac');
    expect(opencodeSkill).not.toContain('rac-frontmatter-sensitive');
    expect(opencodeSkill).toContain('name: "s1"');
    expect(opencodeSkill).toContain('description: "skill"');
    expect(opencodeSkill).toContain('enabled: true');
  });

  it('fails fast on vendor collision with generated keys and unsupported codex emit field', async () => {
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
      'id = "reviewer"\ninstructions = "inline"\n[vendor.codex]\nemit = "instruction-only"\n',
      'utf8'
    );
    await expect(install({ cwd: root, targets: ['codex'], kinds: ['agent'] })).rejects.toThrow('uses removed API: vendor.codex.emit');

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

  it('init creates .rac/.gitignore containing config.local.toml', async () => {
    const root = await makeTmp();
    await initProject(root, true);
    const gitignorePath = path.join(root, '.rac/.gitignore');
    await expect(stat(gitignorePath)).resolves.toBeTruthy();
    const content = await readFile(gitignorePath, 'utf8');
    expect(content).toContain('config.local.toml');
  });

  it('init does not duplicate config.local.toml in .rac/.gitignore on repeated runs', async () => {
    const root = await makeTmp();
    await initProject(root, true);
    await initProject(root, true);
    const content = await readFile(path.join(root, '.rac/.gitignore'), 'utf8');
    const matches = content.split('\n').filter(line => line === 'config.local.toml');
    expect(matches).toHaveLength(1);
  });

  it('init preserves existing lines in .rac/.gitignore and appends config.local.toml', async () => {
    const root = await makeTmp();
    // Pre-create .rac dir and a .gitignore with custom content
    await mkdir(path.join(root, '.rac'), { recursive: true });
    await writeFile(path.join(root, '.rac/.gitignore'), '*.log\nlocal-secrets.toml\n', 'utf8');
    await initProject(root, true);
    const content = await readFile(path.join(root, '.rac/.gitignore'), 'utf8');
    expect(content).toContain('*.log');
    expect(content).toContain('local-secrets.toml');
    expect(content).toContain('config.local.toml');
    // Ensure config.local.toml appears exactly once
    const matches = content.split('\n').filter(line => line === 'config.local.toml');
    expect(matches).toHaveLength(1);
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

  it('loads vendor-wide config from shared packs and rejects cross-pack selector overlap', async () => {
    if (spawnSync('git', ['--version']).status !== 0) return;
    const root = await makeTmp();
    const cacheRoot = path.join(root, '.cache');
    process.env.RAC_CACHE_DIR = cacheRoot;
    try {
      const remote = path.join(root, 'remote');
      await mkdir(path.join(remote, '.rac'), { recursive: true });
      await writeFile(
        path.join(remote, '.rac/config.toml'),
        '[vendor.codex.config.features]\nshared_pack = true\n[vendor.opencode.config]\nplugin = ["shared-plugin"]\n',
        'utf8'
      );
      spawnSync('git', ['init'], { cwd: remote });
      spawnSync('git', ['add', '.'], { cwd: remote });
      spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: remote });

      await mkdir(path.join(root, '.rac'), { recursive: true });
      await writeFile(
        path.join(root, '.rac/config.toml'),
        '[vendor.codex.config]\nmodel = "gpt-5.5"\n\n[[packs]]\nid = "shared"\nrepo = "github:owner/repo"\nref = "HEAD"\n',
        'utf8'
      );

      const key = Buffer.from('github:owner/repo@HEAD').toString('base64url');
      const cachedRepo = path.join(cacheRoot, 'packs', key);
      await mkdir(path.dirname(cachedRepo), { recursive: true });
      spawnSync('git', ['clone', remote, cachedRepo]);

      await install({ cwd: root, targets: ['codex', 'opencode'], kinds: ['config'] });

      const codex = parseToml(await readFile(path.join(root, '.codex/config.toml'), 'utf8')) as {
        model?: string;
        features?: { shared_pack?: boolean };
      };
      expect(codex.model).toBe('gpt-5.5');
      expect(codex.features?.shared_pack).toBe(true);

      const opencode = await readJsoncFile<{ plugin?: string[] }>(path.join(root, '.opencode/opencode.jsonc'));
      expect(opencode.plugin).toEqual(['shared-plugin']);

      const manifest = JSON.parse(await readFile(path.join(root, '.codex/.rac-install-manifest.json'), 'utf8')) as {
        records: Array<{ pack: string; kind: string; inventory: Array<{ selector: string }> }>;
      };
      expect(manifest.records.some((record) => record.pack === 'shared' && record.kind === 'config' && record.inventory[0]?.selector === '$["features"]["shared_pack"]')).toBe(true);

      await writeFile(
        path.join(root, '.rac/config.toml'),
        '[vendor.codex.raw]\nfeatures = { project = true }\n\n[[packs]]\nid = "shared"\nrepo = "github:owner/repo"\nref = "HEAD"\n',
        'utf8'
      );
      await expect(install({ cwd: root, targets: ['codex'], kinds: ['config'] })).rejects.toThrow('vendor config selector overlap for codex');
    } finally {
      delete process.env.RAC_CACHE_DIR;
    }
  });

  it('uses flat codex rule paths', async () => {
    const root = await makeTmp();
    await seed(root);
    await install({ cwd: root, targets: ['codex'], kinds: ['rule'] });
    await expect(stat(path.join(root, '.codex/rules/wrappers.rules'))).resolves.toBeTruthy();
    await expect(stat(path.join(root, '.codex/rules/wrappers.toml.rules'))).rejects.toThrow();
  });

  it('fails codex install on shared-pack flat rule path collision before writing output', async () => {
    if (spawnSync('git', ['--version']).status !== 0) return;
    const root = await makeTmp();
    const cacheRoot = path.join(root, '.cache');
    process.env.RAC_CACHE_DIR = cacheRoot;
    try {
      const remote = path.join(root, 'remote');
      await mkdir(path.join(remote, '.rac/rules'), { recursive: true });
      await writeFile(path.join(remote, '.rac/config.toml'), '', 'utf8');
      await writeFile(
        path.join(remote, '.rac/rules/wrappers.toml'),
        '[[rule]]\nid = "shared-only-rule"\ndecision = "forbidden"\njustification = "Use wrapper"\ncommand = ["git", "push"]\nappend_wildcard = false\n',
        'utf8'
      );
      spawnSync('git', ['init'], { cwd: remote });
      spawnSync('git', ['add', '.'], { cwd: remote });
      spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: remote });

      await mkdir(path.join(root, '.rac/rules'), { recursive: true });
      await writeFile(
        path.join(root, '.rac/rules/wrappers.toml'),
        '[[rule]]\nid = "project-only-rule"\ndecision = "forbidden"\njustification = "Use wrapper"\ncommand = ["git", "push"]\nappend_wildcard = false\n',
        'utf8'
      );
      await writeFile(path.join(root, '.rac/config.toml'), '[[packs]]\nid = "shared"\nrepo = "github:owner/repo"\nref = "HEAD"\n', 'utf8');

      const key = Buffer.from('github:owner/repo@HEAD').toString('base64url');
      const cachedRepo = path.join(cacheRoot, 'packs', key);
      await mkdir(path.dirname(cachedRepo), { recursive: true });
      spawnSync('git', ['clone', remote, cachedRepo]);

      await expect(install({ cwd: root, targets: ['codex'], kinds: ['rule'] })).rejects.toThrow('codex rule flat-path collision');
      await expect(stat(path.join(root, '.codex/rules/wrappers.rules'))).rejects.toThrow();
    } finally {
      delete process.env.RAC_CACHE_DIR;
    }
  });

  it('rejects planned-output collisions when different content targets same path', async () => {
    const root = await makeTmp();
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await writeFile(path.join(root, '.rac/config.toml'), '', 'utf8');
    await writeFile(path.join(root, '.rac/agents/a.toml'), 'id = "same"\ninstructions = "A"\n', 'utf8');
    await writeFile(path.join(root, '.rac/agents/b.toml'), 'id = "same"\ninstructions = "B"\n', 'utf8');
    await expect(install({ cwd: root, targets: ['claude'], kinds: ['agent'] })).rejects.toThrow();
  });

  it('config-only targets: install uses targets from [install] block when no CLI target given', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.rac/config.toml'), '[install]\ntargets = ["claude"]\n', 'utf8');

    await install({ cwd: root, targets: undefined, kinds: ['agent'] });

    await expect(stat(path.join(root, '.claude/agents/reviewer.md'))).resolves.toBeTruthy();
    await expect(stat(path.join(root, '.codex/agents/reviewer.toml'))).rejects.toThrow();
  });

  it('CLI targets override config targets when both are set', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.rac/config.toml'), '[install]\ntargets = ["claude"]\n', 'utf8');

    await install({ cwd: root, targets: ['codex'], kinds: ['agent'] });

    await expect(stat(path.join(root, '.codex/agents/reviewer.toml'))).resolves.toBeTruthy();
    await expect(stat(path.join(root, '.claude/agents/reviewer.md'))).rejects.toThrow();
  });

  it('default fallback: install uses all three targets when neither CLI nor config sets targets', async () => {
    const root = await makeTmp();
    await seed(root);

    await install({ cwd: root, targets: undefined, kinds: ['agent'] });

    await expect(stat(path.join(root, '.claude/agents/reviewer.md'))).resolves.toBeTruthy();
    await expect(stat(path.join(root, '.codex/agents/reviewer.toml'))).resolves.toBeTruthy();
    await expect(stat(path.join(root, '.opencode/agents/reviewer.md'))).resolves.toBeTruthy();
  });

  it('invalid install.targets value throws a clear error', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.rac/config.toml'), '[install]\ntargets = ["bogus"]\n', 'utf8');

    await expect(install({ cwd: root, targets: undefined, kinds: ['agent'] })).rejects.toThrow('invalid install.targets');
  });

  it('empty-array targets: install produces no output files and result is empty', async () => {
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.rac/config.toml'), '[install]\ntargets = []\n', 'utf8');

    const result = await install({ cwd: root, targets: undefined, kinds: ['agent'] });

    expect(result.create).toHaveLength(0);
    expect(result.update).toHaveLength(0);
    await expect(stat(path.join(root, '.claude/agents/reviewer.md'))).rejects.toThrow();
    await expect(stat(path.join(root, '.codex/agents/reviewer.toml'))).rejects.toThrow();
    await expect(stat(path.join(root, '.opencode/agents/reviewer.md'))).rejects.toThrow();
  });

  it('doctor respects config targets when no CLI target given', async () => {
    // seed creates reviewer.toml with vendor.opencode.tools which triggers opencode_legacy_tools warning.
    // With targets = ["claude"], opencode is excluded so the warning must NOT appear.
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.rac/config.toml'), '[install]\ntargets = ["claude"]\n', 'utf8');

    const warnings = await doctor(root, undefined, ['agent']);

    expect(warnings.some((w) => w.code === 'opencode_legacy_tools')).toBe(false);
  });

  it('doctor CLI targets override config targets', async () => {
    // Config restricts to claude only, but CLI passes opencode explicitly.
    // The opencode_legacy_tools warning from seed's reviewer agent must appear.
    const root = await makeTmp();
    await seed(root);
    await writeFile(path.join(root, '.rac/config.toml'), '[install]\ntargets = ["claude"]\n', 'utf8');

    const warnings = await doctor(root, ['opencode'], ['agent']);

    expect(warnings.some((w) => w.code === 'opencode_legacy_tools')).toBe(true);
  });

  it('result.changes contains InstallChange entries with expected fields', async () => {
    const root = await makeTmp();
    await seed(root);

    const result = await install({ cwd: root, targets: ['codex'], kinds: ['agent'] });

    expect(result.changes.length).toBeGreaterThan(0);
    const change = result.changes[0];
    expect(['create', 'update', 'delete']).toContain(change.action);
    expect(['claude', 'codex', 'opencode']).toContain(change.target);
    expect(['agent', 'skill', 'mcp', 'rule', 'config']).toContain(change.kind);
    expect(typeof change.pack).toBe('string');
    expect(typeof change.id).toBe('string');
    expect(typeof change.relPath).toBe('string');
    expect(typeof change.absPath).toBe('string');
  });

  it('install --dry-run --summary preserves legacy path/count format without @@ hunk markers', async () => {
    const root = await makeTmp();
    await seed(root);

    const result = await runCliInProcess(root, ['install', '--dry-run', '--summary', '--targets', 'claude', '--kind', 'agent', '--plain']);

    expect(result.status).toBe(0);
    // Summary mode: contains the path and action symbol, does NOT contain @@ hunk markers
    expect(result.stdout).not.toContain('@@');
    // Should contain plan summary line
    expect(result.stdout).toMatch(/Plan:.*to create.*\(dry-run\)/);
    // Should contain agent path/action row
    expect(result.stdout).toContain('agent');
    expect(result.stdout).toContain('+');
  });

  it('install --dry-run (no --summary) reroutes through diff renderer with content-level diff', async () => {
    const root = await makeTmp();
    await seed(root);
    // First install agents so we can create an update scenario
    await install({ cwd: root, targets: ['claude'], kinds: ['agent'] });
    // Modify source file to create an update
    await writeFile(path.join(root, '.rac/agents/reviewer.md'), 'Modified review instructions.\n', 'utf8');

    const result = await runCliInProcess(root, ['install', '--dry-run', '--targets', 'claude', '--kind', 'agent', '--plain']);

    expect(result.status).toBe(0);
    // With changes, the diff renderer should output unified diff markers
    expect(result.stdout).toContain('@@');
    // Should contain the (dry-run) label
    expect(result.stdout).toContain('(dry-run)');
  });
});

describe('install: pack override warnings', () => {
  async function makeOverridePack(packDir: string, agentId: string): Promise<void> {
    await mkdir(path.join(packDir, '.rac/agents'), { recursive: true });
    await writeFile(path.join(packDir, '.rac/config.toml'), '', 'utf8');
    await writeFile(
      path.join(packDir, `.rac/agents/${agentId}.toml`),
      `id = "${agentId}"\ninstructions = "./${agentId}.md"\n`,
      'utf8'
    );
    await writeFile(
      path.join(packDir, `.rac/agents/${agentId}.md`),
      `# ${agentId}\nAgent from override pack.\n`,
      'utf8'
    );
  }

  async function setupProjectWithOverride(root: string, packDir: string, packId: string): Promise<void> {
    await mkdir(path.join(root, '.rac/agents'), { recursive: true });
    await writeFile(
      path.join(root, '.rac/config.toml'),
      `[[packs]]\nid = "${packId}"\nrepo = "github:owner/${packId}"\nref = "main"\n`,
      'utf8'
    );
    await writeFile(
      path.join(root, '.rac/config.local.toml'),
      `[[pack_overrides]]\nid = "${packId}"\npath = ${JSON.stringify(packDir)}\n`,
      'utf8'
    );
  }

  it('install --dry-run with override: warns with correct message before diff output, exit 0, git not called', async () => {
    const root = await makeTmp();
    const packDir = await makeTmp();
    await makeOverridePack(packDir, 'override-agent');
    await setupProjectWithOverride(root, packDir, 'mypkg');

    const result = await runCliInProcess(root, ['install', '--dry-run', '--targets', 'claude', '--kind', 'agent', '--plain']);

    expect(result.status).toBe(0);
    // Warning appears before the diff output
    expect(result.stdout).toContain('pack override active: mypkg →');
    expect(result.stdout).toContain(packDir);
    expect(result.stdout).toContain('rac pack override --clear mypkg');
    expect(result.stdout).toContain('before publishing');
    // The warning should appear BEFORE the plan summary line
    const warnIdx = result.stdout.indexOf('pack override active:');
    const planIdx = result.stdout.indexOf('Plan:');
    expect(warnIdx).toBeGreaterThanOrEqual(0);
    expect(planIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeLessThan(planIdx);
    // The agent from the override pack appears in the planned output
    expect(result.stdout).toContain('override-agent');
  });

  it('install (non-dry-run) with override: warning appears before install output, agent is written, exit 0', async () => {
    const root = await makeTmp();
    const packDir = await makeTmp();
    await makeOverridePack(packDir, 'override-agent');
    await setupProjectWithOverride(root, packDir, 'mypkg');

    // Run install via runCliInProcess since it captures stdout
    const result = await runCliInProcess(root, ['install', '--targets', 'claude', '--kind', 'agent', '--plain']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pack override active: mypkg →');
    expect(result.stdout).toContain('rac pack override --clear mypkg');

    // The warning should appear BEFORE the install summary output
    const warnIdx = result.stdout.indexOf('pack override active:');
    const summaryIdx = result.stdout.search(/Installed|Updated|Created|create:|update:/i);
    expect(warnIdx).toBeGreaterThanOrEqual(0);
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeLessThan(summaryIdx);

    // Confirm the agent from the override pack was actually written
    const agentPath = path.join(root, '.claude/agents/override-agent.md');
    await expect(stat(agentPath)).resolves.toBeTruthy();
    const content = await readFile(agentPath, 'utf8');
    expect(content).toContain('Agent from override pack.');
  });

  it('install --check with override: warning appears, exit 0 when up-to-date', async () => {
    const root = await makeTmp();
    const packDir = await makeTmp();
    await makeOverridePack(packDir, 'override-agent');
    await setupProjectWithOverride(root, packDir, 'mypkg');

    // Bring the tree up-to-date first
    const setup = await runCliInProcess(root, ['install', '--targets', 'claude', '--kind', 'agent', '--plain']);
    expect(setup.status).toBe(0);

    const check = await runCliInProcess(root, ['install', '--check', '--targets', 'claude', '--kind', 'agent', '--plain']);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('pack override active: mypkg →');
    expect(check.stdout).toContain('rac pack override --clear mypkg');
  });

  it('install with no overrides: no override warning in output', async () => {
    const root = await makeTmp();
    await seed(root);

    const result = await runCliInProcess(root, ['install', '--dry-run', '--targets', 'claude', '--kind', 'agent', '--plain']);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('pack override active:');
    expect(result.stdout).not.toContain('pack_override_active');
  });

  it('install with override: warning severity badge WARN appears in output', async () => {
    const root = await makeTmp();
    const packDir = await makeTmp();
    await makeOverridePack(packDir, 'override-agent');
    await setupProjectWithOverride(root, packDir, 'mypkg');

    const result = await runCliInProcess(root, ['install', '--dry-run', '--targets', 'claude', '--kind', 'agent', '--plain']);

    expect(result.status).toBe(0);
    // plain mode: badge renders as 'WARN '
    expect(result.stdout).toContain('WARN ');
  });
});
