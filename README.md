# OpenCR — Open Code Review

The self-hosted, hybrid engine for private code reviews.

OpenCR is a local-first alternative to hosted AI review bots: deterministic static
analysis, AST-level search, and a graded filtering pipeline exposed over MCP, driven
by whatever reviewing agent you bring (BYOM — Claude Code, a local model via any
MCP-capable client, or a CI runner). Your code never leaves the burrow unless you
choose the provider that takes it there.

Pipeline the project targets:

```
[diff] → [deterministic first pass: opencr scan] → [review agent: leads → concerns]
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
claude mcp add opencr -- node /Users/andre/git/opencr/dist/server.js
```

## Status / roadmap

See [DESIGN.md](DESIGN.md) — architecture, the three-grade filter (actionable /
priced-noise / false-positive), the in-repo memory store, agent prompt contracts,
and the validation benchmark gating adoption.
