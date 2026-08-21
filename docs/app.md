# Running leveret as a GitHub App

The App layer owns GitHub plumbing only: webhook receipt, posting the review
(walkthrough + tier-grouped inline comments), and capturing human replies for the
`learn` feed. It holds a GitHub App key and a webhook secret — never a model
credential and never a copy of your code beyond the job's throwaway clone. The
model side stays BYOAI through the runner hook below.

## Create the App (one-click manifest flow)

1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
2. Webhook URL: `https://<your-host>:8090/` (any path). Set a webhook secret.
3. Permissions: **Pull requests: Read & write**, **Contents: Read**.
   Subscribe to events: **Pull request**, **Pull request review comment**.
4. Generate a private key; note the App ID. Install the App on your repos.
5. Upload [`assets/logo.png`](../assets/logo.png) as the App logo.

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

Without `LEVERET_RUNNER`, reviews are deterministic-only: engine findings post
directly, and the walkthrough states plainly that the agent lenses did not run.

## What feeds `learn`

Every human (non-bot) reply in a finding thread lands in
`$LEVERET_DATA/learn-feed.jsonl`. An agent session ingests those into
`.leveret/memory.jsonl` via the `learn` MCP tool — extraction of the ruling is agent
work; the App only captures.
