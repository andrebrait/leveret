export type Severity = "error" | "warning" | "info";

export interface Finding {
  engine: string;
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  endLine?: number;
  message: string;
  snippet?: string;
  /** set when a base ref is available: did the change introduce this finding? */
  provenance?: "introduced" | "pre-existing";
}

export type EngineStatus =
  | "findings"
  | "clean"
  | "filtered" // the engine found things, but every one was dropped by delta/profile/memory
  | "not-applicable"
  | "missing"
  | "error";

export interface EngineReport {
  engine: string;
  status: EngineStatus;
  detail?: string;
  /** raw findings the engine produced, before any filter layer */
  found?: number;
  /** findings surviving delta + profile + memory — what the result actually shows */
  kept?: number;
}

export interface ScanResult {
  findings: Finding[];
  engines: EngineReport[];
  /** profile-dropped findings, tallied per rule with the profile's reason — never silent */
  suppressed: { rule: string; count: number; reason: string }[];
  /** findings already present at the base tree, dropped by the delta scan */
  preExisting: number;
}
