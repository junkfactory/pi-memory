import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetBinaryCache } from "../src/boot.js";
import extension from "../src/index.js";
import { queryMemories, recallForPrompt } from "../src/recall.js";
import {
	memoryGetTool,
	memoryRecallTool,
	memorySearchTool,
} from "../src/tools.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	execFile: (...args: unknown[]) => execFileMock(...args),
}));

// Same promisified-execFile stub as tests/recall.test.ts: the queue holds
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

function memory(overrides: Record<string, unknown> = {}) {
	return {
		score: 0.87,
		confidence: 1.0,
		id: "abc123",
		title: "Memory title",
		content: "Memory body",
		namespace: "vcs/jj",
		tier: "long",
		priority: 7,
		created_at: "2026-10-31T00:00:00Z",
		...overrides,
	};
}

/** `recall --json` envelope (verified live, v0.10.0). */
function envelope(memories: unknown[], count = memories.length) {
	return JSON.stringify({ count, memories });
}

/** `search --json` envelope (verified live, v0.10.0: `results`, not `memories`). */
function searchEnvelope(results: unknown[], count = results.length) {
	return JSON.stringify({ count, results });
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

function optsOf(subcommand: string) {
	return callsOf(subcommand)[0]?.[2] as Record<string, unknown> | undefined;
}

function body(result: { content: Array<{ text: string }> }) {
	return result.content[0]?.text ?? "";
}

function recorderPi() {
	const tools = new Map<string, unknown>();
	const registerTool = vi.fn((tool: { name: string }) => {
		tools.set(tool.name, tool);
	});
	const pi = {
		on: vi.fn(),
		getMcpServers: () => [],
		registerMcpServer: vi.fn(),
		registerTool,
	};
	return { pi, tools, registerTool };
}

describe("read tool registration", () => {
	it("registers memory_recall, memory_search, memory_get at load time", () => {
		const { pi, registerTool, tools } = recorderPi();

		extension(pi as never);

		expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
			"memory_recall",
			"memory_search",
			"memory_get",
			"memory_store",
			"memory_update",
			"memory_delete",
			"memory_ledger",
		]);
		expect(tools.get("memory_recall")).toBe(memoryRecallTool);
		expect(tools.get("memory_search")).toBe(memorySearchTool);
		expect(tools.get("memory_get")).toBe(memoryGetTool);
	});
});

