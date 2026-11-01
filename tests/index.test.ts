import { beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_MARKER } from "../src/boot.js";
import extension from "../src/index.js";

vi.mock("../src/boot.js", () => ({
	BOOT_MARKER: "# ai-memory boot",
	bootSection: vi.fn(),
}));

vi.mock("../src/recall.js", () => ({
	recallForPrompt: vi.fn(),
}));

// The tool definitions are exercised in tests/tools-read.test.ts; index only
// needs stable identities to assert registration ordering.
vi.mock("../src/tools.js", () => ({
	memoryRecallTool: { name: "memory_recall" },
	memorySearchTool: { name: "memory_search" },
	memoryGetTool: { name: "memory_get" },
	memoryStoreTool: { name: "memory_store" },
	memoryUpdateTool: { name: "memory_update" },
	memoryDeleteTool: { name: "memory_delete" },
	memoryLedgerTool: { name: "memory_ledger" },
}));

const bootMocks = await import("../src/boot.js");
const bootSectionMock = vi.mocked(bootMocks.bootSection);
const recallMocks = await import("../src/recall.js");
const recallForPromptMock = vi.mocked(recallMocks.recallForPrompt);

function makePi() {
	const handlers: Record<string, Array<(event?: unknown) => unknown>> = {};
	const registerMcpServer = vi.fn();
	const registerTool = vi.fn();
	return {
		registerMcpServer,
		registerTool,
		pi: {
			on: (name: string, fn: (event?: unknown) => unknown) => {
				const list = handlers[name] ?? [];
				list.push(fn);
				handlers[name] = list;
			},
			registerMcpServer,
			registerTool,
		},
		emit: async (name: string, event?: unknown, ctx?: unknown) =>
			Promise.all((handlers[name] ?? []).map((fn) => fn(event, ctx))),
	};
}

function turnEvent(
	systemPrompt = "base prompt",
	sections: Record<string, string> = {},
) {
	return { systemPrompt, prompt: "hi", systemPromptOptions: { sections } };
}

function contextEvent(
	...contents: Array<string | Array<{ type: string; text: string }>>
) {
	return {
		type: "context",
		messages: contents.map((content, i) => ({
			role: "user",
			content,
			timestamp: i + 1,
		})),
	};
}

