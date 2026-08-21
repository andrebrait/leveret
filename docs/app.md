# Running leveret as a GitHub App

The App layer owns GitHub plumbing only: webhook receipt, posting the review
(walkthrough + tier-grouped inline comments), and capturing human replies for the
`learn` feed. It holds a GitHub App key and a webhook secret — never a model
credential and never a copy of your code beyond the job's throwaway clone. The
model side stays BYOAI through the runner hook below.

## Create the App (one-click manifest flow)

The easy path — the server creates the App for you:

1. Start the server unconfigured (just `LEVERET_PUBLIC_URL` set to where GitHub
   can reach you — a tunnel/smee URL is fine): `node dist/app/server.js`.
2. Open `http://127.0.0.1:8090/setup` (add `?org=<name>` to create under an
   organization) and click **Create the App on GitHub**.
3. GitHub shows one confirmation screen, creates the App **under your account**
   (webhook already pointing at your server), and redirects back; the credentials
   are stored in the data dir on this machine only. Follow the install link and
   pick your repositories. Done.

Manual path (equivalent, if you prefer the form):

1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
2. Webhook URL: wherever GitHub can reach you — a NAT'd box needs no exposed port:
   - testing: a [smee.io](https://smee.io) channel, relayed locally with
     `npx smee -u <channel> -t http://127.0.0.1:8090/`;
   - production: a tunnel (e.g. `cloudflared tunnel --url http://127.0.0.1:8090`)
     whose public URL goes in this field.
   Set a webhook secret either way.
3. Permissions: **Pull requests: Read & write**, **Contents: Read**.
   Subscribe to events: **Pull request**, **Pull request review comment**.
4. Generate a private key; note the App ID. Install the App on your repos.
5. Upload [`assets/logo.png`](../assets/logo.png) as the App logo.

## Reviewer toolbelt (leveret's dependencies, not the reviewed repo's)

The engines and the code graph are capabilities of the REVIEWER: leveret generates
the graph into every checkout at exactly the reviewed commit, regardless of what
the target repository ships. Install beside the server: `codegraph`, plus the
engines you want live (`semgrep`, `gitleaks`, `shellcheck`, `ruff`, `actionlint`,
`zizmor`, `osv-scanner`, `typos`, `jscpd`, `ast-grep`). A missing tool degrades
loudly — the walkthrough reports which surfaces were live — but a review host
should carry the full belt.

## Run the server

```sh
LEVERET_APP_ID=12345 \
LEVERET_PRIVATE_KEY_PATH=/etc/leveret/app.pem \
LEVERET_WEBHOOK_SECRET=... \
node dist/app/server.js
```

Optional:

- `PORT` (default 8090)
- `LEVERET_DATA` (default `~/.leveret-app`) — where `learn-feed.jsonl` accrues human
  replies on findings, raw, for agent-side `learn` ingestion.
- `LEVERET_RUNNER` — the BYOAI seam, below.

On every PR open/push the server clones the head into a temp dir, runs the
deterministic `scan` against the base (delta, profile, memory, reminders all apply),
runs the runner if configured, and posts one review: the walkthrough summary as the
review body, in-diff findings as inline comments.

## The runner hook (BYOAI)

`LEVERET_RUNNER` is a command executed in the job's checkout with:

- `LEVERET_REPO` — the checkout path
- `LEVERET_BASE` — the base ref to review against
- `LEVERET_LEADS` — path to the scan result JSON

It must print a verify-output JSON object (`report` with tiers/scopes, `verdicts`,
`coverage` — see `agents/verify.md`) on stdout. Anything able to drive the
review/verify contracts fits: a Claude Code invocation under your Max subscription
or API key, a Codex/ChatGPT-backed client, or a local model behind an
OpenAI-compatible endpoint. The App process never sees the provider credential —
the runner command carries its own environment.

The shipped default is `leveret-runner-omp` (set `LEVERET_RUNNER=leveret-runner-omp`):
omp.sh headless with the purity flags fixed (no skills/extensions/rules/session/LSP,
compaction off — the standardization) and the caller's choices flowing through CLI
args or env (CLI wins): `--model`/`LEVERET_RUNNER_MODEL` (default gpt-5.6-sol),
`--effort`/`LEVERET_RUNNER_EFFORT` (default high), `--provider`, `--max-time`, and
`--omp-arg`/`LEVERET_RUNNER_OMP_ARGS` for provider-shaped passthrough (profile,
api-key). The effective harness + model + thinking land in the walkthrough's
run-configuration line. omp's subscription support carries the BYOAI matrix.

Without `LEVERET_RUNNER`, reviews are deterministic-only: engine findings post
directly, and the walkthrough states plainly that the agent lenses did not run.

## What feeds `learn`

Every human (non-bot) reply in a finding thread lands in
`$LEVERET_DATA/learn-feed.jsonl`. An agent session ingests those into
`.leveret/memory.jsonl` via the `learn` MCP tool — extraction of the ruling is agent
work; the App only captures.
