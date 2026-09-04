# pi-memory

Pi extension injecting [ai-memory](https://github.com/alphaonedev/ai-memory-mcp) boot context into every pi session's system prompt at the first agent turn.

```text
┌─────────────┐   execFile (turn 0)   ┌──────────────┐
│  pi (TUI)   │ ────────────────────► │ ai-memory    │
│  + ext      │ ◄──────────────────── │ boot --quiet │
└─────────────┘    boot context       └──────────────┘
```

Store/recall stay on the `ai-memory` CLI (see your AGENTS.md `### Memory Ops`); this extension only handles session boot injection.

## Install

```bash
pi install git:github.com/junkfactory/pi-memory
```

Requires the `ai-memory` CLI on PATH. Missing binary or empty DB → nothing is injected (fail soft).

## Behaviour

- Injects `ai-memory boot --quiet` output once per session, appended to the system prompt under `# ai-memory boot`.
- Re-boots on new/resumed/forked sessions (memory state may have changed).
- Skips injection if boot output is already present (guards against `ai-memory wrap` double-injection).
- A `# Memory usage` section (recall/store discipline; the agent-facing contract for the CLI) follows the boot facts — this package owns that guidance, so project AGENTS.md files don't have to.
- A failed or empty boot is not retried within the same session.

## Development

```bash
npm install
npx vitest run   # tests (execFile mocked)
pi -e ./         # try without installing
```
