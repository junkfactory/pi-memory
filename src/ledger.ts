/**
 * Memory ledger: a flat, time-ordered view of `ai-memory list --json`.
 *
 * The self-improvement routine needs "what changed since <date>" across
 * namespaces. The CLI scopes `list` to one namespace per spawn (cwd
 * inference or `-n`), so the ledger fans out per namespace, concatenates,
 * and sorts the merged rows newest-first. A failing namespace degrades the
 * result to a partial ledger with a note — one broken scope must not hide
 * every other scope's lessons.
 *
 * Public API never throws: callers (the `memory_ledger` tool) surface
 * `{ ok: false, error }` as an `isError` tool result.
 */

import { spawnOk } from "./boot.js";

/** Matches the tool's 10s spawn budget in the extension. */
const LEDGER_TIMEOUT = 10_000;
const DEFAULT_LIMIT = 50;
/** CLI-side cap (`--limit`); larger values buy nothing here. */
const MAX_LIMIT = 500;

export interface LedgerOptions {
	/** Inclusive lower bound on `updated_at` (`YYYY-MM-DD`). */
	since: string;
	/** Explicit namespaces; omitted/empty = CLI cwd inference (single spawn). */
	namespaces?: string[];
	/** Per-spawn row cap, clamped to [1, 500]. */
	limit?: number;
}

/** One memory as shown in the ledger (subset of the `list --json` fields). */
export interface LedgerRow {
	id: string;
	title: string;
	namespace: string;
	tier: string;
	priority: number;
	updatedAt: string;
}

export interface LedgerOutcome {
	ok: boolean;
	rows: LedgerRow[];
	/** Non-fatal degradations (e.g. one namespace failed), one line each. */
	notes: string[];
	error?: string;
}

/** Raw `list --json` memory fields, kept loose: the CLI owns the schema. */
interface RawMemory {
	id?: unknown;
	title?: unknown;
	namespace?: unknown;
	tier?: unknown;
	priority?: unknown;
	updated_at?: unknown;
}

function clampLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) {
		return DEFAULT_LIMIT;
	}
	return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** `-n <ns>` is optional: no namespace means the CLI's cwd inference. */
function listArgs(since: string, limit: number, namespace?: string): string[] {
	return [
		"list",
		"--json",
		"--since",
		since,
		"--limit",
		String(limit),
		...(namespace ? ["-n", namespace] : []),
	];
}

/** Envelope is `{ count, memories: [...] }` (verified live, v0.10.0). */
function parseRows(stdout: string): LedgerRow[] {
	const envelope = JSON.parse(stdout) as { memories?: unknown };
	if (!Array.isArray(envelope.memories)) return [];
	const rows: LedgerRow[] = [];
	for (const raw of envelope.memories as RawMemory[]) {
		if (typeof raw?.id !== "string" || raw.id === "") continue;
		rows.push({
			id: raw.id,
			title: typeof raw.title === "string" ? raw.title : "",
			namespace: typeof raw.namespace === "string" ? raw.namespace : "",
			tier: typeof raw.tier === "string" ? raw.tier : "long",
			priority: typeof raw.priority === "number" ? raw.priority : 0,
			updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : "",
		});
	}
	return rows;
}

function timestamp(row: LedgerRow): number {
	const ts = Date.parse(row.updatedAt);
	// Undated rows sort last rather than poisoning the comparator with NaN.
	return Number.isNaN(ts) ? 0 : ts;
}

/**
 * Read the ledger for `since` across `namespaces` (or the cwd namespace
 * when omitted). Rows are concatenated and sorted `updated_at` desc.
 * Never throws: any total failure resolves `{ ok: false, error }`; a
 * per-namespace failure resolves a partial ledger plus a note.
 */
export async function runLedger(
	bin: string,
	opts: LedgerOptions,
	signal?: AbortSignal,
): Promise<LedgerOutcome> {
	const since = typeof opts.since === "string" ? opts.since.trim() : "";
	if (!since) {
		return { ok: false, rows: [], notes: [], error: "`since` is required" };
	}
	const limit = clampLimit(opts.limit);
	const namespaces = (opts.namespaces ?? []).filter(
		(ns) => typeof ns === "string" && ns !== "",
	);
	// Omitted/empty namespace list = one cwd-scoped spawn.
	const scopes: (string | undefined)[] =
		namespaces.length > 0 ? namespaces : [undefined];

	const rows: LedgerRow[] = [];
	const notes: string[] = [];
	for (const ns of scopes) {
		try {
			const stdout = await spawnOk(
				bin,
				listArgs(since, limit, ns),
				LEDGER_TIMEOUT,
				signal,
			);
			rows.push(...parseRows(stdout));
		} catch (err) {
			if (scopes.length === 1) {
				// Nothing survived: the ledger itself failed.
				return {
					ok: false,
					rows: [],
					notes: [],
					error: `ai-memory list failed: ${errorMessage(err)}`,
				};
			}
			notes.push(
				`list --namespace ${ns ?? "(cwd)"} failed: ${errorMessage(err)}`,
			);
		}
	}

	if (rows.length === 0 && notes.length === scopes.length) {
		return { ok: false, rows: [], notes, error: `ledger failed: ${notes[0]}` };
	}

	rows.sort((a, b) => timestamp(b) - timestamp(a));
	return { ok: true, rows, notes };
}

/**
 * Render rows as one line each:
 * `[long/<id7>] title (ns, p=<p>, updated <YYYY-MM-DD>)`, followed by any
 * partial-ledger notes. Empty rows and notes render as an empty string.
 */
export function formatLedgerRows(
	rows: LedgerRow[],
	notes: string[] = [],
): string {
	const lines = rows.map(
		(row) =>
			`[${row.tier}/${row.id.slice(0, 7)}] ${row.title} (${row.namespace}, p=${row.priority}, updated ${row.updatedAt.slice(0, 10) || "unknown"})`,
	);
	return [...lines, ...notes].join("\n");
}
