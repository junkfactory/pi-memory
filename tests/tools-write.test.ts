import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetBinaryCache } from "../src/boot.js";
import {
	memoryDeleteTool,
	memoryLedgerTool,
	memoryStoreTool,
	memoryUpdateTool,
} from "../src/tools.js";

const execFileMock = vi.hoisted(() => vi.fn());
const routineMock = vi.hoisted(() => ({ routineDue: vi.fn() }));

vi.mock("node:child_process", () => ({
	execFile: (...args: unknown[]) => execFileMock(...args),
}));

// `memory_ledger` derives its default `since` from the routine state file;
// keeping that pure here means these tests never read the operator's home.
vi.mock("../src/routine.js", () => ({
	routineDue: (...args: unknown[]) => routineMock.routineDue(...args),
}));

// Same promisified-execFile stub as tests/tools-read.test.ts: the queue holds
// stdout strings or Errors, one per spawn attempt.
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

const VERSION_PROBE = "ai-memory 0.10.0";
const ID = "66585a0a-407b-4625-ad72-bfef8ce8a024";

function memory(overrides: Record<string, unknown> = {}) {
	return {
		id: ID,
		title: "Memory title",
		content: "Memory body",
		namespace: "tmp",
		tier: "mid",
		priority: 5,
		version: 1,
		created_at: "2026-11-01T00:00:00Z",
		updated_at: "2026-11-01T00:00:00Z",
		...overrides,
	};
}

/** `search --json` envelope (v0.10.0: `results`). */
function searchEnvelope(results: unknown[], count = results.length) {
	return JSON.stringify({ count, results });
}

/** `list --json` / `recall --json` envelope (`memories`). */
function listEnvelope(memories: unknown[], count = memories.length) {
	return JSON.stringify({ count, memories });
}

/** `get --json` envelope: `{ links, memory }` (verified live, v0.10.0). */
function getEnvelope(row: Record<string, unknown>) {
	return JSON.stringify({ links: [], memory: row });
}

function queue(...results: Array<string | Error>) {
	execFileMock.queue = results;
}

function callsOf(subcommand: string) {
	return execFileMock.mock.calls.filter(
		(call) => (call[1] as string[] | undefined)?.[0] === subcommand,
	);
}

function argvOf(subcommand: string) {
	return callsOf(subcommand)[0]?.[1] as string[] | undefined;
}

function body(result: { content: Array<{ text: string }> }) {
	return result.content[0]?.text ?? "";
}

beforeEach(() => {
	execFileMock.queue = [];
	execFileMock.mockClear();
	resetBinaryCache();
	routineMock.routineDue.mockReset();
});