describe("memory_recall", () => {
	beforeEach(() => {
		execFileMock.queue = [];
		execFileMock.mockClear();
		resetBinaryCache();
	});

	it("returns formatted rows, a count, and the documented argv", async () => {
		queue("ai-memory 0.10.0", envelope([memory()]));

		const result = await memoryRecallTool.execute(
			"call-1",
			{ query: "what did we decide?" },
			undefined,
		);

		expect(result.isError).toBeUndefined();
		expect(body(result)).toContain(
			"[long/abc123] Memory title (ns=vcs/jj, score=0.87)",
		);
		expect(body(result)).toContain("1 memory(ies) recalled");
		expect(argvOf("recall")).toEqual([
			"recall",
			"-T",
			"semantic",
			"--limit",
			"5",
			"--budget-tokens",
			"300",
			"--json",
			"--",
			"what did we decide?",
		]);
		// recall keeps its own 5s budget (not the tool-wide 10s constant).
		expect(optsOf("recall")).toMatchObject({ timeout: 5_000 });
	});

	it("caps returned rows at `limit`", async () => {
		queue(
			"ai-memory 0.10.0",
			envelope([
				memory({ id: "first", score: 0.9 }),
				memory({ id: "second", score: 0.8 }),
				memory({ id: "third", score: 0.7 }),
			]),
		);

		const result = await memoryRecallTool.execute(
			"call-1",
			{ query: "q", limit: 2 },
			undefined,
		);

		expect(body(result)).toContain("[long/first]");
		expect(body(result)).toContain("[long/second]");
		expect(body(result)).not.toContain("[long/third]");
		expect(body(result)).toContain("2 memory(ies) recalled");
	});

	it("falls back to keyword when semantic fails", async () => {
		queue(
			"ai-memory 0.10.0",
			new Error("exit 1"),
			envelope([memory({ score: 9.6 })]),
		);

		const result = await memoryRecallTool.execute(
			"call-1",
			{ query: "q" },
			undefined,
		);

		expect(body(result)).toContain("[long/abc123]");
		expect(
			execFileMock.mock.calls
				.filter((call) => (call[1] as string[])?.[0] === "recall")
				.map((call) => (call[1] as string[])[2]),
		).toEqual(["semantic", "keyword"]);
	});

	it("returns a healthy no-match without an error", async () => {
		queue("ai-memory 0.10.0", envelope([], 0));

		const result = await memoryRecallTool.execute(
			"call-1",
			{ query: "q" },
			undefined,
		);

		expect(result.isError).toBeUndefined();
		expect(body(result)).toBe("No memories matched.");
		expect(callsOf("recall")).toHaveLength(1);
	});

	it("returns isError (never throws) when both tiers fail", async () => {
		queue("ai-memory 0.10.0", new Error("exit 1"), new Error("exit 1"));

		const result = await memoryRecallTool.execute(
			"call-1",
			{ query: "q" },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("recall failed");
		expect(callsOf("recall")).toHaveLength(2);
	});

	it("rejects an empty query without spawning", async () => {
		const result = await memoryRecallTool.execute(
			"call-1",
			{ query: "   " },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("`query` must be non-empty");
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it("returns isError (never throws) when the binary is missing", async () => {
		queue(new Error("spawn ENOENT"), new Error("spawn ENOENT"));

		const result = await memoryRecallTool.execute(
			"call-1",
			{ query: "q" },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("ai-memory binary not found");
		expect(callsOf("recall")).toHaveLength(0);
	});
});

describe("memory_search", () => {
	beforeEach(() => {
		execFileMock.queue = [];
		execFileMock.mockClear();
		resetBinaryCache();
	});

	it("passes query, limit, and tier and returns row lines", async () => {
		queue("ai-memory 0.10.0", searchEnvelope([memory()]));

		const result = await memorySearchTool.execute(
			"call-1",
			{ query: "tier policy", limit: 3, tier: "long" },
			undefined,
		);

		expect(result.isError).toBeUndefined();
		expect(body(result)).toContain("[long/abc123] Memory title (vcs/jj, p=7)");
		expect(body(result)).toContain("1 memory(ies) found");
		expect(argvOf("search")).toEqual([
			"search",
			"--json",
			"--limit",
			"3",
			"-t",
			"long",
			"--",
			"tier policy",
		]);
		expect(optsOf("search")).toMatchObject({ timeout: 10_000 });
	});

	it("defaults to limit 10 and omits the tier flag", async () => {
		queue("ai-memory 0.10.0", searchEnvelope([memory()]));

		await memorySearchTool.execute("call-1", { query: "q" }, undefined);

		expect(argvOf("search")).toEqual([
			"search",
			"--json",
			"--limit",
			"10",
			"--",
			"q",
		]);
	});

	it("keeps a flag-shaped query as one argv element after --", async () => {
		queue("ai-memory 0.10.0", searchEnvelope([memory()]));

		await memorySearchTool.execute(
			"call-1",
			{ query: "-t semantic --help" },
			undefined,
		);

		expect(argvOf("search")?.at(-1)).toBe("-t semantic --help");
	});

	it("reports an empty result set without an error", async () => {
		queue("ai-memory 0.10.0", searchEnvelope([], 0));

		const result = await memorySearchTool.execute(
			"call-1",
			{ query: "nothing" },
			undefined,
		);

		expect(result.isError).toBeUndefined();
		expect(body(result)).toBe('No memories matched "nothing".');
	});

	it("returns isError on a failed spawn", async () => {
		queue("ai-memory 0.10.0", new Error("exit 2"));

		const result = await memorySearchTool.execute(
			"call-1",
			{ query: "q" },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("search failed: exit 2");
	});

	it("returns isError when the binary is missing", async () => {
		queue(new Error("spawn ENOENT"), new Error("spawn ENOENT"));

		const result = await memorySearchTool.execute(
			"call-1",
			{ query: "q" },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("ai-memory binary not found");
		expect(callsOf("search")).toHaveLength(0);
	});
});

describe("memory_get", () => {
	beforeEach(() => {
		execFileMock.queue = [];
		execFileMock.mockClear();
		resetBinaryCache();
	});

	it("returns the full memory JSON as text", async () => {
		const raw = JSON.stringify({ ...memory(), version: 3 });
		queue("ai-memory 0.10.0", raw);

		const result = await memoryGetTool.execute(
			"call-1",
			{ id: "abc123" },
			undefined,
		);

		expect(result.isError).toBeUndefined();
		expect(body(result)).toBe(raw);
		expect(argvOf("get")).toEqual(["get", "--json", "abc123"]);
		expect(optsOf("get")).toMatchObject({ timeout: 10_000 });
	});

	it("rejects an empty id without spawning", async () => {
		const result = await memoryGetTool.execute(
			"call-1",
			{ id: " " },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("`id` must be non-empty");
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it("returns isError when the id is unknown", async () => {
		queue("ai-memory 0.10.0", new Error("memory not found"));

		const result = await memoryGetTool.execute(
			"call-1",
			{ id: "missing" },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("get missing failed: memory not found");
	});

	it("returns isError when the binary is missing", async () => {
		queue(new Error("spawn ENOENT"), new Error("spawn ENOENT"));

		const result = await memoryGetTool.execute(
			"call-1",
			{ id: "abc123" },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(body(result)).toContain("ai-memory binary not found");
		expect(callsOf("get")).toHaveLength(0);
	});
});

describe("queryMemories", () => {
	beforeEach(() => {
		execFileMock.queue = [];
		execFileMock.mockClear();
		resetBinaryCache();
	});

	it("drops semantic scores below the 0.5 floor and does not fall back", async () => {
		queue(
			envelope([
				memory({ id: "gold", score: 0.87 }),
				memory({ id: "noise", score: 0.45 }),
			]),
		);

		const memories = await queryMemories("ai-memory", "q");

		expect(memories.map((m) => m.id)).toEqual(["gold"]);
		expect(callsOf("recall")).toHaveLength(1);
	});

	it("applies the keyword floor (5.0) on the fallback path", async () => {
		queue(
			new Error("exit 1"),
			envelope([
				memory({ id: "low", score: 4.2 }),
				memory({ id: "keep", score: 6.1 }),
			]),
		);

		const memories = await queryMemories("ai-memory", "q");

		expect(memories.map((m) => m.id)).toEqual(["keep"]);
	});

	it("honors PI_MEMORY_SEMANTIC_FLOOR", async () => {
		const prev = process.env.PI_MEMORY_SEMANTIC_FLOOR;
		try {
			process.env.PI_MEMORY_SEMANTIC_FLOOR = "0.9";
			queue(
				envelope([
					memory({ id: "below", score: 0.6 }),
					memory({ id: "above", score: 0.95 }),
				]),
			);

			const memories = await queryMemories("ai-memory", "q");

			expect(memories.map((m) => m.id)).toEqual(["above"]);
		} finally {
			if (prev === undefined) delete process.env.PI_MEMORY_SEMANTIC_FLOOR;
			else process.env.PI_MEMORY_SEMANTIC_FLOOR = prev;
		}
	});

	it("rejects when both tiers fail instead of reporting a clean no-match", async () => {
		queue(new Error("exit 1"), new Error("exit 1"));

		await expect(queryMemories("ai-memory", "q")).rejects.toThrow("exit 1");
	});

	it("lets recallForPrompt degrade to null on a total tier failure", async () => {
		queue(
			"ai-memory 0.10.0",
			new Error("semantic exploded"),
			new Error("keyword exploded"),
		);

		await expect(recallForPrompt("q")).resolves.toBeNull();
	});
});
