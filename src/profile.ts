import { readFile } from "node:fs/promises";
import { matchesGlob } from "node:path";
import { parse } from "yaml";
import type { Finding, Severity } from "./findings.js";

export interface SuppressEntry {
  rule: string; // "engine/RULE"
  paths?: string[];
  reason: string;
}

export interface EngineProfile {
  paths?: string[];
  severityFloor?: Severity;
  /** engine-specific rule packs: semgrep config files, ast-grep sgconfig */
  rules?: string[];
  /** semgrep: false disables registry (p/) rulesets — fully offline with local packs only */
  registry?: boolean;
  /** jscpd: repo-wide globs forming the duplication corpus; enables the engine */
  corpus?: string[];
  /** jscpd: duplication threshold (default 50) */
  minTokens?: number;
}

export interface CustomEngineDef {
  id: string;
  /** argv; selected files are appended; SARIF 2.1.0 expected on stdout */
  command: string[];
  files: string[];
}

export interface ReviewConfig {
  /** false = Leveret stays out of this repository's PRs (a notice is posted once) */
  enabled: boolean;
  /** regex; a matching PR title opts that PR out */
  skipTitle?: string;
}

export interface Profile {
  engines: Record<string, EngineProfile>;
  suppress: SuppressEntry[];
  custom: CustomEngineDef[];
  /** surface pre-existing findings adjacent to changed lines (default true);
   * false is the explicit "don't remind me" instruction */
  reminders: boolean;
  review: ReviewConfig;
}

export interface Suppression {
  rule: string;
  count: number;
  reason: string;
}

const EMPTY: Profile = { engines: {}, suppress: [], custom: [], reminders: true, review: { enabled: true } };
const SEV_ORDER: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

export async function loadProfile(path: string): Promise<Profile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return EMPTY;
  }
  const doc = (parse(raw) ?? {}) as {
    engines?: Record<string, EngineProfile>;
    suppress?: Partial<SuppressEntry>[];
    custom?: Partial<CustomEngineDef>[];
    reminders?: boolean;
    review?: { enabled?: boolean; skipTitle?: string };
  };
  const suppress = (doc.suppress ?? []).map((s) => {
    if (!s.rule) throw new Error(`profile ${path}: suppress entry missing rule`);
    // A reasonless suppression is unauditable pricing; refuse it loudly.
    if (!s.reason) throw new Error(`profile ${path}: suppress ${s.rule} missing reason`);
    return { rule: s.rule, paths: s.paths, reason: s.reason };
  });
  const custom = (doc.custom ?? []).map((c) => {
    if (!c.id || !c.command?.length || !c.files?.length) {
      throw new Error(`profile ${path}: custom engine needs id, command and files`);
    }
    return { id: c.id, command: c.command, files: c.files };
  });
  return {
    engines: doc.engines ?? {},
    suppress,
    custom,
    reminders: doc.reminders !== false,
    review: { enabled: doc.review?.enabled !== false, skipTitle: doc.review?.skipTitle },
  };
}

/** Pre-run scope filter: files an engine may see under this profile. */
export function scopeFiles(profile: Profile, engineId: string, files: string[]): string[] {
  const paths = profile.engines[engineId]?.paths;
  if (!paths) return files;
  return files.filter((f) => paths.some((g) => matchesGlob(f, g)));
}

/** Post-run filter: drop suppressed/below-floor findings, tally what was dropped. */
export function filterFindings(
  profile: Profile,
  findings: Finding[],
): { kept: Finding[]; suppressed: Suppression[] } {
  const kept: Finding[] = [];
  const tally = new Map<string, Suppression>();
  const drop = (key: string, reason: string) => {
    const t = tally.get(key) ?? { rule: key, count: 0, reason };
    t.count += 1;
    tally.set(key, t);
  };
  for (const f of findings) {
    const key = `${f.engine}/${f.rule}`;
    const entry = profile.suppress.find(
      (s) =>
        (s.rule === key || s.rule === `${f.engine}/*`) &&
        (!s.paths || s.paths.some((g) => matchesGlob(f.file, g))),
    );
    if (entry) {
      drop(entry.rule === key ? key : entry.rule, entry.reason);
      continue;
    }
    const floor = profile.engines[f.engine]?.severityFloor;
    if (floor && SEV_ORDER[f.severity] < SEV_ORDER[floor]) {
      drop(key, `below ${f.engine} severity floor (${floor})`);
      continue;
    }
    kept.push(f);
  }
  return { kept, suppressed: [...tally.values()].sort((a, b) => a.rule.localeCompare(b.rule)) };
}
