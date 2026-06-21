# askd architecture

askd is a read-only reading assistant that runs in a Chrome side panel and
answers questions about whatever you're viewing by driving your **locally
logged-in** Claude Code or Codex CLI. This document explains how the pieces fit
together and the engineering decisions behind them.

## System overview

```
┌─────────────────────┐     HTTP + SSE      ┌──────────────────┐     spawn / SDK     ┌──────────────┐
│  Chrome extension   │  ───────────────►   │   Local bridge   │  ───────────────►   │  Claude Code │
│  (side panel +      │   127.0.0.1 only    │   (Node, no DB)  │   read-only         │  Codex CLI   │
│   content script +  │   bearer token      │                  │                     │  doc fetcher │
│   background proxy)  │  ◄───────────────   │                  │  ◄───────────────   │  (optional)  │
└─────────────────────┘                     └──────────────────┘                     └──────────────┘
```

Three processes, one trust boundary:

- **Extension** (MV3) — `content.js` reads the page (Readability, never mutates
  the DOM), `sidepanel.js` is the UI, `background.js` is the only code that holds
  the bridge URL + token and proxies every request (including the SSE stream).
- **Bridge** (Node, loopback-only, token-gated) — turns a chat request into a
  backend turn, enforces the read-only policy, streams tokens/tool-events back.
- **Backend** — the user's own `claude` / `codex` CLI. askd has **no API key**;
  it reuses the user's existing login.

## Request lifecycle (`POST /api/chat`)

1. **Auth + origin gate** (`http.js`) — constant-time bearer check; only
   `chrome-extension://` origins are allowed; everything binds `127.0.0.1`.
2. **Session resolution** (`sessions.js`) — one session per normalized URL
   (`urlkey.js` strips tracking noise so the same doc maps to one thread).
3. **Prompt assembly** (`prompt.js`) — page context + quotes + (replayed)
   history + the question, each clipped to a **token budget** (`context.js`) and
   the page numbered into **citation segments** (`citations.js`).
4. **Backend dispatch** (`adapters/`) — `runClaude` (Agent SDK) or `runCodex`
   (subprocess), both yielding a uniform event stream:
   `token → tool → done | aborted | error`.
5. **Stream + post-process** (`server.js`) — tokens are forwarded over SSE; on
   `done` the answer's `[n]` citations are verified and a `citations` event is
   emitted; the turn is persisted.

## Read-only security model

The guarantee — *askd can read, never write, and never escapes the chosen
directory* — is enforced **three independent ways** so no single mistake breaks
it (`safety.js`, `adapters/claude.js`):

1. **Tool allow-list** — the base tool set contains only `Read/Glob/Grep` (+ web
   tools). Write/shell tools never enter the model's context.
2. **Explicit deny-list** — `Edit/Write/NotebookEdit/Bash` are also disallowed,
   as defense-in-depth.
3. **Runtime gate (`canUseTool`)** — a default-deny check that blocks anything
   off-policy and confines file paths to the session root (`isInsideRoot`
   rejects `../` escapes and sibling-prefix tricks).

When a session has **no working directory**, it gets no file tools at all and
the subprocess runs in an empty `NO_ACCESS_DIR`, so the SDK can never fall back
to the bridge's own `process.cwd()`. `test/safety.test.js` asserts these
invariants directly — re-enabling a write tool fails the suite.

The extension upholds the same promise on the page: the content script only
reads the DOM, and citation highlighting uses the browser's native
`window.find` (a transient selection), never DOM mutation.

## Context management (`context.js`)

The Codex path (and the Claude path right after a backend switch) splices the
whole conversation + page into one prompt, which would grow unbounded. askd
keeps it within a token budget the way an agent main loop does:

- **Token estimation** — the standard chars/4 heuristic.
- **`clipToTokens('middle')`** — a long document keeps its **head and tail**,
  dropping only the middle, instead of head-truncation that silently loses the
  conclusion.
- **`compactConversation`** — keeps the most recent turns verbatim and collapses
  older ones into an `[N earlier turns omitted]` marker, always preserving a
  recent window even if it exceeds budget.

## Citations (`citations.js`)

1. `segmentPage` numbers the (clipped) page into `[1]/[2]/…` paragraphs and
   returns a segment map.
2. The system prompt asks the model to cite page-grounded claims with `[n]`.
3. `verifyCitations` parses the answer's references and validates each against
   the map — a hallucinated number is flagged, not silently trusted.
4. The panel renders `[n]` as clickable footnotes; clicking scrolls to and
   highlights the source passage. The segment map is persisted on the session so
   later resume turns (which don't re-send the page) can still resolve `[n]`.

## Backend adapter abstraction (`adapters/`)

Both backends are async generators yielding the same event shape, so
`server.js` is backend-agnostic. Differences are isolated:

- **Claude** keeps history server-side via `resume`; page context is sent once
  (and re-sent on change). `settingSources: ['user']` loads `~/.claude` only —
  picking up corporate `apiKeyHelper` logins while excluding project rules.
- **Codex** has no server-side memory, so history is spliced into the prompt.
  Read-only flags must precede the `exec` subcommand; the JSON stream tolerates
  schema drift and falls back to `--output-last-message` for the final answer.

## Evaluation harness (`eval/`)

Graded cases run against the **real** Claude backend (the same `runClaude`
path), reporting answer accuracy, **tool-call precision/recall**, citation
validity, and real cost/latency from the SDK. Graders are pure and unit-tested
without a model; an adversarial case confirms the agent refuses to write and
never calls a write tool. See [`eval/README.md`](../eval/README.md).

## Notable engineering decisions

- **No database.** Sessions persist to a single JSON file written atomically
  (temp + rename); a corrupt store is backed up rather than crashing the bridge.
- **Loopback + token, always.** `HOST` is not configurable; the token is written
  `0600`. CORS is restricted to extension origins.
- **Uniform streaming contract.** The `token/tool/done/aborted/error` shape lets
  the UI, the server, and the eval harness all consume backends identically.
- **Tested invariants over comments.** Security policy, prompt assembly, context
  budgeting, and citation logic are each asserted in `node:test` suites that run
  in CI.
