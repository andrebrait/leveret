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
}

export function run(cmd: string, args: string[], cwd: string, opts?: RunOpts): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: opts?.timeoutMs ?? 0 }, (err, stdout, stderr) => {
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
