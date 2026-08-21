import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, matchesGlob } from "node:path";
import type { Finding } from "./findings.js";

// Repo-scope verdict store: .leveret/memory.jsonl in the reviewed repo, one entry
// per graded finding class (DESIGN.md "Memory design"). Only drops are stored —
// "actionable" is a report, not a memory.

export type MemoryGrade = "priced-noise" | "false-positive";

export interface MemoryEntry {
  /** absent = fingerprint entry (mechanical suppression); "convention" = human-taught
   * teaching text, injected into the agent prompts, never matched mechanically */
  kind?: "convention";
  /** fingerprint entries: engine/RULE/path-or-glob */
  fp?: string;
  grade?: MemoryGrade;
  reason?: string;
  /** convention entries: the ruling itself, in the human's words */
  text?: string;
  /** convention entries: optional path globs bounding where the ruling applies */
  scope?: string[];
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
  const entries: MemoryEntry[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim()) continue;
    let e: MemoryEntry;
    try {
      e = JSON.parse(lines[i]!) as MemoryEntry;
    } catch (err) {
      // The file is versioned by design, so merge-conflict markers are the
      // realistic corruption; fail loud but diagnosable, never a bare SyntaxError.
      throw new Error(`${memPath(opts.repo)}:${i + 1}: malformed memory entry (${String(err).slice(0, 80)})`);
    }
    if (e.fp && applied[e.fp]) e.lastApplied = applied[e.fp];
    entries.push(e);
  }
  return entries;
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
  // A half-specified anchor must not silently widen an instance verdict into a
  // class-wide suppression: demand both halves or neither.
  if (Boolean(opts.anchorFile) !== (opts.anchorLine !== undefined)) {
    throw new Error("anchor needs BOTH anchorFile and anchorLine (or neither)");
  }
  if (opts.anchorLine !== undefined && opts.anchorLine < 1) {
    throw new Error(`anchorLine must be >= 1, got ${opts.anchorLine}`);
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

/** Persist a human-taught convention: fingerprint-free teaching text sourced from
 * feedback (a reply on a finding, an explicit instruction). Injected into the agent
 * prompts, where it can both suppress and RAISE findings; never applied
 * mechanically, never GC'd — a human retires it by deleting the line. */
export async function learn(opts: {
  repo: string;
  text: string;
  author: string;
  scope?: string[];
}): Promise<MemoryEntry> {
  if (!opts.text) throw new Error("a convention needs text");
  if (!opts.author) throw new Error("a convention needs an author — anonymous teaching is unauditable");
  const entry: MemoryEntry = {
    kind: "convention",
    text: opts.text,
    ...(opts.scope?.length ? { scope: opts.scope } : {}),
    author: opts.author,
    created: new Date().toISOString().slice(0, 10),
  };
  await ensureStore(opts.repo);
  await appendFile(memPath(opts.repo), `${JSON.stringify(entry)}\n`);
  return entry;
}

/** The rulings block injected into served agent contracts: conventions verbatim
 * plus fingerprint reasons — the repo's accumulated case law, LLM-generalizable. */
export async function rulingsText(repo: string): Promise<string> {
  const entries = await memoryList({ repo });
  if (entries.length === 0) return "No recorded rulings for this repository yet.";
  const lines: string[] = [];
  for (const e of entries) {
    if (e.kind === "convention") {
      lines.push(
        `- ${e.text}${e.scope ? ` [scope: ${e.scope.join(", ")}]` : ""} (taught by ${e.author ?? "unknown"}) [${e.created}]`,
      );
    } else if (e.fp) {
      lines.push(`- [${e.grade}] ${e.fp}: ${e.reason} (${e.author ?? "verifier"}, ${e.created})`);
    }
  }
  return lines.join("\n");
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
      // conventions are for the agents, not mechanical layer-2 suppression
      if (e.kind === "convention" || !e.fp) continue;
      if (!fpMatches(e.fp, f)) continue;
      if (e.anchor) {
        const text = await lineAt(repo, f.file, f.line);
        // Changed or vanished line: the pricing anchored to code that no longer
        // exists — the memory is dead for this finding, fall through to layer 3.
        if (text === null || hashLine(text) !== e.anchor) continue;
      }
      const t = tally.get(e.fp) ?? { rule: e.fp, count: 0, reason: e.reason ?? "" };
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
    for (const e of applied) if (e.fp) stamps[e.fp] = today;
    await ensureStore(repo);
    // tmp + rename: a crash mid-write must not leave a torn file that the next
    // reader silently resets to {} (ponytail: still last-writer-wins between
    // concurrent scans; per-repo locking if that ever bites)
    const tmp = `${appliedPath(repo)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(tmp, `${JSON.stringify(stamps, null, 1)}\n`);
    await rename(tmp, appliedPath(repo));
  }
  return { kept, suppressed: [...tally.values()] };
}
