/**
 * Memory tools: read (`memory_recall`, `memory_search`, `memory_get`) and
 * write (`memory_store`, `memory_update`, `memory_delete`, `memory_ledger`).
 *
 * Thin, typed wrappers over the ai-memory CLI. They replace the MCP server
 * surface, so every consumer (boot, per-turn recall, model tools) talks to
 * the same backend — the CLI.
 *
 * Loop policy lives in code, not prose: `memory_store` requires an explicit
 * tier (no tool default — tier is judgment) and gates writes behind a
 * dedupe probe; `memory_update` derives the integer `version` from a fresh
 * `get` and passes `--expected-version`; `memory_delete` previews until
 * `confirm: true`.
 *
 * Contract: execute never throws. Spawn/resolve failures resolve to
 * `isError: true` results, which the model sees as failed tool calls.
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type RecallMemory,
	redactPaths,
	resolveBinary,
	spawnOk,
} from "./boot.js";
import { formatLedgerRows, runLedger } from "./ledger.js";
import { queryMemories } from "./recall.js";
import { routineDue } from "./routine.js";

/** Matches the 10s spawn budget used by boot and the ledger. */
const TOOL_TIMEOUT = 10_000;
/** `search` default when the caller omits `limit` (CLI default is 20). */
const DEFAULT_SEARCH_LIMIT = 10;
/** `recall` fetches at most 5 rows (fixed CLI budget in recall.ts). */
const MAX_RECALL_ROWS = 5;
/** CLI default priority, restated here so the tool's default is explicit. */
const DEFAULT_PRIORITY = 5;
/** Dedupe probe breadth: enough candidates to catch a re-worded duplicate. */
const DEDUPE_LIMIT = 5;
/** Content preview length inside a delete gate result. */
const PREVIEW_CHARS = 600;

const BINARY_MISSING = "ai-memory binary not found (PATH + ~/.cargo/bin)";

type ToolResult = AgentToolResult<undefined>;

function textResult(text: string): ToolResult {
	return { content: [{ type: "text", text }], details: undefined };
}

