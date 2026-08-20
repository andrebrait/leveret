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
}

export type EngineStatus = "findings" | "clean" | "not-applicable" | "missing" | "error";

export interface EngineReport {
  engine: string;
  status: EngineStatus;
  detail?: string;
}

export interface ScanResult {
  findings: Finding[];
  engines: EngineReport[];
}
