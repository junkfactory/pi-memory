import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const BOOT_MARKER = "# ai-memory boot";

/** Subset of the `ai-memory recall --json` memory shape used by recall.ts. */
export interface RecallMemory {
	score: number;
	id: string;
	title: string;
	content: string;
	namespace: string;
	tier: string;
}

/** Matches the boot header's db line regardless of leading decoration ("#   db: …", "db: …"). */
const DB_LINE = /^\s*#*\s*db:/;

/**
 * Strip operator-local paths from boot output before injecting: agents
 * should know what they know, not where it lives (and be tempted to edit
 * the database or config directly).
 */
export function redactPaths(text: string): string {
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
- Recall via the \`memory_recall\` MCP tool (not Bash) at session/task start, before non-trivial decisions, when a past decision is referenced, when the user asks about their setup/preferences/past conversations, and before storing. Query = short natural-language summary with key nouns, not the raw message; reword once if a recall misses.
- Store atomic facts; dedupe before storing. Use \`--tier long\` for never-repeat corrections. Fix stale entries with \`update <id>\`, never pile up duplicates.
- Boot facts are a small sample, NOT the full memory — never conclude nothing is stored without recalling.
- Namespaces: global (system-wide), snake_case cwd (project), task name (continuation). Tiers: mid expires, long retains.
- MUST NOT read/access ai-memory configuration file; ask permission before doing so and state the reason
- MUST NOT edit ai-memory db directly
- Destructive ops (delete/forget/gc): confirm with the user first`;

const FALLBACK_BIN = join(homedir(), ".cargo", "bin", "ai-memory");

let warnedSpawn = false;

/** Run `bin args` and return stdout. Rejects when the spawn fails or exits non-zero. */
export async function spawnOk(
	bin: string,
	args: string[],
	timeout: number,
	signal?: AbortSignal,
): Promise<string> {
	const { stdout } = await run(bin, args, { timeout, signal });
	return stdout;
}

const NEGATIVE_TTL_MS = 60_000;
let cachedBinary: string | null | undefined; // undefined = never probed
let cachedAt = 0;

// Test hook: module cache would otherwise leak between test cases.
export function resetBinaryCache(): void {
	cachedBinary = undefined;
	cachedAt = 0;
}

/**
 * First usable ai-memory binary: bare `ai-memory` (PATH), then
 * `~/.cargo/bin/ai-memory`. Null when neither spawns. Never throws.
 *
 * A positive result is cached for the process (the resolved path won't
 * change under us); a miss is cached for 60 s only, so a fresh install
 * self-heals without paying two failed ENOENT probes per recall call.
 */
export async function resolveBinary(): Promise<string | null> {
	if (cachedBinary) return cachedBinary;
	if (cachedBinary === null && Date.now() - cachedAt < NEGATIVE_TTL_MS) {
		return null;
	}
	for (const bin of ["ai-memory", FALLBACK_BIN]) {
		try {
			await spawnOk(bin, ["--version"], 5_000);
			cachedBinary = bin;
			cachedAt = Date.now();
			return bin;
		} catch {
			// try next candidate
		}
	}
	cachedBinary = null;
	cachedAt = Date.now();
	return null;
}

/**
 * Run `ai-memory boot --quiet` and return the formatted system-prompt
 * section, or null when there is nothing to inject (missing binary,
 * non-zero exit, empty output). Never throws.
 */
export async function bootSection(): Promise<string | null> {
	let stdout: string;
	try {
		stdout = await spawnOk("ai-memory", ["boot", "--quiet"], 10_000);
	} catch (err) {
		try {
			stdout = await spawnOk(FALLBACK_BIN, ["boot", "--quiet"], 10_000);
		} catch {
			if (!warnedSpawn) {
				warnedSpawn = true;
				console.warn(
					"[pi-memory] `ai-memory` spawn failed (PATH + ~/.cargo/bin) — boot context skipped:",
					err instanceof Error ? err.message : err,
				);
			}
			return null;
		}
	}
	const text = stdout.trim();
	if (!text) return null;
	return `\n\n${BOOT_MARKER}\n${redactPaths(text)}\n${OPS}`;
}
