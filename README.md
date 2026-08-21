<p align="center">
  <img src="assets/logo.svg" width="360" alt="Leveret logo">
</p>

# Leveret

A leveret is a young hare — small, fast, and born with its eyes open.

Leveret is a self-hosted, hybrid engine for private code reviews: the successor to
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

- **scan** `{repo, base? | files?, engines?, delta?}` — runs the engines applicable to
  the change set and returns normalized findings (`engine, rule, severity, file, line,
  message, provenance`) plus a per-engine status report. With a base ref the scan is
  **delta by default**: findings already present at the base tree are dropped as
  pre-existing (counted, never silent) and survivors are tagged `introduced`.
  Engines: semgrep (registry security + per-language rulesets), gitleaks (secrets over
  `base..HEAD` commits), shellcheck, ruff, actionlint, zizmor (workflow security),
  osv-scanner (lockfile CVEs), typos (spelling), jscpd (profile-gated duplication),
  profile-declared semgrep/ast-grep rule packs, and arbitrary SARIF-emitting commands
  via `custom:` profile entries ([recipes](docs/recipes.md): psalm taint, hadolint,
  trivy, ...). Findings are review *leads*, not verdicts.
- **ast_search** `{repo, pattern, lang, paths?}` — structural pattern matching via
  ast-grep (metavariables, syntax-aware), for call-site-shaped questions text grep
  gets wrong.
- **context** `{repo, files}` — prioritization signal, not findings: per-function
  cyclomatic complexity (lizard), 12-month churn, last-touched date.
- **remember / memory / learn** — the review memory: fingerprint verdicts with
  anchors, hygiene listing, and human-taught conventions that are injected into the
  served `review`/`verify` prompt contracts as repo rulings.

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

## GitHub App

See [docs/app.md](docs/app.md) — self-hosted App layer (webhooks, review posting,
learn feed; no model keys) with the BYOAI runner hook.

## Status / roadmap

See [DESIGN.md](DESIGN.md) — architecture, the three-grade filter (actionable /
priced-noise / false-positive), the in-repo memory store, agent prompt contracts,
and the validation benchmark gating adoption.

## License

[AGPL-3.0-or-later](LICENSE).
