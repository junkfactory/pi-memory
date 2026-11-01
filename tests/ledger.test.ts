import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatLedgerRows, runLedger } from "../src/ledger.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	execFile: (...args: unknown[]) => execFileMock(...args),
}));

// Same queue-driven callback shape as tests/boot.test.ts: promisify(execFile)
// calls execFile(file, args, options, cb), so the mock pops one queued stdout
// (or Error) per spawn.
execFileMock.mockImplementation(
	(
		_file: unknown,
		_args: unknown,
		_opts: unknown,
		cb: (err: Error | null, out: { stdout: string }) => void,
	) => {
		const result = execFileMock.queue?.shift();
		if (result instanceof Error) cb(result, { stdout: "" });
		else cb(null, { stdout: result ?? "" });
	},
);

interface RawRow {
	id: string;
	title?: string;
	namespace?: string;
	tier?: string;
	priority?: number;
	updated_at?: string;
}

function envelope(rows: RawRow[]): string {
	return JSON.stringify({
		count: rows.length,
		memories: rows.map((row) => ({
			title: "title",
			namespace: "pi",
			tier: "long",
			priority: 5,
			updated_at: "2026-11-01T00:00:00+00:00",
			...row,
		})),
	});
}

const rowA = {
	id: "aaaaaaaa-0000-0000-0000-000000000000",
	title: "older lesson",
	namespace: "pi",
	priority: 8,
	updated_at: "2026-10-31T10:00:00+00:00",
};
const rowB = {
	id: "bbbbbbbb-0000-0000-0000-000000000000",
	title: "newer lesson",
	namespace: "global",
	priority: 7,
	updated_at: "2026-11-01T09:30:00+00:00",
};

function calls(): unknown[][] {
	return execFileMock.mock.calls as unknown[][];
}

