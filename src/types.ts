export type ChangeCategory =
  | "RISK_ADDED"     // removed null check, error handling, shortened timeout
  | "RISK_REMOVED"   // added null check, added error handling
  | "API_CHANGED"    // function signature changed (potential breaking)
  | "LOGIC_CHANGED"  // conditional branches, return value changed
  | "BEHAVIOR_NEW"   // new code paths added
  | "REFACTOR"       // structural change, equivalent behavior
  | "DEAD_CODE"      // code made unreachable
  | "DEPENDENCY"     // import added/removed
  | "CONFIG";        // constants / config values changed

export type RiskLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface SemanticChange {
  category: ChangeCategory;
  risk: RiskLevel;
  location: string;       // "FunctionName @ file.ts:42"
  description: string;    // human-readable description
  before?: string;        // snippet of old behavior
  after?: string;         // snippet of new behavior
}

export interface FileDiffResult {
  file: string;
  added: number;
  removed: number;
  changes: SemanticChange[];
  overallRisk: RiskLevel;
  rawPatch?: string;
}

export interface DiffReport {
  fromRef: string;
  toRef: string;
  files: FileDiffResult[];
  totalChanges: number;
  riskSummary: Record<RiskLevel, number>;
  aiNarrative?: string;
}
