#!/usr/bin/env node
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { scan } from "../scan.js";
import type { Finding, ScanResult } from "../findings.js";
import { makeApp, postReview } from "./github.js";
import { renderInline, renderWalkthrough, type Tier, type VerifyOutput } from "./render.js";
import { routeEvent, verifySignature, type Job } from "./webhook.js";

// The App layer: GitHub plumbing only. It holds the App key and webhook secret —
// never a model credential. The BYOAI seam is LEVERET_RUNNER: a user-supplied
// command (their agent, their provider, their hardware) that turns scan leads into
// a verified report. Without one, reviews run deterministic-only.

const exec = promisify(execFile);

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
};

const DATA_DIR = process.env.LEVERET_DATA ?? join(homedir(), ".leveret-app");

/** deterministic-only fallback: engine findings become the report directly */
function reportFromScan(result: ScanResult): VerifyOutput {
  const tier = (f: Finding): Tier =>
    f.severity === "error" ? "major" : f.severity === "warning" ? "minor" : "nit";
  return {
    report: result.findings.map((f, i) => ({
      id: `D${i + 1}`,
      file: f.file,
      line: f.line,
      title: `${f.engine}/${f.rule}: ${f.message}`,
      tier: tier(f),
      severity: f.severity,
      scope: "in-diff",
      evidence: `reported by ${f.engine} (deterministic pass; no runner configured)`,
    })),
    verdicts: result.findings.map((_, i) => ({ id: `D${i + 1}`, grade: "actionable" })),
    coverage: {
      lenses: [
        {
          lens: "deterministic-engines",
          outcome: `${result.findings.length} finding(s); agent lenses NOT run (no LEVERET_RUNNER)`,
        },
      ],
      files: [],
    },
  };
}

async function reviewJob(job: Extract<Job, { kind: "review" }>): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "leveret-app-"));
  try {
    await exec("git", ["clone", "--quiet", job.cloneUrl, work]);
    await exec("git", ["fetch", "--quiet", "origin", `pull/${job.pr}/head`], { cwd: work });
    await exec("git", ["checkout", "--quiet", job.headSha], { cwd: work });
    const base = `origin/${job.baseRef}`;
    const result = await scan({ repo: work, base });

    let verify: VerifyOutput;
    if (process.env.LEVERET_RUNNER) {
      const leadsPath = join(work, ".leveret-leads.json");
      await writeFile(leadsPath, JSON.stringify(result, null, 1));
      const [cmd, ...args] = process.env.LEVERET_RUNNER.split(" ") as [string, ...string[]];
      const r = await exec(cmd, args, {
        cwd: work,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, LEVERET_REPO: work, LEVERET_BASE: base, LEVERET_LEADS: leadsPath },
      });
      verify = JSON.parse(r.stdout) as VerifyOutput;
    } else {
      verify = reportFromScan(result);
    }

    if (job.installationId) {
      const app = makeApp({
        appId: env("LEVERET_APP_ID"),
        privateKey: await readFile(env("LEVERET_PRIVATE_KEY_PATH"), "utf8"),
      });
      await postReview(
        app,
        job.installationId,
        job.repo,
        job.pr,
        job.headSha,
        renderWalkthrough(verify, result),
        renderInline(verify),
      );
    } else {
      console.log(renderWalkthrough(verify, result));
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Human replies on findings persist raw for the agent-side learn ingestion;
 * extraction of the ruling stays with the agent — this layer never interprets. */
async function learnFeedJob(job: Extract<Job, { kind: "learn-feed" }>): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(
    join(DATA_DIR, "learn-feed.jsonl"),
    `${JSON.stringify({ ...job, receivedAt: new Date().toISOString() })}\n`,
  );
}

export function main(): void {
  const secret = env("LEVERET_WEBHOOK_SECRET");
  const port = Number(process.env.PORT ?? 8090);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (!verifySignature(secret, body, req.headers["x-hub-signature-256"] as string | undefined)) {
        res.writeHead(401).end();
        return;
      }
      const event = req.headers["x-github-event"] as string;
      let job: Job | null = null;
      try {
        job = routeEvent(event, JSON.parse(body));
      } catch {
        /* unparseable payload: acknowledge and ignore */
      }
      res.writeHead(202).end(); // ack fast; work happens after
      if (!job) return;
      const run = job.kind === "review" ? reviewJob(job) : learnFeedJob(job);
      run.catch((err) => console.error(`${job!.kind} job failed:`, err));
    });
  });
  server.listen(port, () => console.log(`leveret app listening on :${port}`));
}

main();
