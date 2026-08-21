import type { Finding, ScanResult } from "../findings.js";

// Rendering the verify output + scan result into the published review: tier-grouped
// inline comments and the what-was-checked walkthrough. Pure functions — the App's
// GitHub calls stay thin and untestworthy.

export type Tier = "critical" | "major" | "minor" | "nit";

export interface ReportItem {
  id: string;
  file: string;
  line: number;
  title: string;
  tier: Tier;
  severity: string;
  scope?: "in-diff" | "out-of-diff";
  correlation?: string;
  evidence: string;
  suggested_fix?: string;
}

export interface VerifyOutput {
  report: ReportItem[];
  verdicts: { id: string; grade: string; reason?: string }[];
  coverage: {
    lenses: { lens: string; outcome: string }[];
    files: { file: string; verdict: string; note?: string }[];
  };
}

const TIER_ORDER: Record<Tier, number> = { critical: 0, major: 1, minor: 2, nit: 3 };
const byTier = (a: ReportItem, b: ReportItem) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier];

export function renderWalkthrough(v: VerifyOutput, scan: ScanResult): string {
  const all = [...v.report].sort(byTier);
  const outOfDiff = all.filter((r) => r.scope === "out-of-diff");
  const s: string[] = ["## leveret review", ""];

  if (all.length === 0) {
    s.push("No actionable findings.", "");
  } else {
    s.push("### Findings", "");
    for (const r of all) {
      const marker = r.scope === "out-of-diff" ? " *(out-of-diff)*" : "";
      s.push(`- **[${r.tier}]** \`${r.file}:${r.line}\` — ${r.title}${marker}`);
    }
    s.push("");
  }

  if (outOfDiff.length > 0) {
    s.push(
      "### Out-of-diff findings",
      "",
      "Correlated defects in code this change does not touch (GitHub cannot attach these inline):",
      "",
    );
    for (const r of outOfDiff) {
      s.push(`- **[${r.tier}]** \`${r.file}:${r.line}\` — ${r.title}`);
      s.push(`  - correlation: ${r.correlation ?? "unstated"}`);
      s.push(`  - evidence: ${r.evidence}`);
    }
    s.push("");
  }

  if (scan.reminders.length > 0) {
    s.push(
      "### Reminders (pre-existing, adjacent to this change)",
      "",
      ...scan.reminders.map(
        (f: Finding) => `- \`${f.file}:${f.line}\` ${f.engine}/${f.rule} — ${f.message}`,
      ),
      "",
    );
  }

  s.push("### What was checked", "", "| lens | outcome |", "| --- | --- |");
  for (const l of v.coverage.lenses) s.push(`| ${l.lens} | ${l.outcome} |`);
  s.push("", "| file | verdict |", "| --- | --- |");
  for (const f of v.coverage.files) {
    s.push(`| \`${f.file}\` | ${f.verdict}${f.note ? ` — ${f.note}` : ""} |`);
  }

  s.push("", "### Engines", "", "| engine | status | found | kept |", "| --- | --- | --- | --- |");
  for (const e of scan.engines) {
    s.push(`| ${e.engine} | ${e.status} | ${e.found ?? "—"} | ${e.kept ?? "—"} |`);
  }

  const drops: string[] = [];
  for (const sup of scan.suppressed) drops.push(`- ${sup.rule}: ${sup.count} (${sup.reason})`);
  if (scan.preExisting > 0) drops.push(`- ${scan.preExisting} pre-existing (delta)`);
  for (const verdict of v.verdicts) {
    if (verdict.grade === "actionable") continue;
    drops.push(`- ${verdict.id}: ${verdict.grade}${verdict.reason ? ` (${verdict.reason})` : ""}`);
  }
  if (drops.length > 0) {
    s.push("", "### Examined and dropped (nothing is silent)", "", ...drops);
  }
  if (scan.baseErrors.length > 0) {
    s.push(
      "",
      "### Base-pass warnings",
      "",
      ...scan.baseErrors.map((e) => `- ${e.engine}: ${e.status}${e.detail ? ` — ${e.detail}` : ""}`),
    );
  }
  return s.join("\n");
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

/** In-diff findings become inline review comments; out-of-diff cannot anchor to
 * the diff and live in the walkthrough instead. */
export function renderInline(v: VerifyOutput): InlineComment[] {
  return v.report
    .filter((r) => r.scope !== "out-of-diff")
    .sort(byTier)
    .map((r) => ({
      path: r.file,
      line: r.line,
      body: [
        `**[${r.tier}]** ${r.title}`,
        "",
        `evidence: ${r.evidence}`,
        ...(r.suggested_fix ? ["", `suggested fix: ${r.suggested_fix}`] : []),
      ].join("\n"),
    }));
}