describe("index", () => {
	beforeEach(() => {
		bootSectionMock.mockReset();
		recallForPromptMock.mockReset();
	});

	it("never registers the ai-memory MCP server on session_start", async () => {
		// The tailored memory_* tools replace the MCP surface; session_start
		// only resets the recall dedupe state.
		const { pi, emit, registerMcpServer } = makePi();
		extension(pi as never);

		await emit("session_start", { type: "session_start", reason: "startup" });
		expect(registerMcpServer).not.toHaveBeenCalled();
	});

	it("injects boot section on first turn", async () => {
		const section = `\n\n${BOOT_MARKER}\ninfo`;
		bootSectionMock.mockResolvedValue(section);
		const { pi, emit } = makePi();
		extension(pi as never);

		const sections = {};
		const result = await emit(
			"before_agent_start",
			turnEvent("base prompt", sections),
		);
		expect(result).toEqual([undefined]);
		expect(sections.ai_memory_boot).toBe(section);
	});

	it("leaves a carried-over block untouched and re-adds on fresh prompts", async () => {
		const section = `\n\n${BOOT_MARKER}\ninfo`;
		bootSectionMock.mockResolvedValue(section);
		const { pi, emit } = makePi();
		extension(pi as never);

		// Turn 0: inject into fresh options.
		const firstSections = {};
		await emit("before_agent_start", turnEvent("base prompt", firstSections));
		expect(firstSections.ai_memory_boot).toBe(section);
		// Turn 1: prompt already carries the wrap-style marker → skip,
		// carried-over sections stay untouched, no extra boot call.
		const carriedSections = {};
		const second = await emit(
			"before_agent_start",
			turnEvent(`base prompt\n\n${BOOT_MARKER}\ninfo`, carriedSections),
		);
		expect(second).toEqual([undefined]);
		expect(carriedSections.ai_memory_boot).toBeUndefined();
		// Turn 2: fresh sections → section set again.
		const thirdSections = {};
		await emit("before_agent_start", turnEvent("base prompt", thirdSections));
		expect(thirdSections.ai_memory_boot).toBe(section);
		expect(bootSectionMock).toHaveBeenCalledTimes(2);
	});

	it("skips injection when wrap already injected boot output", async () => {
		const { pi, emit } = makePi();
		extension(pi as never);

		const sections = {};
		const result = await emit(
			"before_agent_start",
			turnEvent(`base\n\n${BOOT_MARKER}\nexisting`, sections),
		);
		expect(result).toEqual([undefined]);
		expect(sections.ai_memory_boot).toBeUndefined();
		expect(bootSectionMock).not.toHaveBeenCalled();
	});

	it("retries boot on the next turn after a failure", async () => {
		// A transient boot failure must self-heal: the next turn retries
		// instead of staying bootless for the rest of the session.
		bootSectionMock.mockResolvedValueOnce(null);
		bootSectionMock.mockResolvedValueOnce(`\n\n${BOOT_MARKER}\ninfo`);
		const { pi, emit } = makePi();
		extension(pi as never);

		const failedSections = {};
		const failed = await emit(
			"before_agent_start",
			turnEvent("base prompt", failedSections),
		);
		expect(failed).toEqual([undefined]);
		expect(failedSections.ai_memory_boot).toBeUndefined();
		const retriedSections = {};
		await emit("before_agent_start", turnEvent("base prompt", retriedSections));
		expect(retriedSections.ai_memory_boot).toBe(`\n\n${BOOT_MARKER}\ninfo`);
		expect(bootSectionMock).toHaveBeenCalledTimes(2);
	});

	it("appends recall as an ephemeral user message", async () => {
		const block =
			"<ai-memory recall>\n[long/abc] t (ns=n, score=9.6)\nbody\n1 memory(ies) recalled\n</ai-memory recall>";
		recallForPromptMock.mockResolvedValue(block);
		const { pi, emit } = makePi();
		extension(pi as never);

		const event = contextEvent("hello");
		const [result] = await emit("context", event);

		expect(recallForPromptMock).toHaveBeenCalledWith("hello", undefined);
		expect(result).toEqual({
			messages: [
				...event.messages,
				{ role: "user", content: block, timestamp: expect.any(Number) },
			],
		});
	});

	it("recalls once per prompt across tool-call iterations", async () => {
		recallForPromptMock.mockResolvedValue(
			"<ai-memory recall>block</ai-memory recall>",
		);
		const { pi, emit } = makePi();
		extension(pi as never);

		const first = await emit("context", contextEvent("hello"));
		expect(first[0]).toBeDefined();

		// Same user prompt, now with an assistant turn appended, as in a
		// tool-call iteration of the same user turn.
		const second = await emit("context", {
			type: "context",
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				{ role: "assistant", content: "working", timestamp: 2 },
			],
		});
		expect(second).toEqual([undefined]);
		expect(recallForPromptMock).toHaveBeenCalledTimes(1);
	});

	it("recalls again for a new prompt", async () => {
		recallForPromptMock.mockResolvedValue(
			"<ai-memory recall>block</ai-memory recall>",
		);
		const { pi, emit } = makePi();
		extension(pi as never);

		await emit("context", contextEvent("hello"));
		const second = await emit("context", contextEvent("different question"));

		expect(second[0]).toBeDefined();
		expect(recallForPromptMock).toHaveBeenCalledTimes(2);
		expect(recallForPromptMock).toHaveBeenLastCalledWith(
			"different question",
			undefined,
		);
	});

	it("does not re-run recall after a miss for the same prompt", async () => {
		recallForPromptMock.mockResolvedValue(null);
		const { pi, emit } = makePi();
		extension(pi as never);

		const first = await emit("context", contextEvent("hello"));
		const second = await emit("context", contextEvent("hello"));

		expect(first).toEqual([undefined]);
		expect(second).toEqual([undefined]);
		expect(recallForPromptMock).toHaveBeenCalledTimes(1);
	});

	it("reads text from array content parts", async () => {
		recallForPromptMock.mockResolvedValue(null);
		const { pi, emit } = makePi();
		extension(pi as never);

		await emit(
			"context",
			contextEvent([
				{ type: "text", text: "hello " },
				{ type: "text", text: "world" },
			]),
		);

		expect(recallForPromptMock).toHaveBeenCalledWith("hello world", undefined);
	});

	it("resets recall dedupe on session_start and session_tree", async () => {
		recallForPromptMock.mockResolvedValue(null);
		const { pi, emit } = makePi();
		extension(pi as never);

		await emit("context", contextEvent("hello"));
		await emit("context", contextEvent("hello"));
		expect(recallForPromptMock).toHaveBeenCalledTimes(1);

		// A new session (resume/new) or a branch navigation must re-recall
		// the same prompt: the previous session's or branch's dedupe state
		// does not carry over.
		await emit("session_start", { type: "session_start" });
		await emit("context", contextEvent("hello"));
		expect(recallForPromptMock).toHaveBeenCalledTimes(2);

		// Same prompt again in the new session → dedupe within the session.
		await emit("context", contextEvent("hello"));
		expect(recallForPromptMock).toHaveBeenCalledTimes(2);

		await emit("session_tree", { type: "session_tree", newLeafId: "x" });
		await emit("context", contextEvent("hello"));
		expect(recallForPromptMock).toHaveBeenCalledTimes(3);

		// Compaction drops older messages (including the never-persisted
		// recall block) but leaves the last user prompt unchanged; without a
		// reset the first post-compaction turn would skip recall.
		await emit("session_compact", {
			type: "session_compact",
			trigger: "threshold",
		});
		await emit("context", contextEvent("hello"));
		expect(recallForPromptMock).toHaveBeenCalledTimes(4);
	});

	it("does not throw or retry when recall rejects", async () => {
		recallForPromptMock.mockRejectedValueOnce(new Error("boom"));
		const { pi, emit } = makePi();
		extension(pi as never);

		await expect(emit("context", contextEvent("hello"))).resolves.toEqual([
			undefined,
		]);
		await expect(emit("context", contextEvent("hello"))).resolves.toEqual([
			undefined,
		]);
		expect(recallForPromptMock).toHaveBeenCalledTimes(1);
	});
});
