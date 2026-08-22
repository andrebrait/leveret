# Leveret agent policy

- Make every repository change in a named branch worktree. Use one branch per
  worktree; treat detached worktrees as read-only.
- Start each agent session from its worktree root. Each worktree owns its
  `.codegraph/` index. Check it with `codegraph status --json "$root"`. Run
  `codegraph init "$root"` when absent and `codegraph index "$root"` when
  incomplete. Never copy an index from another checkout.
- Serena uses `--project-from-cwd`. Before semantic operations, verify its active
  project equals `git rev-parse --show-toplevel`. After creating or entering a
  different worktree, start a fresh top-level session there before using Serena.
- Use CodeGraph for indexed structure, call paths, and impact; Serena for exact
  TypeScript symbols, references, diagnostics, and refactors; Graphify for
  rationale, cross-document relationships, and test contracts. Literal/config
  searches use `rg`; builds, tests, and static analysis remain authoritative.
- Graphify output is local to the active worktree under ignored `graphify-out/`.
  Build or update it from that exact root; never share it across worktrees.
- Commit durable project inputs and lessons only: tool configuration, policy, and
  changes to canonical code, tests, or documentation. Keep CodeGraph databases,
  Serena caches/logs/local overrides, Graphify outputs, reports, and raw query
  results local and untracked.
