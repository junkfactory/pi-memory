# pi-memory

Pi extension injecting [ai-memory](https://github.com/alphaonedev/ai-memory-mcp) boot context into every pi session's system prompt at the first agent turn.

```text
┌─────────────┐   execFile (turn 0)   ┌──────────────┐
│  pi (TUI)   │ ────────────────────► │ ai-memory    │
│  + ext      │ ◄──────────────────── │ boot --quiet │
└─────────────┘    boot context       └──────────────┘
```

Store/recall stay on the `ai-memory` CLI (usage guidance is injected into each session's system prompt); this extension only handles session boot injection.

## Install

```bash
pi install git:github.com/junkfactory/pi-memory
```

Requires the `ai-memory` CLI on PATH. Missing binary or empty DB → nothing is injected (fail soft).

## Behaviour

- Injects `ai-memory boot --quiet` output into the system prompt under `# ai-memory boot` on every agent turn where the block is absent. Pi resets extension system-prompt changes at the start of each turn and compaction never re-fires `session_start`, so one-shot-per-session injection silently disappears from turn 1 onward — re-injecting keeps the block present across turns, after compaction, and picks up memory state changes mid-session.
- Skips injection when the block is already present (guards against `ai-memory wrap` double-injection and avoids duplicating the persisted override from the previous turn).
- A `# Memory usage` section (recall/store discipline; the agent-facing contract for the CLI) follows the boot facts — this package owns that guidance, so project AGENTS.md files don't have to.
- A failed or empty boot retries on the next turn (transient failures self-heal).
- Per-prompt recall runs `ai-memory recall -T semantic` (cosine scores); a healthy no-match is final, and keyword tier is used only as the fallback when the semantic call fails. The semantic score floor defaults to 0.5 and can be overridden live with `PI_MEMORY_SEMANTIC_FLOOR` (a number in [0,1], read at each recall call; invalid values fall back to 0.5).

## Self-improvement loop

The extension backs an agent self-improvement routine end to end:

- **Routine trigger** — state lives in `~/.pi/agent/pi-memory/last-run.txt` (legacy `~/.pi/agent/self-improve/last-run.txt` is seeded once and never written). When the stored date is older than today, the boot section gains: `# self-improvement: routine due (last run: <date | "never">) — run the AGENTS.md routine first`. The extension never stamps the file; a completed routine stamps it.
- **Seven model tools** (replacing the former MCP surface — the CLI stays the integration target for other harnesses), all wrapping the ai-memory CLI with `isError`-not-throw failure contracts: `memory_recall` (per-turn recall shared core), `memory_search`, `memory_get`, `memory_store` (tier required: short|mid|long — no tool default; dedupe pre-probe gate unless `confirm: true`), `memory_update` (fetches first, derives the integer `--expected-version` itself), `memory_delete` (two-phase gate: preview → `confirm: true` only after user approval), `memory_ledger` (entries since the last routine run — the review input).
- **Global lessons in boot** — besides the cwd-namespace pass, the extension merges global-namespace rows (id-deduped, best-effort) so universal discipline rides into every project regardless of cwd.

## Development

```bash
npm install
npx vitest run   # tests (execFile mocked)
pi -e ./         # try without installing
```
