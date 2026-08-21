import type { Finding, Severity } from "./findings.js";

// Minimal SARIF 2.1.0 reader: one adapter unlocks every SARIF-emitting tool
// (hadolint, trivy, checkov, psalm, CodeQL, ...) with zero per-tool code.

const LEVEL: Record<string, Severity> = { error: "error", warning: "warning", note: "info", none: "info" };

export function parseSarif(engine: string, raw: string): Finding[] {
  const doc = JSON.parse(raw) as {
    runs?: {
      results?: {
        ruleId?: string;
        level?: string;
        message?: { text?: string };
        locations?: {
          physicalLocation?: {
            artifactLocation?: { uri?: string };
            region?: { startLine?: number; endLine?: number };
          };
        }[];
      }[];
    }[];
  };
  const findings: Finding[] = [];
  for (const run of doc.runs ?? []) {
    for (const r of run.results ?? []) {
      const loc = r.locations?.[0]?.physicalLocation;
      const rawUri = (loc?.artifactLocation?.uri ?? "").replace(/^file:\/\//, "");
      let file = rawUri;
      try {
        file = decodeURIComponent(rawUri); // spec-conformant producers percent-encode
      } catch {
        /* malformed escape: keep the raw string rather than dropping the finding */
      }
      findings.push({
        engine,
        rule: r.ruleId ?? engine,
        severity: LEVEL[r.level ?? ""] ?? "warning",
        file,
        line: loc?.region?.startLine ?? 1,
        endLine: loc?.region?.endLine,
        message: r.message?.text ?? r.ruleId ?? engine,
      });
    }
  }
  return findings;
}
