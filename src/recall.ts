/**
 * Per-turn automatic recall: ask ai-memory for memories relevant to the
 * current user prompt and format them as an ephemeral context block.
 *
 * Primary tier is semantic (cosine scores, 0-1): learned lessons share
 * vocabulary with the future prompt only rarely, so lexical recall misses
 * exactly the self-improvement memories this extension exists to resurface.
 * Falls back to keyword on a semantic failure (spawn, exit non-zero, or
 * unparseable output).
 */

import {
	type RecallMemory,
	redactPaths,
	resolveBinary,
	spawnOk,
} from "./boot.js";

const QUERY_LIMIT = 300;
/**
 * Cosine-similarity floor for the semantic tier. Initial guess 0.5;
 * recalibrate on a populated DB. Overridable via `PI_MEMORY_SEMANTIC_FLOOR`,
 * re-read per recall call and clamped to [0, 1].
 */
function semanticFloor(): number {
	const raw = process.env.PI_MEMORY_SEMANTIC_FLOOR;
	const floor = raw === undefined || raw === "" ? NaN : Number(raw);
	if (Number.isNaN(floor)) return 0.5;
	return Math.min(1, Math.max(0, floor));
}
/** Keyword-scale floor (keyword scores are 0-100-ish), for the fallback path only. */
const KEYWORD_FLOOR = 5.0;
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
 * Run `recall -T <tier>` and filter by that tier's score scale. Tier is a
 * format override on the invocation — NOT the memory's storage tier.
 * Resolves to the surviving memories (possibly empty — a healthy no-match)
 * or throws on spawn/parse failure.
 */
async function queryTier(
	bin: string,
	tier: "semantic" | "keyword",
	floor: number,
	query: string,
	signal?: AbortSignal,
): Promise<RecallMemory[]> {
	const stdout = await spawnOk(
		bin,
		[
			"recall",
			"-T",
			tier,
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
	if (!Array.isArray(envelope.memories)) return [];
	return (envelope.memories as RecallMemory[]).filter(
		(m) => typeof m.score === "number" && m.score >= floor,
	);
}

/**
 * Query ai-memory for `query` and return the memories clearing their tier's
 * score floor. Semantic is tried first; keyword runs only when semantic
 * fails outright (spawn, non-zero exit, malformed output) — a healthy
 * semantic no-match is final, because semantic subsumes lexical matching and
 * keyword would only add noise.
 *
 * Both floors live here so every consumer (per-turn recall, the
 * `memory_recall` tool) shares identical miss semantics. Resolves to the
 * survivors (possibly empty — a healthy no-match); rejects when BOTH tiers
 * fail, so a broken CLI is never reported as a clean no-match. Warns at
 * most once per process.
 */
export async function queryMemories(
	bin: string,
	query: string,
	signal?: AbortSignal,
): Promise<RecallMemory[]> {
	try {
		return await queryTier(bin, "semantic", semanticFloor(), query, signal);
	} catch (err) {
		// Semantic tier unavailable (embedder failure, bad exit, malformed
		// output); fall through to keyword.
		warnOnce(err);
	}
	try {
		return await queryTier(bin, "keyword", KEYWORD_FLOOR, query, signal);
	} catch (err) {
		// Total failure: surface it instead of masking it as no-match.
		warnOnce(err);
		throw err;
	}
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

	const bin = await resolveBinary();
	if (bin === null) {
		warnOnce(new Error("binary not found (PATH + ~/.cargo/bin)"));
		return null;
	}

	// Per-turn recall is best-effort: a total query failure (both tiers)
	// drops the block only, never the turn.
	let memories: RecallMemory[];
	try {
		memories = await queryMemories(bin, query, signal);
	} catch {
		return null;
	}
	return memories.length > 0 ? format(memories) : null;
}
