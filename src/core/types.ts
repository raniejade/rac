export type Pack = string;
export type Target = 'claude' | 'codex' | 'opencode';
export type Kind = 'agent' | 'skill' | 'mcp' | 'rule' | 'config';
export type Scope = 'project' | 'user';

export type AgentDef = {
  pack: Pack;
  packRoot: string;
  id: string;
  name?: string;
  description?: string;
  instructions: string;
  instructionsIsTemplate?: boolean;
  tools?: string[];
  vendor?: Record<string, unknown>;
  sourcePath: string;
  sourceName: string;
};

export type SkillDef = {
  pack: Pack;
  packRoot: string;
  id: string;
  name?: string;
  description: string;
  body: string;
  bodyIsTemplate?: boolean;
  frontmatter: Record<string, unknown>;
  assets: string[];
  sourcePath: string;
  sourceName: string;
};

export type McpDef = {
  pack: Pack;
  packRoot: string;
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
  packRoot: string;
  id: string;
  decision: 'forbidden';
  justification: string;
  command: RuleCommandItem[];
  append_wildcard: boolean;
  sourcePath: string;
  sourceName: string;
};

export type VendorConfigSource = 'config' | 'raw' | 'raw_json';

export type VendorConfigDef = {
  pack: Pack;
  packRoot: string;
  target: Target;
  values: Record<string, unknown>;
  selectors: string[];
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
  entries?: string[];
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
  refreshPacks?: boolean;
  cwd: string;
  scope?: Scope;
  noMerge?: boolean;
};

export type InstallResult = {
  create: string[];
  update: string[];
  del: string[];
};

export type PackSpec = {
  id: string;
  repo: string;
  ref: string;
};

export type PackRuntime = {
  id: string;
  root: string;
  sourceRepo?: string;
  sourceRef?: string;
};
