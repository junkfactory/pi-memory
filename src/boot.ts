import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { routineDue } from "./routine.js";

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
- Recall via \`memory_recall\` tool (not Bash) at session/task start, before non-trivial decisions, past-decision references, or user setup/preference questions. Query = short natural-language summary with key nouns; reword once on a miss. Boot facts are a sample only — recall before concluding nothing is stored.
- When you make a mistake, get corrected, or discover what doesn't work, STORE the lesson via \`memory_store\` tool before finishing the reply — what to do (or not do) next time, so you never repeat the mistake. Not project trivia. Atomic, deduped (fix stale entries via \`memory_update\` tool, never pile up). Namespace: global / snake_case cwd / task. Dedupe via \`memory_store\` confirm gate; deletions via \`memory_delete\` — preview first, confirm:true only after the user approves.
- Tier: short = task throwaway, mid = expiring project memory, long = never-repeat lessons — \`memory_store\` requires an explicit tier; pick by lifetime, never by habit; if unsure, ask the user — never guess.
- MUST NOT read/edit ai-memory config or db directly. Destructive ops (delete/forget/gc): confirm with the user first.`;

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

/** A boot row: `- [tier/id7] title (ns, priority, updated)`. */
const BOOT_ROW = /^- \[/;
const ROW_ID = /^- \[[^/\]]+\/([^\]]+)\]/;

function rowId(line: string): string | null {
	const match = ROW_ID.exec(line);
	return match ? match[1].slice(0, 7) : null;
}

/**
 * Append the `global` namespace's rows to the boot body: after the cwd rows,
 * before anything else. Rows already shown by the cwd pass are dropped, and a
 * failing or empty global pass returns the body untouched — this must never
 * make boot worse.
 */
async function mergeGlobalRows(body: string, bin: string): Promise<string> {
	let globalOut: string;
	try {
		globalOut = await spawnOk(
			bin,
			["boot", "--quiet", "--namespace", "global", "--limit", "20"],
			10_000,
		);
	} catch {
		return body;
	}

	const lines = body.split("\n");
	const seen = new Set<string>();
	let lastRow = -1;
	lines.forEach((line, i) => {
		if (!BOOT_ROW.test(line)) return;
		lastRow = i;
		const id = rowId(line);
		if (id) seen.add(id);
	});

	const extra: string[] = [];
	for (const line of globalOut.split("\n")) {
		if (!BOOT_ROW.test(line)) continue;
		const id = rowId(line);
		if (id && seen.has(id)) continue;
		if (id) seen.add(id);
		extra.push(line.trimEnd());
	}
	if (extra.length === 0) return body;

	// An empty cwd body must not leave a leading blank line before the
	// global rows (the empty-cwd boot case still merges).
	const at = lastRow === -1 ? (body.trim() ? lines.length : 0) : lastRow + 1;
	return [...lines.slice(0, at), ...extra, ...lines.slice(at)].join("\n");
}

/** Routine-state locations; tests point them at a tmpdir, prod takes the defaults. */
export interface RoutineStatePaths {
	statePath?: string;
	legacyPath?: string;
	today?: string;
}

/**
 * Append the routine-due line to the boot body. A state-file error drops the
 * line only: the section is worth more than the reminder. Composed before
 * redaction so the line lives inside the same block as the boot rows.
 */
async function withRoutineDue(
	body: string,
	paths: RoutineStatePaths,
): Promise<string> {
	try {
		const { due, lastRun } = await routineDue(
			paths.statePath,
			paths.legacyPath,
			paths.today,
		);
		if (!due) return body;
		return `${body}\n# self-improvement: routine due (last run: ${lastRun ?? "never"}) — run the AGENTS.md routine first`;
	} catch {
		return body;
	}
}

/**
 * Run `ai-memory boot --quiet` and return the formatted system-prompt
 * section, or null when there is nothing to inject (missing binary,
 * non-zero exit, and no usable cwd or global rows). Never throws.
 */
export async function bootSection(
	routinePaths: RoutineStatePaths = {},
): Promise<string | null> {
	let stdout: string;
	let bin = "ai-memory";
	try {
		stdout = await spawnOk(bin, ["boot", "--quiet"], 10_000);
	} catch (err) {
		try {
			bin = FALLBACK_BIN;
			stdout = await spawnOk(bin, ["boot", "--quiet"], 10_000);
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
	// The global pass runs even when the cwd pass is empty: a cwd namespace
	// with no rows must not hide the global rows. Null only when both
	// sources produce nothing usable.
	const merged = await mergeGlobalRows(stdout.trim(), bin);
	if (!merged.trim()) return null;
	const body = await withRoutineDue(merged, routinePaths);
	return `\n\n${BOOT_MARKER}\n${redactPaths(body)}\n${OPS}`;
}
