import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const BOOT_MARKER = "# ai-memory boot";

/** Matches the boot header's db line regardless of leading decoration ("#   db: …", "db: …"). */
const DB_LINE = /^\s*#*\s*db:/;

/**
 * Strip operator-local paths from boot output before injecting: agents
 * should know what they know, not where it lives (and be tempted to edit
 * the database or config directly).
 */
function redactPaths(text: string): string {
  return text
    .split("\n")
    .filter((line) => !DB_LINE.test(line))
    .join("\n");
}

/**
 * Memory usage guidance injected alongside boot facts. By contract, this
 * package owns the agent-facing discipline for ai-memory — AGENTS.md does
 * not duplicate it.
 */
const OPS = `# Memory usage
When to recall: session/project start, before non-trivial decisions, when a past decision is referenced, before storing. Skip: trivial edits, info already grounded in context, same-session continuations.
When to store proactively: learnings, preferences, decisions, corrections, mistakes that should never be repeated. Dedupe before storing; store atomic facts.

- Recall relevant memory: \`ai-memory recall "<context>"\` (fuzzy/ranked); \`search "<text>"\` only for exact wording. \`-n <ns>\` to scope, \`--limit\` to cap, \`--format toon\` to save tokens
- Store atomic facts: \`ai-memory store --title "..." --content "..." [--tier long]\` (default tier \`mid\` expires). Dedupe first via \`check-duplicate --title ... --content ...\`
- Correct with \`update <id>\` — never pile near-duplicates on stale memories
- Inspect: \`list\` / \`get <id>\` / \`stats\`
- Destructive (\`delete\`, \`forget\`, \`gc\`) — confirm with user first

## Namespace and Tiers
Use table below to guide when to use namespace and tiers
| When | Namespace | Tier |
|------|-----------|------|
| System-wide, non-project, non-task memory | global | mid |
| Project-specific code/decisions | snake_case cwd (e.g. pi_memory) | mid |
| "Never repeat this mistake" correction | same namespace as context | long |
| Continuation or task-related | task name | mid |
| Unsure | ask user | — |

## Non-negotiables
- MUST NOT read/access ai-memory configuration file; ask permission if before doing so and state the reason
- MUST NOT edit ai-memory db directly`;

/**
 * Run `ai-memory boot --quiet` and return the formatted system-prompt
 * section, or null when there is nothing to inject (missing binary,
 * non-zero exit, empty output). Never throws.
 */
export async function bootSection(): Promise<string | null> {
  try {
    const { stdout } = await run("ai-memory", ["boot", "--quiet"], {
      timeout: 10_000
    });
    const text = stdout.trim();
    if (!text) return null;
    return `\n\n${BOOT_MARKER}\n${redactPaths(text)}\n${OPS}`;
  } catch {
    return null;
  }
}
