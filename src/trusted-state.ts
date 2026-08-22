import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.js";

export interface TrustedReviewState {
  root: string;
  profilePath: string;
  close(): Promise<void>;
}

async function fileAtRef(repo: string, ref: string, path: string): Promise<string | undefined> {
  const result = await run("git", ["show", `${ref}:${path}`], repo);
  return result.code === 0 ? result.stdout : undefined;
}

/** Copy review policy from the trusted base commit, outside the untrusted checkout. */
export async function materializeTrustedReviewState(
  repo: string,
  base: string,
): Promise<TrustedReviewState> {
  const root = await mkdtemp(join(tmpdir(), "leveret-trusted-"));
  const profilePath = join(root, ".leveret.yml");
  try {
    await writeFile(profilePath, (await fileAtRef(repo, base, ".leveret.yml")) ?? "");
    const memory = await fileAtRef(repo, base, ".leveret/memory.jsonl");
    if (memory !== undefined) {
      await mkdir(join(root, ".leveret"), { recursive: true });
      await writeFile(join(root, ".leveret", "memory.jsonl"), memory);
    }
    return {
      root,
      profilePath,
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
