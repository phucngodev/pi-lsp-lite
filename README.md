# pi-lsp-lite

[pi](https://github.com/mariozechner/pi) extension that feeds LSP diagnostics back to the agent after every `write` and `edit`. Go, Rust, and TypeScript via `gopls`, `rust-analyzer`, and `typescript-language-server`.

The agent sees errors and warnings inline on the same turn as the edit that caused them — no context switch, no separate command.

## Install

```bash
pi install git:github.com/mcphailtom/pi-lsp-lite
```

Or from npm:

```bash
pi install npm:pi-lsp-lite
```

Try without installing:

```bash
pi -e git:github.com/mcphailtom/pi-lsp-lite
```

## Prerequisites

| Server | Language | Install |
|--------|----------|---------|
| `gopls` | Go | `go install golang.org/x/tools/gopls@latest` |
| `rust-analyzer` | Rust | `rustup component add rust-analyzer` |
| `typescript-language-server` | TypeScript/JavaScript | `npm install -g typescript-language-server typescript` |

Servers must be on `PATH`. If a server is missing, that language is silently disabled for the session.

## What it does

On every `write` or `edit` to a `.go`, `.rs`, `.ts`, `.tsx`, `.js`, or `.jsx` file:

1. Finds the workspace root by walking up from the file to the nearest `go.mod`, `Cargo.toml`, `tsconfig.json`, or `package.json` (bounded by the session's working directory)
2. Spawns a language server for that workspace if one isn't already running
3. Sends the file content to the server (`textDocument/didOpen` or `textDocument/didChange`)
4. Waits up to 3 seconds for `publishDiagnostics`
5. Appends errors and warnings to the tool result

If the edit breaks other files in the workspace, a footer reports the count.

### Example output

```
⚠ LSP diagnostics for main.go (2 errors):
  error 12:5 [compiler] undefined: foo
  error 18:2 [compiler] too many arguments in call to bar
  + 1 diagnostic in 1 other file
```

### What it doesn't do

- Auto-install language servers
- Block edits on diagnostics — pure feedback, agent decides what to do
- Format, autofix, or read-guard
- Support languages beyond Go, Rust, and TypeScript (adding one is a config entry in `src/languages.ts`)

## Commands

| Command | Description |
|---------|-------------|
| `/lsp-status` | Show running servers with PID, workspace root, open file count, uptime, idle time |

## How it works

```
agent calls write/edit
  → tool_result event fires
  → find workspace root (walk up for go.mod / Cargo.toml)
  → ensure language server is running for that root
  → send didOpen or didChange (full document sync)
  → wait for publishDiagnostics (3s timeout, 50ms settle)
  → compare diagnostic counts against pre-edit snapshot
  → append formatted diagnostics to tool result
```

Each language+root combination gets its own server instance. Edits to the same server are serialized to avoid diagnostic attribution races. Different servers run in parallel.

### Server lifecycle

- **Lazy start** — first edit to a supported file spawns the server
- **Idle shutdown** — servers shut down after 240 seconds of inactivity
- **Document cleanup** — open documents are closed after 120 seconds idle (periodic 60s sweep)
- **Session shutdown** — all servers are killed on `session_shutdown` with SIGTERM → SIGKILL escalation
- **Workspace isolation** — nested `go.mod` / `Cargo.toml` get separate servers

### Diagnostic accuracy

Diagnostics are correlated to edits using a per-URI generation counter. Stale diagnostics from a previous open/close cycle are rejected. Cross-file impact is detected via a snapshot-diff approach: diagnostic counts for all tracked files are compared before and after the edit settles.

Known limitations:

- Cross-file diagnostics that arrive after the 50ms settle window are missed
- Only count increases are reported — a fix that clears errors elsewhere is silent
- Full document sync on every edit; no incremental sync

## Development

```bash
git clone https://github.com/mcphailtom/pi-lsp-lite
cd pi-lsp-lite
npm install

# typecheck
npm run check

# unit tests (no servers required)
npm test

# integration tests (requires gopls and/or rust-analyzer on PATH)
npm run test:integration

# test locally in pi
pi -e ./index.ts
```

## License

MIT
