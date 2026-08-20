# warren — design

Goal: a production-grade replacement for CodeRabbit's review capability, built as
composable layers an agent (Claude Code or any MCP client) drives, instead of a hosted
black box. The benchmark for "works" is defined at the bottom; until it passes, warren
changes nothing in the repos it reviews.

## Why CodeRabbit catches more than a naive LLM reviewer

From its published architecture, four pillars matter:

1. **Deterministic first pass** — a fleet of static analyzers, linters, secret and
   dependency scanners runs before any LLM sees the diff, producing grounded leads.
2. **Structural context** — a dependency-aware code graph traces changed symbols to
   call sites *outside* the diff; AST-level matching grounds pattern claims.
3. **A verification filter** — a second agent cross-checks every proposed comment and
   silently drops anything it cannot verify. Low false-positive rate is the product.
4. **Memory** — learnings per PR thread, per repo, and per organization suppress
   re-raising what was already priced and encode repo conventions.

warren replicates each pillar with local, inspectable pieces:

| Pillar | warren component |
| --- | --- |
| Deterministic first pass | engine registry behind the `scan` MCP tool |
| Code graph | CodeGraph MCP (already indexed per worktree) — composed by the agent, not wrapped |
| AST grounding | `ast_search` (ast-grep) + custom rule packs; LSP diagnostics via the client's LSP surface (e.g. Serena) |
| Verification filter | three-layer filter pipeline (below) ending in a verification agent |
| Memory | in-repo, versioned finding-verdict store + `remember` tool |

## Evidence so far (2026-08-20, v0.1 probe)

Scanning a real 15-commit range of pfBlockerNG produced 27 findings, all shellcheck,
all in one shellspec file the target repo deliberately excludes from shellcheck:

