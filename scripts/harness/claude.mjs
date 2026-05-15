/* global process */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assert, spawnCapture } from './lib.mjs';

function parseManagedMarkdown(raw) {
  const normalized = raw.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n(<!-- DO NOT EDIT; managed by rac -->)\n([\s\S]*)$/);
  assert(match, 'Claude reviewer agent markdown does not match managed frontmatter format');

  const frontmatter = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+):\s+"([\s\S]*)"$/);
    assert(kv, `Claude reviewer agent frontmatter has invalid line: ${line}`);
    frontmatter[kv[1]] = kv[2];
  }

  return {
    frontmatter,
    managedMarker: match[2],
    body: match[3]
  };
}

export async function checkClaudeProject(sampleRepo) {
  const claudeMcpList = await spawnCapture('claude', ['mcp', 'list'], sampleRepo);
  assert(claudeMcpList.code === 0, `Claude MCP discovery (project-scope) failed with code ${claudeMcpList.code}\nstdout:\n${claudeMcpList.stdout}\nstderr:\n${claudeMcpList.stderr}`);
  assert(/project-rules/.test(`${claudeMcpList.stdout}\n${claudeMcpList.stderr}`), 'Claude MCP discovery (project-scope) output missing project-rules');

  const mcpJson = JSON.parse(await readFile(path.join(sampleRepo, '.mcp.json'), 'utf8'));
  assert(mcpJson.mcpServers['project-rules'].env.LOG_LEVEL === 'info', 'Claude project .mcp.json missing project-rules env.LOG_LEVEL');
  assert(mcpJson.mcpServers['project-rules'].env.PROJECT_RULES_TOKEN === '${PROJECT_RULES_TOKEN}', 'Claude project .mcp.json missing project-rules env.PROJECT_RULES_TOKEN');

  // We used to call `claude agents --setting-sources project` here, but Claude Code changed
  // `claude agents` into Agent View/background-session management. RAC owns the generated
  // `.claude/agents/*.md` file contract, so this harness verifies that stable output directly.
  const reviewerRaw = await readFile(path.join(sampleRepo, '.claude', 'agents', 'reviewer.md'), 'utf8');
  const reviewerActual = parseManagedMarkdown(reviewerRaw);
  const reviewerExpected = {
    frontmatter: {
      name: 'reviewer',
      description: 'Checks project rules and required gates'
    },
    managedMarker: '<!-- DO NOT EDIT; managed by rac -->',
    body: '# Reviewer Agent\n\nReview planned changes against project rules and required gates.\nBlock merges when required checks fail.\n'
  };
  assert(
    JSON.stringify(reviewerActual) === JSON.stringify(reviewerExpected),
    `Claude reviewer agent content mismatch.\nexpected:\n${JSON.stringify(reviewerExpected, null, 2)}\nactual:\n${JSON.stringify(reviewerActual, null, 2)}`
  );
}

export async function checkClaudeUser({ userHome, cwd }) {
  const env = { ...process.env, HOME: userHome };
  const mcpList = await spawnCapture('claude', ['mcp', 'list'], cwd, env);
  assert(mcpList.code === 0, `Claude MCP discovery (user-scope) failed with code ${mcpList.code}\nstdout:\n${mcpList.stdout}\nstderr:\n${mcpList.stderr}`);
  assert(/project-rules/.test(`${mcpList.stdout}\n${mcpList.stderr}`), 'Claude MCP discovery (user-scope) output missing project-rules');

  const claudeJson = JSON.parse(await readFile(path.join(userHome, '.claude.json'), 'utf8'));
  assert(claudeJson.mcpServers['project-rules'].env.LOG_LEVEL === 'info', 'Claude user .claude.json missing project-rules env.LOG_LEVEL');
  assert(claudeJson.mcpServers['project-rules'].env.PROJECT_RULES_TOKEN === '${PROJECT_RULES_TOKEN}', 'Claude user .claude.json missing project-rules env.PROJECT_RULES_TOKEN');
}