describe("memory_store", () => {
	it("gates on dedupe hits and stores nothing", async () => {
		queue(
			VERSION_PROBE,
			searchEnvelope([memory({ title: "Memory title (dup)", tier: "long" })]),
		);

		const result = await memoryStoreTool.execute(
			"call-1",
			{ title: "Memory title", content: "body", tier: "mid" },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("[long/66585a0] Memory title (dup)");
		expect(body(result)).toContain("confirm: true");
		expect(callsOf("store")).toHaveLength(0);
		expect(argvOf("search")).toEqual([
			"search",
			"--json",
			"--limit",
			"5",
			"--",
			"Memory title",
		]);
	});

	it("stores once with confirm: true, skipping the probe", async () => {
		queue(VERSION_PROBE, JSON.stringify(memory({ version: 1 })));

		const result = await memoryStoreTool.execute(
			"call-1",
			{
				title: "Memory title",
				content: "Memory body",
				tier: "mid",
				confirm: true,
			},
			undefined,
		);

		expect(result.isError).toBeUndefined();
		expect(body(result)).toContain("stored [mid/66585a0] Memory title");
		expect(body(result)).toContain("p=5");
		expect(body(result)).toContain("version=1");
		expect(callsOf("search")).toHaveLength(0);
		expect(argvOf("store")).toEqual([
			"store",
			"-T",
			"Memory title",
			"-c",
			"Memory body",
			"-t",
			"mid",
			"-p",
			"5",
			"--json",
		]);
		expect(callsOf("store")[0]?.[2]).toMatchObject({ timeout: 10_000 });
	});

	it("stores after a clean probe, passing tags and explicit priority", async () => {
		queue(
			VERSION_PROBE,
			searchEnvelope([], 0),
			JSON.stringify(memory({ tier: "long", priority: 8 })),
		);

		const result = await memoryStoreTool.execute(
			"call-1",
			{
				title: "Lesson",
				content: "Never repeat this",
				tier: "long",
				priority: 8,
				tags: ["vcs", "jj"],
			},
			undefined,
		);

		expect(result.isError).toBeUndefined();
		expect(argvOf("store")).toEqual([
			"store",
			"-T",
			"Lesson",
			"-c",
			"Never repeat this",
			"-t",
			"long",
			"-p",
			"8",
			"--tags",
			"vcs,jj",
			"--json",
		]);
		expect(body(result)).toContain("p=8");
	});

	it.each(["short", "mid", "long"] as const)(
		"passes tier %s verbatim in the store argv",
		async (tier) => {
			queue(
				VERSION_PROBE,
				searchEnvelope([], 0),
				JSON.stringify(memory({ tier })),
			);

			await memoryStoreTool.execute(
				"call-1",
				{ title: "T", content: "C", tier },
				undefined,
			);

			const argv = argvOf("store") ?? [];
			expect(argv[argv.indexOf("-t") + 1]).toBe(tier);
		},
	);

	it("proceeds unconfirmed when the dedupe probe spawn fails", async () => {
		queue(
			VERSION_PROBE,
			new Error("search exploded"),
			JSON.stringify(memory()),
		);

		const result = await memoryStoreTool.execute(
			"call-1",
			{ title: "T", content: "C", tier: "mid" },
			undefined,
		);

		expect(result.isError).toBeUndefined();
		expect(body(result)).toContain("(dedupe probe failed; stored unconfirmed)");
		expect(callsOf("store")).toHaveLength(1);
	});

	it.each([
		["an envelope with no results array", JSON.stringify({ count: 0 })],
		["an unparseable envelope", "{not json"],
		["a null envelope", "null"],
	])(
		"annotates and stores unconfirmed when the dedupe probe returns %s",
		async (_label, probeOutput) => {
			queue(VERSION_PROBE, probeOutput, JSON.stringify(memory()));

			const result = await memoryStoreTool.execute(
				"call-1",
				{ title: "T", content: "C", tier: "mid" },
				undefined,
			);

			expect(result.isError).toBeUndefined();
			expect(body(result)).toContain(
				"(dedupe probe failed; stored unconfirmed)",
			);
			expect(callsOf("store")).toHaveLength(1);
		},
	);

	it("returns isError on a failed store spawn", async () => {
		queue(VERSION_PROBE, new Error("db locked"));

		const result = await memoryStoreTool.execute(
			"call-1",
			{ title: "T", content: "C", tier: "mid", confirm: true },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("store failed: db locked");
	});

	it("rejects empty title or content without spawning", async () => {
		const noTitle = await memoryStoreTool.execute(
			"call-1",
			{ title: " ", content: "C", tier: "mid" },
			undefined,
		);
		const noContent = await memoryStoreTool.execute(
			"call-1",
			{ title: "T", content: "  ", tier: "mid" },
			undefined,
		);

		expect(noTitle.isError).toBe(true);
		expect(body(noTitle)).toContain("`title` must be non-empty");
		expect(noContent.isError).toBe(true);
		expect(body(noContent)).toContain("`content` must be non-empty");
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it("returns isError when the binary is missing", async () => {
		queue(new Error("spawn ENOENT"), new Error("spawn ENOENT"));

		const result = await memoryStoreTool.execute(
			"call-1",
			{ title: "T", content: "C", tier: "mid" },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("ai-memory binary not found");
		expect(callsOf("store")).toHaveLength(0);
	});
});

describe("memory_store schema", () => {
	const schema = memoryStoreTool.parameters as {
		required?: string[];
		properties?: Record<
			string,
			{ enum?: unknown[]; anyOf?: Array<{ const?: unknown }> }
		>;
	};

	it("marks tier as required (no session default)", () => {
		expect(schema.required).toContain("tier");
		expect(
			Value.Check(memoryStoreTool.parameters, {
				title: "T",
				content: "C",
			}),
		).toBe(false);
		expect(
			Value.Check(memoryStoreTool.parameters, {
				title: "T",
				content: "C",
				tier: "mid",
			}),
		).toBe(true);
	});

	it("limits tier to exactly short, mid, long", () => {
		const tier = schema.properties?.tier;
		const values = tier?.enum ?? tier?.anyOf?.map((option) => option.const);

		expect(new Set(values)).toEqual(new Set(["short", "mid", "long"]));
		expect(
			Value.Check(memoryStoreTool.parameters, {
				title: "T",
				content: "C",
				tier: "forever",
			}),
		).toBe(false);
	});
});

describe("memory_update", () => {
	it("derives the integer version from get and passes --expected-version", async () => {
		queue(
			VERSION_PROBE,
			getEnvelope(memory({ version: 3 })),
			JSON.stringify(
				memory({ version: 4, title: "New title", namespace: "global" }),
			),
		);

		const result = await memoryUpdateTool.execute(
			"call-1",
			{
				id: ID,
				title: "New title",
				content: "New body",
				namespace: "global",
				priority: 6,
			},
			undefined,
		);

		expect(result.isError).toBeUndefined();
		expect(argvOf("get")).toEqual(["get", "--json", ID]);
		expect(argvOf("update")).toEqual([
			"update",
			"--json",
			"--title",
			"New title",
			"--content",
			"New body",
			"-n",
			"global",
			"-p",
			"6",
			"--expected-version",
			"3",
			ID,
		]);
		expect(argvOf("update")?.slice(-3)).toEqual([
			"--expected-version",
			"3",
			ID,
		]);
		expect(body(result)).toContain("updated [mid/66585a0] New title");
		expect(body(result)).toContain("version 3 -> 4");
	});

	it("returns isError when the pre-flight get fails (unknown id)", async () => {
		queue(VERSION_PROBE, new Error(`not found: ${ID}`));

		const result = await memoryUpdateTool.execute(
			"call-1",
			{ id: ID, title: "New title" },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("get failed");
		expect(callsOf("update")).toHaveLength(0);
	});

	it("returns isError when get has no integer version", async () => {
		queue(VERSION_PROBE, getEnvelope(memory({ version: "3" })));

		const result = await memoryUpdateTool.execute(
			"call-1",
			{ id: ID, title: "New title" },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("no integer `version`");
		expect(callsOf("update")).toHaveLength(0);
	});

	it("surfaces a version conflict as isError", async () => {
		queue(
			VERSION_PROBE,
			getEnvelope(memory({ version: 2 })),
			new Error("CONFLICT: expected_version=2 but stored version=3"),
		);

		const result = await memoryUpdateTool.execute(
			"call-1",
			{ id: ID, content: "New body" },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain(`update ${ID} failed: CONFLICT`);
	});

	it("rejects a no-op update without spawning", async () => {
		const result = await memoryUpdateTool.execute(
			"call-1",
			{ id: ID },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("nothing to update");
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it("rejects an empty id and a missing binary", async () => {
		const empty = await memoryUpdateTool.execute(
			"call-1",
			{ id: " ", title: "T" },
			undefined,
		);
		expect(empty.isError).toBe(true);
		expect(body(empty)).toContain("`id` must be non-empty");

		queue(new Error("spawn ENOENT"), new Error("spawn ENOENT"));
		const missing = await memoryUpdateTool.execute(
			"call-1",
			{ id: ID, title: "T" },
			undefined,
		);
		expect(missing.isError).toBe(true);
		expect(body(missing)).toContain("ai-memory binary not found");
		expect(callsOf("get")).toHaveLength(0);
	});
});

describe("memory_delete", () => {
	it("previews without confirm and spawns no delete", async () => {
		queue(VERSION_PROBE, getEnvelope(memory({ version: 5 })));

		const result = await memoryDeleteTool.execute(
			"call-1",
			{ id: ID },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("nothing was deleted");
		expect(body(result)).toContain("Memory title");
		expect(body(result)).toContain("Memory body");
		expect(body(result)).toContain("confirm: true");
		expect(callsOf("get")).toHaveLength(1);
		expect(callsOf("delete")).toHaveLength(0);
	});

	it("deletes exactly once with confirm: true", async () => {
		queue(VERSION_PROBE, JSON.stringify({ deleted: true, id: ID }));

		const result = await memoryDeleteTool.execute(
			"call-1",
			{ id: ID, confirm: true },
			undefined,
		);

		expect(result.isError).toBeUndefined();
		expect(body(result)).toBe(`deleted ${ID}`);
		expect(argvOf("delete")).toEqual(["delete", "--json", ID]);
		expect(callsOf("delete")).toHaveLength(1);
		expect(callsOf("get")).toHaveLength(0);
	});

	it("returns isError when the preview get fails (bad id)", async () => {
		queue(VERSION_PROBE, new Error(`not found: ${ID}`));

		const result = await memoryDeleteTool.execute(
			"call-1",
			{ id: ID },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("get failed");
		expect(callsOf("delete")).toHaveLength(0);
	});

	it("returns isError when the confirmed delete fails (bad id)", async () => {
		queue(VERSION_PROBE, new Error(`not found: ${ID}`));

		const result = await memoryDeleteTool.execute(
			"call-1",
			{ id: ID, confirm: true },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain(`delete ${ID} failed`);
	});

	it("truncates a long content preview", async () => {
		const long = `${"x".repeat(2000)}TAIL`;
		queue(VERSION_PROBE, getEnvelope(memory({ content: long })));

		const result = await memoryDeleteTool.execute(
			"call-1",
			{ id: ID },
			undefined,
		);

		expect(body(result)).toContain("x".repeat(600));
		expect(body(result)).not.toContain("TAIL");
		expect(body(result)).not.toContain("x".repeat(601));
	});

	it("rejects an empty id without spawning", async () => {
		const result = await memoryDeleteTool.execute(
			"call-1",
			{ id: "  " },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("`id` must be non-empty");
		expect(execFileMock).not.toHaveBeenCalled();
	});
});

describe("memory_ledger", () => {
	it("defaults since to the last completed routine run", async () => {
		routineMock.routineDue.mockResolvedValue({
			due: false,
			lastRun: "2026-10-31",
		});
		queue(VERSION_PROBE, listEnvelope([memory()]));

		const result = await memoryLedgerTool.execute("call-1", {}, undefined);

		expect(result.isError).toBeUndefined();
		expect(routineMock.routineDue).toHaveBeenCalledTimes(1);
		expect(argvOf("list")).toEqual([
			"list",
			"--json",
			"--since",
			"2026-10-31",
			"--limit",
			"50",
		]);
		expect(body(result)).toContain("[mid/66585a0] Memory title");
		expect(body(result)).toContain("1 memory(ies) since 2026-10-31");
	});

	it("passes explicit since, namespaces, and limit through", async () => {
		queue(
			VERSION_PROBE,
			listEnvelope([memory({ updated_at: "2026-10-30T00:00:00Z" })]),
			listEnvelope([
				memory({ id: "second-id", updated_at: "2026-10-31T00:00:00Z" }),
			]),
		);

		const result = await memoryLedgerTool.execute(
			"call-1",
			{ since: "2026-10-01", namespaces: ["a", "b"], limit: 5 },
			undefined,
		);

		expect(result.isError).toBeUndefined();
		expect(routineMock.routineDue).not.toHaveBeenCalled();
		expect(callsOf("list")).toHaveLength(2);
		expect(argvOf("list")).toEqual([
			"list",
			"--json",
			"--since",
			"2026-10-01",
			"--limit",
			"5",
			"-n",
			"a",
		]);
		expect(callsOf("list")[1]?.[1]).toEqual([
			"list",
			"--json",
			"--since",
			"2026-10-01",
			"--limit",
			"5",
			"-n",
			"b",
		]);
		// Merged rows are sorted newest-first.
		expect(body(result)?.indexOf("[mid/second]")).toBeLessThan(
			body(result)?.indexOf("[mid/66585a0]"),
		);
	});

	it("asks for an explicit since when no routine run is recorded", async () => {
		routineMock.routineDue.mockResolvedValue({ due: true, lastRun: null });

		const result = await memoryLedgerTool.execute("call-1", {}, undefined);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("`since` is required");
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it("treats a throwing routine state read as no recorded run", async () => {
		routineMock.routineDue.mockRejectedValue(new Error("EACCES"));

		const result = await memoryLedgerTool.execute("call-1", {}, undefined);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("`since` is required");
	});

	it("returns isError when list fails", async () => {
		queue(VERSION_PROBE, new Error("db locked"));

		const result = await memoryLedgerTool.execute(
			"call-1",
			{ since: "2026-10-01" },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("ledger failed");
	});

	it("reports an empty ledger without an error", async () => {
		queue(VERSION_PROBE, listEnvelope([], 0));

		const result = await memoryLedgerTool.execute(
			"call-1",
			{ since: "2026-10-01" },
			undefined,
		);

		expect(result.isError).toBeUndefined();
		expect(body(result)).toBe("No memories updated since 2026-10-01.");
	});

	it("returns isError when the binary is missing", async () => {
		queue(new Error("spawn ENOENT"), new Error("spawn ENOENT"));

		const result = await memoryLedgerTool.execute(
			"call-1",
			{ since: "2026-10-01" },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("ai-memory binary not found");
		expect(callsOf("list")).toHaveLength(0);
	});
});