- 25/27 false positives by construction (SC2016 single-quoted `$1` for an inner
  `sh -c`; SC2329 functions invoked through the shellspec DSL's string indirection).
- 2/27 technically true but inert (SC2162 `read` without `-r` on a fixture fifo that
  can never carry a backslash).
- 0/27 actionable.

Conclusion: raw engine output is unusable as review comments, and — the sharper
lesson — a binary real/false-positive filter is not enough. The SC2162 pair is *true*
and still must not be posted. Findings need three grades.

## The three-grade filter

Every lead ends in exactly one grade:

- **`actionable`** — true, in scope, worth a comment. Surfaced with evidence.
- **`priced-noise`** — technically true, but the repo has (or now makes) a considered
  decision that fixing it buys nothing. Dropped from output, **recorded with its
  rationale** so the pricing is auditable and never re-litigated.
- **`false-positive`** — the claim is wrong (tool cannot see intent, DSL indirection,
  allowlisted value). Dropped, recorded so it never resurfaces.

Three layers assign grades, cheapest first; each layer only passes down what it
cannot decide:

1. **Profile (deterministic, per repo)** — `.warren.yml` in the target repo:
   per-engine path scopes (e.g. shellcheck only under `src/`, `scripts/`), severity
   floors, rule suppressions — each entry carrying a `reason:`. Kills whole noise
   classes for free. Suppressions are never silent: `scan` reports counts of what the
   profile dropped and why (a truncated report must not read as "clean").
2. **Memory (deterministic lookup)** — fingerprint match against the repo's verdict
   store. A previously graded finding whose anchor line is unchanged auto-applies its
   stored grade; a changed anchor invalidates the match and the lead falls through to
   layer 3 (code moved — the pricing may no longer hold).
3. **Verification agent (LLM, adversarial)** — for surviving leads plus everything the
   review agent proposes: refute-or-evidence. A claim it cannot ground in executed
   evidence (command + output) or cited code is dropped. It assigns the final grade
   and writes new memories for grades 2 and 3, so the expensive path runs at most
   once per finding class.

## Memory design

Repo-scope memory lives **in the reviewed repo**, versioned and reviewable —
`.warren/memory.jsonl`, one entry per graded finding class:

```json
{"fp": "shellcheck/SC2016/tests/shell/**", "grade": "false-positive",
 "reason": "shellspec specs pin literal $(...) command text; single-quoted $1 is the inner sh -c's positional parameter",
 "anchor": null, "author": "verifier-agent", "confirmedBy": "andrebrait",
 "created": "2026-08-20", "lastApplied": "2026-08-20"}
```

- **Fingerprint** (`fp`): `engine/rule/path-or-glob`. Class-wide entries use globs
  (grade applies to the rule in that subtree); instance entries pin a file plus an
  `anchor` — the hash of the trimmed matched line — so the memory dies with the code
  it priced instead of suppressing a future, different occurrence.
- **Scopes**, mirroring CodeRabbit's three: thread scope is the PR conversation
  itself (no store needed); repo scope is the file above; org scope (shared
  conventions across repos) is a later import layer, not MVP.
- **Provenance**: entries record who graded (agent or human) and human confirmation
  when given ("won't fix" reply on a PR comment is a confirmation event).
- **Promotion**: when instance entries for the same rule pile up under one subtree,
  the verifier proposes a profile entry or a glob memory — recurring pricing should
  become one line, not N.
- **Hygiene**: `lastApplied` enables garbage collection of memories that stopped
  matching anything; stale pricing is deleted, not hoarded.

## MCP surface (target)

- `scan {repo, base|files, engines?}` — as today, plus: applies profile + memory
  layers, returns leads **with grades already attached where decidable**, and a
  suppression report (`dropped: N by profile rule X / memory fp Y`).
- `ast_search {repo, pattern, lang, paths?}` — unchanged; also the verifier's
  grounding tool for "every call site shaped like this" claims.
- `remember {repo, fp, grade, reason, anchor?}` — persists a verdict to the repo
  store. Called by the verification agent (and by a human-driven session adopting a
  "won't fix" decision).
- `memory {repo, query?}` — list/inspect entries, surface promotion candidates.

Deliberately not wrapped: code-graph queries (CodeGraph MCP exists), LSP diagnostics
(client surface), shell probes (the driving agent already executes commands — warren
never needs its own sandbox because the agent *is* the sandbox).

## Agent pipeline

```
[diff] → scan (profile + memory applied) ─┐
         CodeGraph blast radius ──────────┼→ [review agent] → concerns
         LSP diagnostics on touched files ┘        ↓
                                        [verification agent]
                                 refute-or-evidence, 3-grade verdicts
                                          ↓                ↓
                                   actionable → report   priced-noise / false-positive
                                                          → remember → dropped
```

- **Review agent** (read-only): input is the diff, graded leads, and structural
  context. It must trace changed symbols through the code graph to call sites outside
  the diff — cross-file breakage is the class a diff-only reviewer structurally
  misses. Output: concerns with location and claimed impact.
- **Verification agent** (read-only, adversarial): tries to refute every concern and
  every surviving lead. Evidence bar: executed probe or cited current code, never
  plausibility. Unverifiable → dropped silently. This asymmetry — generation is
  generous, publication is strict — is what keeps the output trustworthy.

Both are prompt contracts (files in `agents/`), executable by any client that can
spawn read-only subagents; warren ships the contracts, not an orchestrator.

## Roadmap

- [x] **P1** — engine registry (semgrep, gitleaks, shellcheck, ruff, actionlint),
      normalized findings, MCP `scan` + `ast_search`, integration tests
- [ ] **P2** — `.warren.yml` profiles: path scopes, severity floors, reasoned
      suppressions, suppression reporting
- [ ] **P3** — memory store, fingerprints + anchors, `remember` + `memory` tools,
      auto-apply in `scan`, promotion candidates
- [ ] **P4** — engine additions: osv-scanner (dependency CVEs), zizmor (workflow
      security), project-local phpstan/phpcs, custom ast-grep rule packs
- [ ] **P5** — review + verification agent prompt contracts
- [ ] **P6** — benchmark, then the adoption decision

## Validation gate (the benchmark)

Corpus: historical pfBlockerNG PRs whose accepted CodeRabbit findings are indexed by
provenance comments in `tests/` (CR2, CR5, #65, #685, …) plus their full review
threads. Replay each PR's diff through the pipeline at the pre-merge SHA.

Metrics:

- **Recall** against CodeRabbit's *accepted* findings (the ones that produced fixes).
- **False-positive rate**: pipeline output the replaying human/agent judges
  not-actionable, compared against CodeRabbit's own noise rate on the same threads.
- **Beyond-diff catches**: findings in files outside the PR diff (the code-graph
  pillar earning its keep).

Pass = recall at least matching CodeRabbit's accepted set on the corpus without a
worse false-positive rate. Only then does pfBlockerNG issue #2599 (retiring
CodeRabbit, wiring the fourth review leg) unpark.
