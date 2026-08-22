import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** set when the child died on a signal (OOM kill, timeout, segfault) */
  signal?: string;
}

// No shell: file names from a diff must never hit string interpolation.
export interface RunOpts {
  /** hard cap: the child is SIGTERM'd at the deadline (no orphaned waits) */
  timeoutMs?: number;
  /** explicit child environment; Pi runner uses this to keep provider secrets out of tools */
  env?: NodeJS.ProcessEnv;
  /** output cap; callers handling untrusted tools should keep this small */
  maxBuffer?: number;
}

const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "CI",
  "GITHUB_ACTIONS",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
] as const;

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/** Environment for untrusted checkout tools: runtime basics, never provider/GitHub credentials. */
export function safeChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

export function run(cmd: string, args: string[], cwd: string, opts?: RunOpts): Promise<ExecResult> {
  return new Promise((resolve) => {
    const env = opts?.env ?? (process.env.LEVERET_SANITIZE_CHILD_ENV === "1" ? safeChildEnvironment() : undefined);
    execFile(cmd, args, { cwd, env, maxBuffer: opts?.maxBuffer ?? 64 * 1024 * 1024, timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS }, (err, stdout, stderr) => {
      let code = 0;
      let signal: string | undefined;
      if (err) {
        const e = err as NodeJS.ErrnoException & { code?: unknown; signal?: string };
        if (typeof e.signal === "string" && e.signal) {
          // A signal death reports err.code null; `?? 0` would read as success
          // and callers would trust partial stdout from a killed tool.
          code = -1;
          signal = e.signal;
        } else if (typeof e.code === "number") {
          code = e.code;
        } else {
          code = -1; // spawn failure (ENOENT etc.), not a tool verdict
        }
      }
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "", ...(signal ? { signal } : {}) });
    });
  });
}

/** Unique scratch path: the MCP server is one long-lived process serving
 * concurrent calls, so pid alone collides — always add entropy. */
export function scratchPath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${process.pid}-${randomBytes(4).toString("hex")}`);
}

export function which(cmd: string): Promise<boolean> {
  return run("/usr/bin/which", [cmd], "/").then((r) => r.code === 0);
}
