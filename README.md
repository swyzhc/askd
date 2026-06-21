# askd — local reading assistant in your Chrome side panel

Ask your **already-logged-in** Claude Code or Codex CLI about whatever you're
reading — a web page, a corporate doc, a GitHub README, a PDF — right from a
Chrome side panel. askd **only reads**: it can summarize, explain, and compare a
page against your local code. It never writes files, never runs shell commands,
and never operates the web page.

```
┌─────────────────────┐     HTTP + SSE      ┌──────────────────┐     spawn / SDK     ┌──────────────┐
│  Chrome extension   │  ───────────────►   │   Local bridge   │  ───────────────►   │  Claude Code │
│  (side panel +      │   127.0.0.1 only    │   (Node, no DB)  │   read-only         │  Codex CLI   │
│   content script +  │   bearer token      │                  │                     │  doc fetcher │
│   background proxy)  │  ◄───────────────   │                  │  ◄───────────────   │  (optional)  │
└─────────────────────┘                     └──────────────────┘                     └──────────────┘
```

---

## ⚠️ Data flow & your responsibility — read this first

askd is **read-only on your machine** and the bridge binds `127.0.0.1` only.
That is *not* the same as "your data stays local":

- The content you ask about — **page text, any document a fetcher pulls, and any
  local code the agent reads** — is sent to your **selected backend's cloud** for
  inference: **Claude → Anthropic, Codex → OpenAI**. It leaves your machine.
- askd does **not** and **cannot** enforce your organization's data-classification
  rules. It can't know that a given page is confidential, and it won't stop you
  from opening the panel on it. **That judgment is yours.**

Before using it on anything work-related:

- Check your employer's policy on third-party AI tools and code/doc sharing.
- Don't use it on content above the sensitivity level those tools are approved for.
- If your org runs an **approved or self-hosted model endpoint**, point the
  underlying Claude Code / Codex CLIs at it so data doesn't go to a public cloud.

You are responsible for where you open it. Different companies, different rules.

---

## Run it in 5 minutes

### Prerequisites

