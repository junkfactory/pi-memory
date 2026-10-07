import { beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_MARKER } from "../src/boot.js";
import extension from "../src/index.js";

vi.mock("../src/boot.js", () => ({
	BOOT_MARKER: "# ai-memory boot",
	bootSection: vi.fn(),
}));

const bootSectionMock = vi.mocked((await import("../src/boot.js")).bootSection);

function makePi() {
	const handlers: Record<string, Array<(event?: unknown) => unknown>> = {};
	return {
		pi: {
			on: (name: string, fn: (event?: unknown) => unknown) => {
				const list = handlers[name] ?? [];
				list.push(fn);
				handlers[name] = list;
			},
		},
		emit: async (name: string, event?: unknown) =>
			Promise.all((handlers[name] ?? []).map((fn) => fn(event))),
	};
}

function turnEvent(
	systemPrompt = "base prompt",
	sections: Record<string, string> = {},
) {
	return { systemPrompt, prompt: "hi", systemPromptOptions: { sections } };
}

describe("index", () => {
	beforeEach(() => {
		bootSectionMock.mockReset();
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
});
