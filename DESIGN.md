# pi-lsp-lite design

## Goal

Tightly scoped pi extension that surfaces LSP diagnostics to the agent
on every `write` and `edit`. Go and Rust to start.

## Scope

**Does:**
- Spawn long-lived `gopls` / `rust-analyzer` subprocesses on demand (lazy start on first relevant edit)
- Send `textDocument/didOpen` and `textDocument/didChange` (full document sync) after each `write` / `edit` tool result
- Collect `textDocument/publishDiagnostics` (errors + warnings) for the edited file
- Append diagnostics to the tool result content so the agent sees them on the same turn
- Idle-shutdown language servers after configurable timeout
- Clean up all servers on `session_shutdown`
- `/lsp-status` command for visibility

**Does not:**
- Auto-install language servers (gopls / rust-analyzer must be on PATH)
- Block edits on diagnostics (pure feedback, agent decides what to do)
- Format, autofix, secrets-scan, or read-guard
- Support languages beyond Go and Rust (yet — adding one is just a config entry)

## Architecture

```
pi-lsp-lite/
├── index.ts              ← extension entry: wires events, registers /lsp-status
└── src/
    ├── languages.ts      ← server config registry: binary name, args, file extensions, capabilities
    ├── client.ts         ← thin JSON-RPC client over stdio: initialize handshake, didOpen/didChange, diagnostics collection
    ├── server-manager.ts ← owns server lifecycle: lazy spawn, idle timeout, shutdown
    └── format.ts         ← diagnostics → human-readable string for tool result injection
```

## Design decisions

### Diagnostics delivery: append to tool_result (1a)

Hook `tool_result` for `write` and `edit`. If the file matches a
supported language, route through server-manager and append formatted
diagnostics to the result content array. Agent sees them immediately on
the same turn, attributed to the edit that caused them.

Trade-off: muddies the original tool result slightly, but the feedback
loop is tighter than injecting a separate message.

### Document sync: full document (2a)

Send the entire file content on every didOpen/didChange. Simple and
reliable. Incremental sync would require tracking document versions and
converting edit tool oldText/newText into LSP-style ranges — fiddly and
not worth the complexity for v1.

### Server lifecycle

- **Lazy start**: first edit to a .go or .rs file triggers spawn + initialize handshake
- **Idle timeout**: configurable (default 240s). Timer resets on each relevant edit. When it fires, send shutdown + exit to the server.
- **Session shutdown**: kill all servers immediately via session_shutdown event handler.
- **Missing binary**: log once on first attempt, disable that language for the session. No retry, no install prompt.

### Workspace detection

Use `ctx.cwd` as the workspace root for the LSP `initialize` call.
Single workspace per language server. If the user switches projects
mid-session the server may give stale diagnostics — acceptable for v1.

## Data flow

```
agent calls write/edit
  → pi executes tool
  → tool_result event fires
  → extension checks: is this a .go / .rs file?
  → if no server running: spawn + initialize (blocking, with timeout)
  → send didOpen (if first time) or didChange (full content)
  → wait for publishDiagnostics notification (with timeout)
  → filter to errors + warnings on the edited file
  → format as readable text
  → append to tool_result content
  → agent sees diagnostics inline
```

## Open questions

- **Diagnostic wait timeout**: how long to wait for publishDiagnostics after didChange before giving up? Gopls is fast (~100ms), rust-analyzer can be slow on large projects. Start with 3s, make configurable.
- **Multiple files per turn**: if the agent edits 3 files in one turn, each tool_result fires independently. Should be fine — each gets its own diagnostics.
- **Workspace root heuristics**: could look for go.mod / Cargo.toml to set a better root. v1 just uses cwd.
