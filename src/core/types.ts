export type Pack = 'project';
export type Target = 'claude' | 'codex' | 'opencode';
export type Kind = 'agent' | 'skill' | 'mcp' | 'rule';

export type AgentDef = {
  pack: Pack;
  id: string;
  name?: string;
  description?: string;
  instructions: string;
  tools?: string[];
  vendor?: Record<string, unknown>;
  sourcePath: string;
  sourceName: string;
};

export type SkillDef = {
  pack: Pack;
  id: string;
  name?: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
  assets: string[];
  sourcePath: string;
  sourceName: string;
};

export type McpDef = {
  pack: Pack;
  id: string;
  command?: string;
  args?: string[];
  type?: string;
  url?: string;
  startup_timeout_ms?: number;
  vendor?: Record<string, unknown>;
  envVars: string[];
  sourcePath: string;
  sourceName: string;
};

export type RuleCommandItem = string | string[];

export type RuleDef = {
  pack: Pack;
  id: string;
  decision: 'forbidden';
  justification: string;
  command: RuleCommandItem[];
  append_wildcard: boolean;
  sourcePath: string;
  sourceName: string;
};

export type ManifestRecord = {
  version: 1;
  pack: Pack;
  target: Target;
  kind: Kind;
  id: string;
  source: string;
  relPath: string;
  hash: string;
  inventory: ManagedInventoryEntry[];
};

export type ManagedInventoryEntry = {
  version: 1;
  format: 'file' | 'json' | 'toml' | 'markdown';
  selector: string;
};

export type InstallManifest = {
  version: 1;
  records: ManifestRecord[];
};

export type InstallOptions = {
  targets: Target[];
  kinds: Kind[];
  dryRun?: boolean;
  clean?: boolean;
  check?: boolean;
  force?: boolean;
  cwd: string;
};

export type InstallResult = {
  create: string[];
  update: string[];
  del: string[];
};
