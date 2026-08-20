import { readFile } from "node:fs/promises";
import { matchesGlob } from "node:path";
import { parse } from "yaml";
import type { Finding, Severity } from "./findings.js";

export interface SuppressEntry {
  rule: string; // "engine/RULE"
  paths?: string[];
  reason: string;
}

export interface Profile {
  engines: Record<string, { paths?: string[]; severityFloor?: Severity }>;
  suppress: SuppressEntry[];
}

export interface Suppression {
  rule: string;
  count: number;
  reason: string;
}

const EMPTY: Profile = { engines: {}, suppress: [] };
const SEV_ORDER: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

export async function loadProfile(path: string): Promise<Profile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return EMPTY;
  }
  const doc = (parse(raw) ?? {}) as {
    engines?: Record<string, { paths?: string[]; severityFloor?: Severity }>;
    suppress?: Partial<SuppressEntry>[];
  };
  const suppress = (doc.suppress ?? []).map((s) => {
    if (!s.rule) throw new Error(`profile ${path}: suppress entry missing rule`);
    // A reasonless suppression is unauditable pricing; refuse it loudly.
    if (!s.reason) throw new Error(`profile ${path}: suppress ${s.rule} missing reason`);
    return { rule: s.rule, paths: s.paths, reason: s.reason };
  });
  return { engines: doc.engines ?? {}, suppress };
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
