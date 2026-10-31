/**
 * Per-turn automatic recall: ask ai-memory for memories relevant to the
 * current user prompt and format them as an ephemeral context block.
 */

import {
	type RecallMemory,
	redactPaths,
	resolveBinary,
	spawnOk,
} from "./boot.js";

const QUERY_LIMIT = 300;
const SCORE_FLOOR = 5.0;
const RECALL_TIMEOUT = 5_000;

let warnedRecall = false;

function warnOnce(err: unknown): void {
	if (warnedRecall) return;
	warnedRecall = true;
	console.warn(
		"[pi-memory] `ai-memory recall` failed — recall skipped:",
		err instanceof Error ? err.message : err,
	);
}

function format(memories: RecallMemory[]): string {
	const entries = memories.map(
		(m) =>
			`[${m.tier}/${m.id}] ${m.title} (ns=${m.namespace}, score=${m.score})\n${m.content}`,
	);
	const body = `<ai-memory recall>\n${entries.join("\n\n")}\n${memories.length} memory(ies) recalled\n</ai-memory recall>`;
	return redactPaths(body);
}

/**
 * Recall memories for `prompt` and return a formatted `<ai-memory recall>`
 * block, or null when nothing clears the score floor, the DB has no match,
 * or the CLI fails. Never throws; warns at most once per process.
 */
export async function recallForPrompt(
	prompt: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const query = prompt.trim().slice(0, QUERY_LIMIT);
	if (!query) return null;

	try {
		const bin = await resolveBinary();
		if (bin === null) {
			warnOnce(new Error("binary not found (PATH + ~/.cargo/bin)"));
			return null;
		}
		const stdout = await spawnOk(
			bin,
			[
				"recall",
				"-T",
				"keyword",
				"--limit",
				"5",
				"--budget-tokens",
				"300",
				"--json",
				// Guards the positional query: a prompt starting with `-` must
				// be parsed as text, never as a CLI flag.
				"--",
				query,
			],
			RECALL_TIMEOUT,
			signal,
		);
		const envelope = JSON.parse(stdout) as {
			count?: unknown;
			memories?: unknown;
		};
		if (envelope.count === 0) return null;
		if (!Array.isArray(envelope.memories)) return null;
		const survivors = (envelope.memories as RecallMemory[]).filter(
			(m) => typeof m.score === "number" && m.score >= SCORE_FLOOR,
		);
		if (survivors.length === 0) return null;
		return format(survivors);
	} catch (err) {
		warnOnce(err);
		return null;
	}
}
