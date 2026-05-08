/* global process */
import { assert, spawnCapture } from './lib.mjs';

export async function checkClaudeProject(sampleRepo) {
  const claudeMcpList = await spawnCapture('claude', ['mcp', 'list'], sampleRepo);
  assert(claudeMcpList.code === 0, `Claude MCP discovery (project-scope) failed with code ${claudeMcpList.code}\nstdout:\n${claudeMcpList.stdout}\nstderr:\n${claudeMcpList.stderr}`);
  assert(/project-rules/.test(`${claudeMcpList.stdout}\n${claudeMcpList.stderr}`), 'Claude MCP discovery (project-scope) output missing project-rules');

  const claudeAgents = await spawnCapture('claude', ['agents', '--setting-sources', 'project'], sampleRepo);
  assert(claudeAgents.code === 0, `Claude agents discovery failed with code ${claudeAgents.code}\nstdout:\n${claudeAgents.stdout}\nstderr:\n${claudeAgents.stderr}`);
  assert(/reviewer/.test(`${claudeAgents.stdout}\n${claudeAgents.stderr}`), 'Claude agents output missing reviewer project agent');
  // Claude CLI has no stable project skills list/load command in this harness.
}

export async function checkClaudeUser({ userHome, cwd }) {
  const env = { ...process.env, HOME: userHome };
  const mcpList = await spawnCapture('claude', ['mcp', 'list'], cwd, env);
  assert(mcpList.code === 0, `Claude MCP discovery (user-scope) failed with code ${mcpList.code}\nstdout:\n${mcpList.stdout}\nstderr:\n${mcpList.stderr}`);
  assert(/project-rules/.test(`${mcpList.stdout}\n${mcpList.stderr}`), 'Claude MCP discovery (user-scope) output missing project-rules');
}