- **Node.js ≥ 20** (`node --version`)
- **Claude Code** installed **and logged in** — run `claude` once **and sign in**
  (askd drives your local login and has no API key of its own; if Claude Code
  isn't logged in, every question fails with *"Not logged in / Please run
  /login"*).
- *Optional:* **Codex CLI** (`codex`) logged in, for the experimental Codex backend.
- *Optional:* a **document fetcher** CLI for specific sites (see
  [Document fetchers](#document-fetchers-optional)).
- **Google Chrome ≥ 116** (Side Panel API).

### 1 · Start the bridge

```bash
cd bridge
npm install
npm start
```

It prints its URL and a bearer token (saved once to `~/.askd/token`). Leave it
running.

### 2 · Load the extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the **`extension/`** folder.

### 3 · Connect the side panel

1. Click the askd toolbar icon to open the panel (opens **Settings** first time).
2. Paste the **URL** and **Token** from step 1 → **Test connection** → **Save**.

### 4 · Ask something

Open an article, type a question, press **Enter** (Shift+Enter for a newline).

---

## What you can do

| Feature | How |
|---|---|
| **Ask about the current page** | Just type. askd extracts the main text (via Readability) as context. |
| **Quote selections** | Select text and press **⌘⇧L / Ctrl+Shift+L** to attach it. Repeat to attach **multiple** selections; each chip has a × to remove it. |
| **Site document fetcher** | If you configure a fetcher for a site, askd pulls clean Markdown via your CLI instead of scraping the DOM. On failure it falls back to the page's visible text and warns you. |
| **Compare docs vs. local code** | Click the **`no local access`** badge → set a **local code directory (cwd)**. The assistant may then **read only that directory** (Read/Glob/Grep). |
| **Per-page conversations** | Every page (by normalized URL) has its own thread. Different URLs never share a conversation. |
| **New conversation / Stop / backend switch** | **＋ New** clears the thread; **Stop** aborts streaming; pick **Claude** or **Codex** per page. |

Answers render as Markdown — code blocks, lists, tables, inline code.

---

## Document fetchers (optional)

A **fetcher** maps a set of hostnames to a local CLI command that returns
Markdown for a URL. This is how askd gets clean content from sites whose DOM is
hard to scrape — **without baking any specific tool into the core**. The public
repo ships **no real fetcher**; you add your own.

Create `~/.askd/fetchers.json` (a JSON array). Copy `bridge/fetchers.example.json`
as a starting point:

```json
[
  {
    "name": "example-docs",
    "hosts": ["(^|\\.)docs\\.example\\.com$"],
    "command": "your-doc-cli",
    "args": ["fetch", "--url", "{url}", "--format", "markdown"],
    "timeoutMs": 30000
  }
]
```

- `hosts` — regex patterns matched against the URL's hostname.
- `command` + `args` — the CLI to run; `{url}` is substituted with the page URL.
  The command must print Markdown to stdout and exit 0.

Restart the bridge. On matching sites the panel will fetch via your CLI; on any
other site (or on failure) it uses the page's visible text. This file may
reference an **internal tool**, so it lives in `~/.askd/` and is **gitignored** —
keep it out of any public repo.

---

## Security model

askd is deliberately **read-only**; the bridge enforces this, the extension
can't widen it.

- **Loopback only.** Binds `127.0.0.1`, never `0.0.0.0`.
- **Bearer token** on every route except `/healthz`. CORS allows only
  `chrome-extension://` origins.
- **No cloud APIs called by askd directly** — it drives your local CLIs. (Those
  CLIs do talk to their clouds — see **Data flow & your responsibility** above.)
- **Claude tool gating** (three layers — `bridge/src/safety.js`,
  `adapters/claude.js`):
  - Always disabled: `Edit`, `Write`, `NotebookEdit`, `Bash` — and in fact *any*
    non-read tool, since the allow-list only ever permits the five read-only ones.
  - Allowed (read-only): `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`.
  - **No cwd** ⇒ file tools removed entirely + subprocess runs in an empty dir, so
    it has zero local file access and can't fall back to the bridge's own cwd.
  - **cwd set** ⇒ `Read`/`Glob`/`Grep` confined to that directory; a runtime gate
    denies any escaping path.
- **Codex** launches read-only with flags **before** `exec`:
  `codex --sandbox read-only --ask-for-approval never exec …`, with `-C <cwd>`
  only when a cwd is set.

Not in v1: writing files, arbitrary shell, clicking/filling/navigating pages,
multi-tab aggregation, cloud-model fallback, team/multi-user/sharing.

---

## Manual smoke test

1. **Plain web page** — ask a question → streamed Markdown answer.
2. **Fetcher fallback** — on a fetcher-matched site without the CLI installed,
   you see a clear *"… fetch failed (the fetch command is not installed). Falling
   back to the page's visible text"* banner, and asking still works.
3. **Selection** — select text, ⌘⇧L → the quote appears; ask about it.
4. **Per-page memory** — a follow-up on the same page remembers the first turn;
   a different URL is a fresh conversation.
5. **No local access** — with no cwd, the badge reads `no local access`; the model
   reports it has no file access.
6. **Local read** — set a cwd; the model uses `Read`/`Grep` within that dir only.
7. **Stop** — a long answer halts on **Stop**.

---

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `ASKD_PORT` | `8765` | Port (still `127.0.0.1` only). |
| `ASKD_TOKEN` | *(generated)* | Override the bearer token. |
| `ASKD_DATA_DIR` | `~/.askd` | Token + `sessions.json` + `fetchers.json`. |
| `ASKD_FETCHERS_FILE` | — | Explicit path to a fetchers config. |

State lives in `~/.askd/`. Delete `sessions.json` to wipe conversations.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| *"Bridge not reachable"* | `cd bridge && npm start`; confirm the URL in Settings. |
| *"Bridge rejected the token (401)"* | Copy the token from the bridge banner (or `~/.askd/token`) into Settings. |
| *Fetcher "fetch command is not installed"* | Install your fetcher CLI / fix its PATH, or rely on the DOM fallback. |
| *Fetcher "missing permission/scope"* | The doc needs scopes your CLI login lacks; use the fallback or re-auth. |
| *"Couldn't read this page"* | Reload the page — content scripts don't attach to tabs opened before install. `chrome://`/Web Store/PDF-viewer pages can't be read at all. |
| *`file://` pages/PDFs* | Enable **Allow access to file URLs** for askd on `chrome://extensions`. |
| *"Not logged in" / "Please run /login"* | Your Claude Code isn't authenticated. Run `claude` in a terminal and sign in, then retry. askd uses your local login, not an API key. ("Test connection" showing *Claude: found* only means the CLI is installed, not logged in.) |
| *⌘⇧L / Ctrl+Shift+L does nothing* | Another extension may have claimed the shortcut. Open `chrome://extensions/shortcuts`, find askd's *"Open askd with the current selection"*, and (re)assign it. Reload the extension afterward. |

---

## Development

```bash
cd bridge
npm test     # URL-key normalization, read-only safety policy, codex argv ordering
npm start
```

```
bridge/      Node HTTP bridge (loopback, token-gated, read-only)
  src/adapters/{claude,codex}.js     # backends
  src/fetchers.js                    # generic, config-driven document fetchers
  src/{safety,sessions,urlkey,prompt,http,config,capabilities,server}.js
  test/                              # node:test
  fetchers.example.json              # sample fetcher config (no real tool)
extension/   Chrome MV3 (manifest, background, content, sidepanel.*, vendor/)
```

The Codex backend is **experimental**: argv ordering is unit-tested; its event
stream tolerates schema drift and falls back to `--output-last-message`.

## License

[MIT](LICENSE) © 2026 swyzhc
