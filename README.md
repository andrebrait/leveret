# warren

Prototype of a hybrid, agent-driven code-review backend — the deterministic layer of a
CodeRabbit replacement. An MCP server exposes normalized static analysis to a reviewing
agent, which composes it with a code graph (CodeGraph MCP) and LSP diagnostics.

Pipeline the prototype targets:

```
[diff] → [deterministic first pass: warren scan] → [review agent: leads → concerns]
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
claude mcp add warren -- node /Users/andre/git/warren/dist/server.js
```

## Status / roadmap

See [DESIGN.md](DESIGN.md) — architecture, the three-grade filter (actionable /
priced-noise / false-positive), the in-repo memory store, agent prompt contracts,
and the validation benchmark gating adoption.
