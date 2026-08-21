# Leveret in your own client (MCP)

Drive reviews yourself from any MCP-capable agent client. Start with
[Getting started](#getting-started); [How it works](#how-it-works) has the diagram.

## Getting started

Prerequisites: Node 22+ and the [reviewer toolbelt](../README.md#the-reviewer-toolbelt).

**1. Build and register:**

```sh
git clone https://github.com/andrebrait/leveret && cd leveret
npm install && npm run build
claude mcp add leveret -- node "$PWD/dist/server.js"
```

**2. In your client, run a review** of the current branch of any repo:

```text
Use the leveret `review` prompt with repo=/path/to/repo base=origin/main,
then the `verify` prompt on its concerns.
```

**3. Teach it.** When you disagree with a finding — or want a house rule enforced:

```text
Call leveret.learn with the ruling and my handle as author.
```

## How it works

```mermaid
flowchart TD
    subgraph client["💻 Your agent client — your model"]
        direction TB
        A["🤖 Agent"]:::agent
        RP["🐇 review prompt<br>+ repo rulings"]:::agent
        VP["⚖️ verify prompt<br>+ repo rulings"]:::agent
    end

    subgraph mcp["🔌 leveret MCP server"]
        direction TB
        SCAN["🔍 scan: engines + delta<br>+ profile + memory"]:::core
        AST["🌳 ast_search"]:::core
        CTX["📊 context"]:::core
        MEM["🧠 remember / memory / learn"]:::core
    end

    subgraph repo["📁 The reviewed repo"]
        direction TB
        PROF[".leveret.yml profile"]:::store
        STORE[(".leveret/memory.jsonl")]:::store
        CODE["working tree + code graph"]:::store
    end

    A --> RP & VP
    A --> SCAN --> CODE
    SCAN --> PROF & STORE
    A --> AST & CTX --> CODE
    A --> MEM --> STORE
    STORE -. rulings injected .-> RP & VP
    classDef gh fill:#6ea8fe,stroke:#3d6fd9,color:#111
    classDef tun fill:#ffc86b,stroke:#cc8f22,color:#111
    classDef core fill:#7ed6a2,stroke:#3d9e6a,color:#111
    classDef agent fill:#c9a0f5,stroke:#9059d1,color:#111
    classDef store fill:#9fd8e3,stroke:#4d9aab,color:#111
```

- The **prompts** (`review`, `verify`) are the agent contracts, served with your
  repo's accumulated rulings — conventions and fingerprint reasons — substituted
  in, so the agent reviews with the repo's case law.
- The **tools** are the deterministic layer: `scan` applies delta, profile, and
  memory before any lead reaches the agent; `ast_search` and `context` ground
  structural claims and prioritize attention; `remember` and `learn` write the
  verdicts and rulings back to the store, which is versioned in the repo.
- Your client supplies the model and the sandbox: probes the agent executes run
  under your normal tool permissions. This path is deliberately not standardized —
  you are present to judge.
