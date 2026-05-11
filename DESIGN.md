# pi-lsp-lite design

## Goal

Tightly scoped pi extension that surfaces LSP diagnostics to the agent
on every `write` and `edit`. Go and Rust to start.

## Scope

**Does:**
- Spawn long-lived `gopls` / `rust-analyzer` subprocesses on demand (lazy start on first relevant edit)
- Detect workspace root by walking up from edited file looking for `go.mod` / `Cargo.toml`
- Send `textDocument/didOpen` and `textDocument/didChange` (full document sync) after each `write` / `edit` tool result
- Collect `textDocument/publishDiagnostics` (errors + warnings) for the edited file and report cross-file impact
- Append diagnostics to the tool result content so the agent sees them on the same turn
- Close idle documents after 120s via periodic sweep
- Idle-shutdown language servers after 240s
- Clean up all servers on `session_shutdown`
- `/lsp-status` command for visibility (shows language, workspace root, PID, open files, uptime, idle time)

**Does not:**
- Auto-install language servers (gopls / rust-analyzer must be on PATH)
- Block edits on diagnostics (pure feedback, agent decides what to do)
- Format, autofix, secrets-scan, or read-guard
- Support languages beyond Go and Rust (yet — adding one is just a config entry)

## Architecture

```
pi-lsp-lite/
├── index.ts               ← extension entry: tool_result hook, session_shutdown, /lsp-status
├── src/
│   ├── languages.ts       ← server config registry: binary, args, extensions, rootPatterns
│   ├── client.ts          ← JSON-RPC protocol connection: initialize, didOpen/didChange/didClose, diagnostics with snapshot-diff
│   ├── server-manager.ts  ← lifecycle: lazy spawn per language+root, idle timeout, periodic didClose sweep, serialized edits
│   ├── format.ts          ← DiagnosticResult → readable text with cross-file footer
│   └── util.ts            ← fileUri(), which(), findWorkspaceRoot()
└── test/
    ├── fake-server.ts     ← minimal JSON-RPC server for testing
    ├── client.test.ts
    ├── server-manager.test.ts
    ├── format.test.ts
    └── util.test.ts
```

## Design decisions

### Diagnostics delivery: append to tool_result

Hook `tool_result` for `write` and `edit`. If the file matches a
supported language, route through server-manager and append formatted
diagnostics to the result content array. Agent sees them immediately on
the same turn, attributed to the edit that caused them.

### Document sync: full document

Send the entire file content on every didOpen/didChange. Incremental
sync would require converting edit tool oldText/newText into LSP-style
ranges — fiddly and not worth the complexity.

### Workspace root detection

Walk up from the edited file's directory looking for rootPattern markers
(`go.mod`, `Cargo.toml`), bounded by the session's `cwd`. Different
workspace roots spawn different servers (map key: `${languageId}:${root}`).
Falls back to `cwd` when no marker is found.

### Serialized edits per server

Edits to the same server are serialized via a promise queue (`editQueue`)
to prevent concurrent `waitForDiagnostics` races. Different servers
(different languages or different workspace roots) run in parallel.

### Cross-file diagnostics: snapshot-diff

Before the edit settles, snapshot diagnostic counts for all tracked URIs.
After the settle window (50ms), compare. Any file whose error/warning
count increased is reported in a "plus N diagnostics in M other files"
footer. Works for both new and already-open files.

### Document lifecycle

- `didOpen` on first edit to a file, `didChange` on subsequent edits
- `didClose` sent by a periodic sweep (60s interval) for documents idle > 120s
- Sweep timer is `.unref()`'d and starts/stops with server lifecycle

### Server lifecycle

- **Lazy start**: first edit to a .go or .rs file triggers spawn + initialize handshake
- **Idle timeout**: 240s default. Timer resets on each relevant edit. When it fires, send LSP shutdown + exit.
- **Session shutdown**: kill all servers immediately via `session_shutdown` event handler.
- **Missing binary**: log once on first attempt, disable that language for the session. No retry, no install prompt.

### Diagnostic result status

`DiagnosticResult` carries `status: "ok" | "timeout"` so the agent knows
when results may be incomplete. Format.ts surfaces "timed out, may be
incomplete" explicitly rather than showing an empty result that looks clean.

## Data flow

```
agent calls write/edit
  → pi executes tool
  → tool_result event fires
  → extension checks: is this a .go / .rs file?
  → find workspace root (walk up for go.mod / Cargo.toml, bounded by cwd)
  → if no server for this language+root: spawn + initialize (with 10s timeout)
  → queue edit on server's editQueue (serialized)
  → snapshot diagnostic counts for all tracked URIs
  → send didOpen (if first time) or didChange (full content)
  → wait for publishDiagnostics notification (3s timeout, 50ms settle)
  → compare diagnostic counts against snapshot for cross-file impact
  → filter to errors + warnings
  → format as readable text with optional cross-file footer
  → append to tool_result content
  → agent sees diagnostics inline
```

## Open questions

- **Per-language timeout config**: rust-analyzer may benefit from longer timeout on cold start
- **On-demand diagnostics**: whether to add a `/lsp-diag` command for checking diagnostics without an edit trigger
- **Incremental sync**: full document sync works but is wasteful on large files; would need LSP capability negotiation