describe("runLedger", () => {
	beforeEach(() => {
		execFileMock.queue = [];
		execFileMock.mockClear();
	});

	it("does not spawn at import time", () => {
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it("runs one cwd-scoped spawn and sorts rows newest-first", async () => {
		execFileMock.queue = [envelope([rowA, rowB])];
		const out = await runLedger("ai-memory", { since: "2026-10-31" });

		expect(out).toEqual({
			ok: true,
			rows: [
				{
					id: rowB.id,
					title: "newer lesson",
					namespace: "global",
					tier: "long",
					priority: 7,
					updatedAt: "2026-11-01T09:30:00+00:00",
				},
				{
					id: rowA.id,
					title: "older lesson",
					namespace: "pi",
					tier: "long",
					priority: 8,
					updatedAt: "2026-10-31T10:00:00+00:00",
				},
			],
			notes: [],
		});
		expect(execFileMock).toHaveBeenCalledTimes(1);
		expect(calls()[0][0]).toBe("ai-memory");
		expect(calls()[0][1]).toEqual([
			"list",
			"--json",
			"--since",
			"2026-10-31",
			"--limit",
			"50",
		]);
	});

	it("fans out one spawn per namespace and merges rows", async () => {
		execFileMock.queue = [envelope([rowA]), envelope([rowB])];
		const out = await runLedger("ai-memory", {
			since: "2026-10-01",
			namespaces: ["pi", "global"],
		});

		expect(out.ok).toBe(true);
		expect(out.rows.map((r) => r.id)).toEqual([rowB.id, rowA.id]);
		expect(calls().map((call) => call[1])).toEqual([
			["list", "--json", "--since", "2026-10-01", "--limit", "50", "-n", "pi"],
			[
				"list",
				"--json",
				"--since",
				"2026-10-01",
				"--limit",
				"50",
				"-n",
				"global",
			],
		]);
	});

	it("treats an empty namespace list as cwd inference", async () => {
		execFileMock.queue = [envelope([])];
		const out = await runLedger("ai-memory", {
			since: "2026-10-01",
			namespaces: [],
		});
		expect(out).toEqual({ ok: true, rows: [], notes: [] });
		expect(execFileMock).toHaveBeenCalledTimes(1);
		expect(calls()[0][1]).not.toContain("-n");
	});

	it("clamps the limit to [1, 500] and defaults to 50", async () => {
		const limits: [number | undefined, string][] = [
			[0, "1"],
			[-3, "1"],
			[9999, "500"],
			[2.9, "2"],
			[undefined, "50"],
			[Number.NaN, "50"],
		];
		for (const [limit, expected] of limits) {
			execFileMock.mockClear();
			execFileMock.queue = [envelope([])];
			await runLedger("ai-memory", { since: "2026-10-01", limit });
			expect(calls()[0][1]).toEqual([
				"list",
				"--json",
				"--since",
				"2026-10-01",
				"--limit",
				expected,
			]);
		}
	});

	it("degrades to a partial ledger when one namespace fails", async () => {
		execFileMock.queue = [new Error("exit 1"), envelope([rowB])];
		const out = await runLedger("ai-memory", {
			since: "2026-10-01",
			namespaces: ["pi", "global"],
		});

		expect(out.ok).toBe(true);
		expect(out.rows.map((r) => r.id)).toEqual([rowB.id]);
		expect(out.notes).toEqual(["list --namespace pi failed: exit 1"]);
		expect(formatLedgerRows(out.rows, out.notes)).toContain(
			"list --namespace pi failed: exit 1",
		);
	});

	it("fails when every namespace fails", async () => {
		execFileMock.queue = [new Error("exit 1"), new Error("exit 2")];
		const out = await runLedger("ai-memory", {
			since: "2026-10-01",
			namespaces: ["pi", "global"],
		});

		expect(out.ok).toBe(false);
		expect(out.rows).toEqual([]);
		expect(out.notes).toHaveLength(2);
		expect(out.error).toContain("ledger failed");
	});

	it("fails when the single cwd spawn fails", async () => {
		execFileMock.queue = [new Error("spawn ENOENT")];
		const out = await runLedger("ai-memory", { since: "2026-10-01" });

		expect(out.ok).toBe(false);
		expect(out.error).toContain("ai-memory list failed");
		expect(out.error).toContain("spawn ENOENT");
	});

	it("fails on malformed JSON instead of throwing", async () => {
		execFileMock.queue = ["not json"];
		const out = await runLedger("ai-memory", { since: "2026-10-01" });
		expect(out.ok).toBe(false);
		expect(out.error).toContain("ai-memory list failed");
	});

	it("rejects a missing since without spawning", async () => {
		const out = await runLedger("ai-memory", { since: "   " });
		expect(out).toEqual({
			ok: false,
			rows: [],
			notes: [],
			error: "`since` is required",
		});
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it("tolerates a missing memories array and id-less entries", async () => {
		execFileMock.queue = [
			JSON.stringify({ count: 2, memories: [{ title: "no id" }, rowA] }),
		];
		const out = await runLedger("ai-memory", { since: "2026-10-01" });
		expect(out.ok).toBe(true);
		expect(out.rows.map((r) => r.title)).toEqual(["older lesson"]);

		execFileMock.queue = [JSON.stringify({ count: 0 })];
		const empty = await runLedger("ai-memory", { since: "2026-10-01" });
		expect(empty).toEqual({ ok: true, rows: [], notes: [] });
	});

	it("forwards the abort signal and a 10s timeout to the spawn", async () => {
		execFileMock.queue = [envelope([])];
		const controller = new AbortController();
		await runLedger("ai-memory", { since: "2026-10-01" }, controller.signal);
		expect(calls()[0][2]).toMatchObject({
			timeout: 10_000,
			signal: controller.signal,
		});
	});
});

describe("formatLedgerRows", () => {
	it("renders id7, tier, priority and the updated date", () => {
		const out = formatLedgerRows([
			{
				id: "a1b2c3d4-0000-0000-0000-000000000000",
				title: "never repeat the flag order",
				namespace: "pi",
				tier: "long",
				priority: 8,
				updatedAt: "2026-11-01T09:30:00+00:00",
			},
		]);
		expect(out).toBe(
			"[long/a1b2c3d] never repeat the flag order (pi, p=8, updated 2026-11-01)",
		);
	});

	it("appends notes after rows and renders empty input as empty", () => {
		expect(formatLedgerRows([], ["list --namespace pi failed: exit 1"])).toBe(
			"list --namespace pi failed: exit 1",
		);
		expect(formatLedgerRows([])).toBe("");
	});
});
