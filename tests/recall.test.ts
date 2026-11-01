import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetBinaryCache } from "../src/boot.js";
import { recallForPrompt } from "../src/recall.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	execFile: (...args: unknown[]) => execFileMock(...args),
}));

// Same promisified-execFile stub as tests/boot.test.ts: the queue holds
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
		score: 9.6,
		confidence: 1.0,
		id: "abc123",
		title: "Memory title",
		content: "Memory body",
		namespace: "vcs/jj",
		tier: "long",
		created_at: "2026-10-31T00:00:00Z",
		...overrides,
	};
}

function envelope(memories: unknown[], count = memories.length) {
	return JSON.stringify({
		count,
		memories,
		meta: {},
		budget_tokens: 300,
		tokens_used: 42,
		mode: "keyword",
	});
}

// One entry per spawn: binary resolution first, then one per recall attempt.
function queue(...results: Array<string | Error>) {
	execFileMock.queue = results;
}

function recallCall() {
	return execFileMock.mock.calls.find(
		(call) => (call[1] as string[] | undefined)?.[0] === "recall",
	);
}

describe("recallForPrompt", () => {
	beforeEach(() => {
		execFileMock.queue = [];
		execFileMock.mockClear();
		resetBinaryCache();
	});

	it("formats memories above the score floor with tier/id/ns/score and a footer", async () => {
		queue("ai-memory 0.10.0", envelope([memory()]));

		const out = await recallForPrompt("what did we decide?");

		expect(out).toContain("<ai-memory recall>");
		expect(out).toContain("[long/abc123] Memory title (ns=vcs/jj, score=9.6)");
		expect(out).toContain("Memory body");
		expect(out).toContain("1 memory(ies) recalled");
		expect(out).toContain("</ai-memory recall>");
	});

	it("passes the documented argv (semantic tier) with the query truncated to 300 chars", async () => {
		queue("ai-memory 0.10.0", envelope([memory()]));

		await recallForPrompt("x".repeat(400));

		const call = recallCall();
		expect(call?.[0]).toBe("ai-memory");
		expect(call?.[1]).toEqual([
			"recall",
			"-T",
			"semantic",
			"--limit",
			"5",
			"--budget-tokens",
			"300",
			"--json",
			"--",
			"x".repeat(300),
		]);
		expect(call?.[2]).toMatchObject({ timeout: 5_000 });
	});

	it("does not fall back to keyword when the semantic call succeeds", async () => {
		queue("ai-memory 0.10.0", envelope([memory()]));

		await recallForPrompt("q");

		const recallCalls = execFileMock.mock.calls.filter(
			(call) => (call[1] as string[] | undefined)?.[0] === "recall",
		);
		expect(recallCalls).toHaveLength(1);
	});

	it("falls back to keyword when the semantic call fails", async () => {
		queue("ai-memory 0.10.0", new Error("exit 1"), envelope([memory()]));

		const out = await recallForPrompt("q");

		expect(out).toContain("[long/abc123]");
		const argvs = execFileMock.mock.calls
			.filter((call) => (call[1] as string[] | undefined)?.[0] === "recall")
			.map((call) => (call[1] as string[])[2]);
		expect(argvs).toEqual(["semantic", "keyword"]);
	});

	it("keeps a prompt with shell metacharacters as one argv element", async () => {
		queue("ai-memory 0.10.0", envelope([memory()]));

		await recallForPrompt("find; rm -rf / && `id`");

		const argv = recallCall()?.[1] as string[] | undefined;
		expect(argv?.at(-1)).toBe("find; rm -rf / && `id`");
	});

	it("passes a flag-shaped prompt as literal text after --", async () => {
		queue("ai-memory 0.10.0", envelope([memory()]));

		await recallForPrompt("-T semantic --help");

		const argv = recallCall()?.[1] as string[] | undefined;
		expect(argv?.at(-1)).toBe("-T semantic --help");
	});

	it("honors PI_MEMORY_SEMANTIC_FLOOR, clamped to [0,1]", async () => {
		const prev = process.env.PI_MEMORY_SEMANTIC_FLOOR;
		try {
			// Each subcase resets the binary cache so the lookup table below
			// (probe item first) stays deterministic.
			resetBinaryCache();
			process.env.PI_MEMORY_SEMANTIC_FLOOR = "0.9";
			queue(
				"ai-memory 0.10.0",
				envelope([memory({ score: 0.6 })]),
				envelope([memory({ score: 9.9 })]),
			);
			expect(await recallForPrompt("q")).toBeNull(); // below raised floor

			process.env.PI_MEMORY_SEMANTIC_FLOOR = "5";
			resetBinaryCache();
			queue(
				"ai-memory 0.10.0",
				envelope([memory({ score: 0.99 })]),
				envelope([memory({ score: 1.0 })]),
			);
			expect(await recallForPrompt("q")).toBeNull(); // 0.99 < clamped 1
			expect(await recallForPrompt("q")).not.toBeNull(); // boundary inclusive

			process.env.PI_MEMORY_SEMANTIC_FLOOR = "garbage";
			resetBinaryCache();
			queue("ai-memory 0.10.0", envelope([memory({ score: 0.6 })]));
			expect(await recallForPrompt("q")).not.toBeNull(); // falls back to 0.5
		} finally {
			if (prev === undefined) delete process.env.PI_MEMORY_SEMANTIC_FLOOR;
			else process.env.PI_MEMORY_SEMANTIC_FLOOR = prev;
		}
	});

	it("drops memories below the semantic floor (0.5)", async () => {
		queue("ai-memory 0.10.0", envelope([memory({ score: 0.6 })]));
		expect(await recallForPrompt("q")).not.toBeNull();
		execFileMock.mockClear();

		// Binary is cached from the first invocation above: no probe item.
		queue(
			envelope([memory({ score: 0.49 })]),
			envelope([memory({ score: 9.9 })]), // must NOT be consumed by a fallback
		);
		expect(await recallForPrompt("q")).toBeNull();
		// A healthy semantic no-match is final — keyword is noise, not a rescue.
		const recallCalls = execFileMock.mock.calls.filter(
			(call) => (call[1] as string[] | undefined)?.[0] === "recall",
		);
		expect(recallCalls).toHaveLength(1);
	});

	it("keeps only survivors when scores straddle the floor", async () => {
		queue(
			"ai-memory 0.10.0",
			envelope([
				memory({ id: "gold", score: 0.87 }),
				memory({ id: "noise", score: 0.45 }),
			]),
		);

		const out = await recallForPrompt("q");

		expect(out).toContain("[long/gold]");
		expect(out).not.toContain("[long/noise]");
		expect(out).toContain("1 memory(ies) recalled");
	});

	it("returns null on count 0 (no fallback spawn)", async () => {
		queue("ai-memory 0.10.0", envelope([], 0), envelope([memory()]));
		expect(await recallForPrompt("q")).toBeNull();
		// count 0 is a healthy answer, not a failure: no keyword fallback.
		const recallCalls = execFileMock.mock.calls.filter(
			(call) => (call[1] as string[] | undefined)?.[0] === "recall",
		);
		expect(recallCalls).toHaveLength(1);
	});

	it("returns null on an empty memories array without fallback", async () => {
		queue(
			"ai-memory 0.10.0",
			envelope([], 1),
			envelope([], 1),
		);
		expect(await recallForPrompt("q")).toBeNull();
		const recallCalls = execFileMock.mock.calls.filter(
			(call) => (call[1] as string[] | undefined)?.[0] === "recall",
		);
		expect(recallCalls).toHaveLength(1);
	});

	it("returns null on malformed JSON (both tiers)", async () => {
		queue("ai-memory 0.10.0", "not json at all", "still not json");
		expect(await recallForPrompt("q")).toBeNull();
	});

	it("returns null on non-zero exit (both tiers)", async () => {
		queue(
			"ai-memory 0.10.0",
			new Error("Command failed: exit 1"),
			new Error("Command failed: exit 1"),
		);
		expect(await recallForPrompt("q")).toBeNull();
	});

	it("returns null on timeout (both tiers)", async () => {
		queue("ai-memory 0.10.0", new Error("ETIMEDOUT"), new Error("ETIMEDOUT"));
		expect(await recallForPrompt("q")).toBeNull();
	});

	it("returns null when the binary cannot be resolved", async () => {
		execFileMock.queue = [
			new Error("spawn ai-memory ENOENT"),
			new Error("spawn ENOENT"),
		];
		expect(await recallForPrompt("q")).toBeNull();
	});

	it("returns null without spawning on an empty prompt", async () => {
		expect(await recallForPrompt("   ")).toBeNull();
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it("redacts db path lines from recalled content", async () => {
		queue(
			"ai-memory 0.10.0",
			envelope([
				memory({ content: "keep this\ndb: /Users/me/memory.db (schema=v80)" }),
			]),
		);

		const out = await recallForPrompt("q");

		expect(out).toContain("keep this");
		expect(out).not.toContain("memory.db");
	});

	it("warns exactly once per process across failures", async () => {
		vi.resetModules();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fresh = await import("../src/recall.js");

		queue("ai-memory 0.10.0", new Error("exit 1"), new Error("exit 1b"));
		await expect(fresh.recallForPrompt("first")).resolves.toBeNull();
		queue("ai-memory 0.10.0", new Error("exit 2"), new Error("exit 2b"));
		await expect(fresh.recallForPrompt("second")).resolves.toBeNull();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toContain("[pi-memory]");
		warnSpy.mockRestore();
	});
});