function errorResult(text: string): ToolResult {
	return {
		content: [{ type: "text", text }],
		details: undefined,
		isError: true,
	};
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function clampInt(
	value: number | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Raw memory fields, kept loose: the CLI owns the schema. */
interface RawMemory {
	id?: unknown;
	title?: unknown;
	content?: unknown;
	namespace?: unknown;
	tier?: unknown;
	priority?: unknown;
	version?: unknown;
}

/**
 * `recall` uses `{ count, memories }`; `search` uses `{ count, results }`
 * (both verified live, v0.10.0). Returns null when neither array is present,
 * so callers that must tell "no rows" from "unparseable envelope" can.
 */
function parseEnvelopeRows(stdout: string): RawMemory[] | null {
	const envelope = JSON.parse(stdout) as {
		memories?: unknown;
		results?: unknown;
	} | null;
	if (typeof envelope !== "object" || envelope === null) return null;
	if (Array.isArray(envelope.results)) return envelope.results as RawMemory[];
	if (Array.isArray(envelope.memories)) return envelope.memories as RawMemory[];
	return null;
}

/** Lenient read: an unusable envelope reads as no rows. */
function parseMemories(stdout: string): RawMemory[] {
	return parseEnvelopeRows(stdout) ?? [];
}

function recallRow(m: RecallMemory): string {
	return `[${m.tier}/${m.id.slice(0, 7)}] ${m.title} (ns=${m.namespace}, score=${m.score})`;
}

/**
 * `get --json` returns `{ links, memory: {...} }` in v0.10.0 while `store`
 * and `update --json` return the bare record; accept both shapes.
 */
function unwrapMemory(stdout: string): RawMemory | null {
	const parsed = JSON.parse(stdout) as { memory?: unknown } | null;
	if (typeof parsed !== "object" || parsed === null) return null;
	const nested = parsed.memory;
	return (
		typeof nested === "object" && nested !== null ? nested : parsed
	) as RawMemory;
}

/** Optimistic-concurrency gate value: the CLI's integer `version` field. */
function versionOf(m: RawMemory | null): number | null {
	const v = m?.version;
	return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function idOf(m: RawMemory | null): string {
	return typeof m?.id === "string" ? m.id : "";
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

/** Fetch one memory (`get --json`) or throw with the CLI's message. */
async function fetchMemory(
	bin: string,
	id: string,
	signal: AbortSignal | undefined,
): Promise<RawMemory> {
	const stdout = await spawnOk(
		bin,
		["get", "--json", id],
		TOOL_TIMEOUT,
		signal,
	);
	const memory = unwrapMemory(stdout);
	if (memory === null || idOf(memory) === "") {
		throw new Error(`unexpected get output for ${id}`);
	}
	return memory;
}

function searchRow(m: RawMemory): string {
	const id = typeof m.id === "string" ? m.id : "";
	const tier = typeof m.tier === "string" ? m.tier : "long";
	const title = typeof m.title === "string" ? m.title : "";
	const namespace = typeof m.namespace === "string" ? m.namespace : "";
	const priority = typeof m.priority === "number" ? m.priority : 0;
	return `[${tier}/${id.slice(0, 7)}] ${title} (${namespace}, p=${priority})`;
}

export const memoryRecallTool = {
	name: "memory_recall",
	label: "Recall memories",
	description:
		"Recall learned ai-memory lessons relevant to a query. Uses semantic search first and falls back to keyword on failure. Use at session/task start, before non-trivial decisions, or when the user references past preferences. Query = short natural-language summary with key nouns; reword once on a miss. Boot facts are a sample only.",
	parameters: Type.Object({
		query: Type.String({
			description:
				"Short natural-language summary of what you are looking for (key nouns).",
		}),
		limit: Type.Optional(
			Type.Number({
				description: "Maximum rows to return (1-5). Defaults to 5.",
			}),
		),
	}),
	async execute(
		_toolCallId: string,
		params: { query: string; limit?: number },
		signal: AbortSignal | undefined,
	): Promise<ToolResult> {
		const query = params.query.trim();
		if (!query) return errorResult("`query` must be non-empty");
		const bin = await resolveBinary();
		if (bin === null) return errorResult(BINARY_MISSING);
		try {
			const limit = clampInt(params.limit, MAX_RECALL_ROWS, 1, MAX_RECALL_ROWS);
			const memories = (await queryMemories(bin, query, signal)).slice(
				0,
				limit,
			);
			// queryMemories rejects when both tiers fail, so an empty list here
			// is a genuine no-match — never a masked CLI failure.
			if (memories.length === 0) return textResult("No memories matched.");
			const rows = memories.map(recallRow).join("\n");
			return textResult(
				`${redactPaths(rows)}\n\n${memories.length} memory(ies) recalled`,
			);
		} catch (err) {
			return errorResult(`recall failed: ${errorMessage(err)}`);
		}
	},
};

export const memorySearchTool = {
	name: "memory_search",
	label: "Search memories",
	description:
		"Lexical (keyword) search over stored ai-memory rows. Use when recall misses or when you remember a literal term/title fragment. Returns one line per hit; use memory_get for full content.",
	parameters: Type.Object({
		query: Type.String({
			description: "Literal text, title fragment, or keyword to search for.",
		}),
		limit: Type.Optional(
			Type.Number({
				description: "Maximum rows to return (1-100). Defaults to 10.",
			}),
		),
		tier: Type.Optional(
			Type.String({
				description: "Restrict to a storage tier: short, mid, or long.",
			}),
		),
	}),
	async execute(
		_toolCallId: string,
		params: { query: string; limit?: number; tier?: string },
		signal: AbortSignal | undefined,
	): Promise<ToolResult> {
		const query = params.query.trim();
		if (!query) return errorResult("`query` must be non-empty");
		const bin = await resolveBinary();
		if (bin === null) return errorResult(BINARY_MISSING);
		const tier = params.tier?.trim();
		try {
			const limit = clampInt(params.limit, DEFAULT_SEARCH_LIMIT, 1, 100);
			const stdout = await spawnOk(
				bin,
				[
					"search",
					"--json",
					"--limit",
					String(limit),
					...(tier ? ["-t", tier] : []),
					// Positional query after `--`: a query starting with `-`
					// must be parsed as text, never as a CLI flag.
					"--",
					query,
				],
				TOOL_TIMEOUT,
				signal,
			);
			const rows = parseMemories(stdout);
			if (rows.length === 0)
				return textResult(`No memories matched "${query}".`);
			return textResult(
				redactPaths(
					`${rows.map(searchRow).join("\n")}\n\n${rows.length} memory(ies) found`,
				),
			);
		} catch (err) {
			return errorResult(`search failed: ${errorMessage(err)}`);
		}
	},
};

export const memoryGetTool = {
	name: "memory_get",
	label: "Get memory",
	description:
		"Fetch one stored ai-memory memory by id and return its full JSON (title, content, namespace, tier, priority, integer version, timestamps). Use before updating or deleting, or after recall/search names the id.",
	parameters: Type.Object({
		id: Type.String({ description: "Memory id (UUID) from recall/search." }),
	}),
	async execute(
		_toolCallId: string,
		params: { id: string },
		signal: AbortSignal | undefined,
	): Promise<ToolResult> {
		const id = params.id.trim();
		if (!id) return errorResult("`id` must be non-empty");
		const bin = await resolveBinary();
		if (bin === null) return errorResult(BINARY_MISSING);
		try {
			const stdout = await spawnOk(
				bin,
				["get", "--json", id],
				TOOL_TIMEOUT,
				signal,
			);
			const text = stdout.trim();
			if (!text) return errorResult(`memory ${id} returned no content`);
			return textResult(redactPaths(text));
		} catch (err) {
			return errorResult(`get ${id} failed: ${errorMessage(err)}`);
		}
	},
};

/** Tier guidance is policy: it belongs in the schema, not in AGENTS.md prose. */
const TIER_GUIDANCE =
	"Lifetime bucket — judgment, never habit. `short`: throwaway task-scoped notes. `mid`: project/session-scoped memory that expires. `long`: never-repeat corrections, standing directives, cross-session lessons. Required on purpose: there is no default. If you are genuinely unsure which tier applies, ask the user — never guess.";

export const memoryStoreTool = {
	name: "memory_store",
	label: "Store memory",
	description:
		"Store a learned ai-memory lesson. Enforces the loop's write discipline: tier is required (pick by lifetime, ask the user when unsure), priority defaults to 5, and unless `confirm: true` a dedupe probe runs first — on hits the call returns candidate ids and stores nothing, so you recall, merge, and re-call. Use for corrections, decisions, and what does not work; not project trivia.",
	parameters: Type.Object({
		title: Type.String({
			description: "Short, scannable title (the scan target on later recalls).",
		}),
		content: Type.String({
			description:
				"AAK-sealed body: the lesson and what to do next time. Atomic — one lesson per memory.",
		}),
		tier: Type.Union(
			[Type.Literal("short"), Type.Literal("mid"), Type.Literal("long")],
			{
				description: TIER_GUIDANCE,
			},
		),
		priority: Type.Optional(
			Type.Number({
				description: "Importance 0-10. Defaults to 5.",
			}),
		),
		tags: Type.Optional(
			Type.Array(Type.String(), {
				description: "Free-form tags, passed to the CLI comma-joined.",
			}),
		),
		confirm: Type.Optional(
			Type.Boolean({
				description:
					"Set true only after the dedupe gate returned candidates you checked (recalled and merged). Skips the probe.",
			}),
		),
	}),
	async execute(
		_toolCallId: string,
		params: {
			title: string;
			content: string;
			tier: "short" | "mid" | "long";
			priority?: number;
			tags?: string[];
			confirm?: boolean;
		},
		signal: AbortSignal | undefined,
	): Promise<ToolResult> {
		const title = params.title.trim();
		const content = params.content.trim();
		if (!title) return errorResult("`title` must be non-empty");
		if (!content) return errorResult("`content` must be non-empty");
		const bin = await resolveBinary();
		if (bin === null) return errorResult(BINARY_MISSING);

		const priority =
			typeof params.priority === "number" && Number.isFinite(params.priority)
				? Math.trunc(params.priority)
				: DEFAULT_PRIORITY;
		const tags = (params.tags ?? []).filter(
			(tag) => typeof tag === "string" && tag.trim() !== "",
		);

		// Dedupe gate. Advisory by design (title-keyword probe, not semantic),
		// so a failing probe must not block a legitimate store: it proceeds
		// unconfirmed and the result says so.
		let probeNote = "";
		if (params.confirm !== true) {
			let candidates: RawMemory[] = [];
			let probeFailed = false;
			try {
				const stdout = await spawnOk(
					bin,
					["search", "--json", "--limit", String(DEDUPE_LIMIT), "--", title],
					TOOL_TIMEOUT,
					signal,
				);
				const rows = parseEnvelopeRows(stdout);
				// A malformed envelope is a failed probe, not a clean no-hit:
				// storing unconfirmed must be annotated, never silent.
				if (rows === null) probeFailed = true;
				else candidates = rows;
			} catch {
				probeFailed = true;
			}
			if (candidates.length > 0) {
				const rows = candidates.map(searchRow).join("\n");
				return errorResult(
					`Possible duplicate(s) for "${title}" — nothing was stored:\n${rows}\n\nRecall the candidates above (memory_get for full content), merge or update instead of piling up, and only then re-call memory_store with confirm: true.`,
				);
			}
			if (probeFailed) {
				probeNote = "\n\n(dedupe probe failed; stored unconfirmed)";
			}
		}

		try {
			const stdout = await spawnOk(
				bin,
				[
					"store",
					"-T",
					title,
					"-c",
					content,
					"-t",
					params.tier,
					"-p",
					String(priority),
					...(tags.length > 0 ? ["--tags", tags.join(",")] : []),
					"--json",
				],
				TOOL_TIMEOUT,
				signal,
			);
			const stored = unwrapMemory(stdout);
			const id = idOf(stored);
			if (!id) {
				return errorResult(
					`store succeeded but returned no id: ${stdout.trim()}`,
				);
			}
			const version = versionOf(stored);
			return textResult(
				redactPaths(
					`stored [${str(stored?.tier, params.tier)}/${id.slice(0, 7)}] ${str(stored?.title, title)} (ns=${str(stored?.namespace, "cwd")}, p=${priority}${version === null ? "" : `, version=${version}`})`,
				) + probeNote,
			);
		} catch (err) {
			return errorResult(`store failed: ${errorMessage(err)}`);
		}
	},
};

export const memoryUpdateTool = {
	name: "memory_update",
	label: "Update memory",
	description:
		"Update an existing ai-memory memory by id. Fetches the row first and passes its integer version as `--expected-version`, so a stale read fails with a version conflict instead of silently overwriting someone else's edit. Use to merge duplicates and fix stale entries — never store a corrected copy alongside the old one.",
	parameters: Type.Object({
		id: Type.String({
			description: "Memory id (UUID) from recall/search/get.",
		}),
		title: Type.Optional(Type.String({ description: "New title." })),
		content: Type.Optional(Type.String({ description: "New content." })),
		namespace: Type.Optional(Type.String({ description: "New namespace." })),
		priority: Type.Optional(Type.Number({ description: "New priority 0-10." })),
	}),
	async execute(
		_toolCallId: string,
		params: {
			id: string;
			title?: string;
			content?: string;
			namespace?: string;
			priority?: number;
		},
		signal: AbortSignal | undefined,
	): Promise<ToolResult> {
		const id = params.id.trim();
		if (!id) return errorResult("`id` must be non-empty");
		const title = typeof params.title === "string" ? params.title.trim() : "";
		const content =
			typeof params.content === "string" ? params.content.trim() : "";
		const namespace =
			typeof params.namespace === "string" ? params.namespace.trim() : "";
		const hasPriority =
			typeof params.priority === "number" && Number.isFinite(params.priority);
		if (!title && !content && !namespace && !hasPriority) {
			return errorResult(
				"nothing to update: pass at least one of `title`, `content`, `namespace`, `priority`",
			);
		}
		const bin = await resolveBinary();
		if (bin === null) return errorResult(BINARY_MISSING);

		let current: RawMemory;
		try {
			current = await fetchMemory(bin, id, signal);
		} catch (err) {
			return errorResult(
				`update ${id} aborted, get failed: ${errorMessage(err)}`,
			);
		}
		const version = versionOf(current);
		if (version === null) {
			return errorResult(
				`update ${id} aborted: get returned no integer \`version\` to gate on`,
			);
		}

		try {
			const stdout = await spawnOk(
				bin,
				[
					"update",
					"--json",
					...(title ? ["--title", title] : []),
					...(content ? ["--content", content] : []),
					...(namespace ? ["-n", namespace] : []),
					...(hasPriority
						? ["-p", String(Math.trunc(params.priority ?? 0))]
						: []),
					"--expected-version",
					String(version),
					id,
				],
				TOOL_TIMEOUT,
				signal,
			);
			const updated = unwrapMemory(stdout);
			const newVersion = versionOf(updated);
			const newTitle = str(updated?.title, title || str(current.title));
			const newTier = str(updated?.tier, str(current.tier, "long"));
			return textResult(
				redactPaths(
					`updated [${newTier}/${id.slice(0, 7)}] ${newTitle} — version ${version} -> ${newVersion === null ? "unknown" : newVersion}`,
				),
			);
		} catch (err) {
			return errorResult(`update ${id} failed: ${errorMessage(err)}`);
		}
	},
};

export const memoryDeleteTool = {
	name: "memory_delete",
	label: "Delete memory",
	description:
		"Delete an ai-memory memory by id, two-phase. Without `confirm` it returns the row's title and content preview and deletes nothing; call the user first, then re-call with `confirm: true`. Each call is a fresh two-phase decision — no gate state is carried. Use for duplicates and wrong lessons; `forget`/`gc` stay CLI-manual.",
	parameters: Type.Object({
		id: Type.String({ description: "Memory id (UUID) to delete." }),
		confirm: Type.Optional(
			Type.Boolean({
				description:
					"Set true only after the user explicitly approved deleting this row. Omitted = preview only.",
			}),
		),
	}),
	async execute(
		_toolCallId: string,
		params: { id: string; confirm?: boolean },
		signal: AbortSignal | undefined,
	): Promise<ToolResult> {
		const id = params.id.trim();
		if (!id) return errorResult("`id` must be non-empty");
		const bin = await resolveBinary();
		if (bin === null) return errorResult(BINARY_MISSING);

		if (params.confirm !== true) {
			let current: RawMemory;
			try {
				current = await fetchMemory(bin, id, signal);
			} catch (err) {
				return errorResult(
					`delete ${id} aborted, get failed: ${errorMessage(err)}`,
				);
			}
			const body = str(current.content);
			const preview =
				body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}…` : body;
			return errorResult(
				redactPaths(
					`Delete preview for ${id} — nothing was deleted:\n[${str(current.tier, "long")}/${id.slice(0, 7)}] ${str(current.title)} (ns=${str(current.namespace)}, p=${typeof current.priority === "number" ? current.priority : 0})\n\ncontent:\n${preview}\n\nShow this to the user and re-call memory_delete with confirm: true only after they approve.`,
				),
			);
		}

		try {
			const stdout = await spawnOk(
				bin,
				["delete", "--json", id],
				TOOL_TIMEOUT,
				signal,
			);
			const parsed = JSON.parse(stdout) as { deleted?: unknown; id?: unknown };
			if (parsed?.deleted !== true) {
				return errorResult(
					`delete ${id} returned unexpected output: ${stdout.trim()}`,
				);
			}
			return textResult(`deleted ${str(parsed.id, id)}`);
		} catch (err) {
			return errorResult(`delete ${id} failed: ${errorMessage(err)}`);
		}
	},
};

export const memoryLedgerTool = {
	name: "memory_ledger",
	label: "Memory ledger",
	description:
		'List memories by `updated_at` since a date (newest first) across namespaces — the self-improvement routine\'s "what changed since <date>" view. `since` defaults to the last completed routine run when known; pass it explicitly when it is not. Use to pick lessons for dedupe/merge before storing.',
	parameters: Type.Object({
		since: Type.Optional(
			Type.String({
				description:
					"Inclusive lower bound, YYYY-MM-DD. Defaults to the last routine run; required when no state file exists.",
			}),
		),
		namespaces: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Namespaces to scan (default: the CLI's cwd-inferred namespace only).",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: "Rows per namespace (1-500). Defaults to 50.",
			}),
		),
	}),
	async execute(
		_toolCallId: string,
		params: { since?: string; namespaces?: string[]; limit?: number },
		signal: AbortSignal | undefined,
	): Promise<ToolResult> {
		let since = typeof params.since === "string" ? params.since.trim() : "";
		if (!since) {
			// Last completed routine run is the natural default; a missing or
			// unreadable state file must ask rather than guess a date.
			let lastRun: string | null = null;
			try {
				lastRun = (await routineDue()).lastRun;
			} catch {
				lastRun = null;
			}
			if (lastRun === null) {
				return errorResult(
					"`since` is required: no last-run date is recorded (YYYY-MM-DD)",
				);
			}
			since = lastRun;
		}
		const bin = await resolveBinary();
		if (bin === null) return errorResult(BINARY_MISSING);
		try {
			const outcome = await runLedger(
				bin,
				{ since, namespaces: params.namespaces, limit: params.limit },
				signal,
			);
			if (!outcome.ok) {
				return errorResult(
					`ledger failed: ${outcome.error ?? "unknown error"}`,
				);
			}
			if (outcome.rows.length === 0 && outcome.notes.length === 0) {
				return textResult(`No memories updated since ${since}.`);
			}
			return textResult(
				redactPaths(
					`${formatLedgerRows(outcome.rows, outcome.notes)}\n\n${outcome.rows.length} memory(ies) since ${since}`,
				),
			);
		} catch (err) {
			return errorResult(`ledger failed: ${errorMessage(err)}`);
		}
	},
};
