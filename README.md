# pi-lsp-lite

Tightly scoped [pi](https://github.com/mariozechner/pi) extension that surfaces LSP
diagnostics to the agent on every `write` and `edit`. Starts with Go and Rust.

## Scope

**Does:**
- Spawns long-lived `gopls` / `rust-analyzer` subprocesses on demand
- Sends document open/change notifications after each `write` / `edit` tool result
- Appends `publishDiagnostics` (errors + warnings) for the edited file to the tool result so the agent sees them on the same turn
- Idle-shuts-down language servers; cleans up on session end
- `/lsp-status` command for visibility

**Explicitly does not:**
- Auto-install language servers (you bring `gopls` and `rust-analyzer` on PATH)
- Block edits on diagnostics (pure feedback, agent decides)
- Format, autofix, secrets-scan, or read-guard
- Touch any language other than Go and Rust (yet)

## Install

```bash
# From git
pi install git:github.com/mcphailtom/pi-lsp-lite

# Local dev
pi install /path/to/pi-lsp-lite
```

Requires `gopls` and/or `rust-analyzer` on `PATH`.

## Status

Early scaffold. Not yet functional.
