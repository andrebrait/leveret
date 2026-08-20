import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, matchesGlob } from "node:path";
import type { Finding } from "./findings.js";

// Repo-scope verdict store: .leveret/memory.jsonl in the reviewed repo, one entry
// per graded finding class (DESIGN.md "Memory design"). Only drops are stored —
// "actionable" is a report, not a memory.

export type MemoryGrade = "priced-noise" | "false-positive";

export interface MemoryEntry {
  fp: string; // engine/RULE/path-or-glob
  grade: MemoryGrade;
  reason: string;
  /** sha256 of the trimmed anchored source line; entry applies only while a
   * matching finding's own line still hashes to this. Absent = class-wide. */
  anchor?: string;
  author?: string;
  created: string;
  lastApplied?: string;
}

const memPath = (repo: string) => join(repo, ".leveret", "memory.jsonl");
// Hygiene stamps live OUTSIDE the versioned verdict file: rewriting memory.jsonl on
// every scan would churn a committed file with bookkeeping. applied.json is
// regenerable bookkeeping — gitignore it.
const appliedPath = (repo: string) => join(repo, ".leveret", "applied.json");

// The store dir ships its own .gitignore: verdicts (memory.jsonl) are versioned,
// the regenerable hygiene sidecar never is. Created once, not overwritten — a repo
// may extend it.
async function ensureStore(repo: string): Promise<void> {
  const dir = dirname(memPath(repo));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitignore"), "applied.json\n", { flag: "wx" }).catch(() => {});
}

async function readApplied(repo: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(appliedPath(repo), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

const hashLine = (text: string) => createHash("sha256").update(text.trim()).digest("hex");

async function lineAt(repo: string, file: string, line: number): Promise<string | null> {
  try {
    const lines = (await readFile(join(repo, file), "utf8")).split("\n");
    return lines[line - 1] ?? null;
  } catch {
    return null;
  }
}

export async function memoryList(opts: { repo: string }): Promise<MemoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(memPath(opts.repo), "utf8");
  } catch {
    return [];
  }
  const applied = await readApplied(opts.repo);
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const e = JSON.parse(l) as MemoryEntry;
      if (applied[e.fp]) e.lastApplied = applied[e.fp];
      return e;
    });
}

export async function remember(opts: {
  repo: string;
  fp: string;
  grade: MemoryGrade;
  reason: string;
  author?: string;
  anchorFile?: string;
  anchorLine?: number;
}): Promise<MemoryEntry> {
  if (opts.grade !== "priced-noise" && opts.grade !== "false-positive") {
    throw new Error(`memory grade must be priced-noise or false-positive, got: ${opts.grade}`);
  }
  if (!opts.reason) throw new Error("memory entry needs a reason");
  if (opts.fp.split("/").length < 3) {
    throw new Error(`fp must be engine/RULE/path-or-glob, got: ${opts.fp}`);
  }
  let anchor: string | undefined;
  if (opts.anchorFile && opts.anchorLine) {
    const text = await lineAt(opts.repo, opts.anchorFile, opts.anchorLine);
    if (text === null) {
      throw new Error(`anchor ${opts.anchorFile}:${opts.anchorLine} is unreadable`);
    }
    anchor = hashLine(text);
  }
  const entry: MemoryEntry = {
    fp: opts.fp,
    grade: opts.grade,
    reason: opts.reason,
    ...(anchor ? { anchor } : {}),
    ...(opts.author ? { author: opts.author } : {}),
    created: new Date().toISOString().slice(0, 10),
  };
  await ensureStore(opts.repo);
  await appendFile(memPath(opts.repo), `${JSON.stringify(entry)}\n`);
  return entry;
}

function fpMatches(fp: string, f: Finding): boolean {
  const [engine, rule, ...rest] = fp.split("/");
  const glob = rest.join("/");
  return (
    engine === f.engine &&
    (rule === f.rule || rule === "*") &&
    (glob === f.file || matchesGlob(f.file, glob))
  );
}

/** Drop findings covered by live memories; tally per fp; stamp lastApplied. */
export async function applyMemory(
  repo: string,
  findings: Finding[],
): Promise<{ kept: Finding[]; suppressed: { rule: string; count: number; reason: string }[] }> {
  const entries = await memoryList({ repo });
  if (entries.length === 0) return { kept: findings, suppressed: [] };
  const kept: Finding[] = [];
  const tally = new Map<string, { rule: string; count: number; reason: string }>();
  const applied = new Set<MemoryEntry>();
  for (const f of findings) {
    let dropped = false;
    for (const e of entries) {
      if (!fpMatches(e.fp, f)) continue;
      if (e.anchor) {
        const text = await lineAt(repo, f.file, f.line);
        // Changed or vanished line: the pricing anchored to code that no longer
        // exists — the memory is dead for this finding, fall through to layer 3.
        if (text === null || hashLine(text) !== e.anchor) continue;
      }
      const t = tally.get(e.fp) ?? { rule: e.fp, count: 0, reason: e.reason };
      t.count += 1;
      tally.set(e.fp, t);
      applied.add(e);
      dropped = true;
      break;
    }
    if (!dropped) kept.push(f);
  }
  if (applied.size > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const stamps = await readApplied(repo);
    for (const e of applied) stamps[e.fp] = today;
    await ensureStore(repo);
    await writeFile(appliedPath(repo), `${JSON.stringify(stamps, null, 1)}\n`);
  }
  return { kept, suppressed: [...tally.values()] };
}
