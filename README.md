# leveret

A leveret is a young hare — small, fast, and born with its eyes open.

leveret is a self-hosted, hybrid engine for private code reviews: the successor to
hosted AI review bots for teams whose code stays home. Deterministic static analysis,
AST-level search, and a graded filtering pipeline exposed over MCP, driven by whatever
reviewing agent you bring (BYOM — Claude Code, a local model via any MCP-capable
client, or a CI runner). The engine layer itself never calls an LLM.

Pipeline the project targets:

```
[diff] → [deterministic first pass: leveret scan] → [review agent: leads → concerns]
       → [verification agent: refute-or-evidence filter] → [report]
```

## Tools

- **scan** `{repo, base? | files?, engines?}` — runs the engines applicable to the change
  set and returns normalized findings (`engine, rule, severity, file, line, message`)
  plus a per-engine status report (`findings | clean | not-applicable | missing | error`).
  Engines: semgrep (registry security + per-language rulesets), gitleaks (secrets over
  `base..HEAD` commits), shellcheck, ruff, actionlint. Findings are review *leads*, not
  verdicts.
- **ast_search** `{repo, pattern, lang, paths?}` — structural pattern matching via
  ast-grep (metavariables, syntax-aware), for call-site-shaped questions text grep
  gets wrong.

## Run

```sh
npm install && npm run build
node dist/server.js          # stdio MCP server
npm test                     # integration tests (need semgrep, gitleaks, shellcheck, ruff, actionlint, ast-grep on PATH)
```

Claude Code registration:

```sh
claude mcp add leveret -- node /Users/andre/git/leveret/dist/server.js
```

## Status / roadmap

See [DESIGN.md](DESIGN.md) — architecture, the three-grade filter (actionable /
priced-noise / false-positive), the in-repo memory store, agent prompt contracts,
and the validation benchmark gating adoption.
