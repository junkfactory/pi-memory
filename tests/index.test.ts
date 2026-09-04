import { describe, expect, it, vi, beforeEach } from "vitest";
import extension from "../src/index.js";
import { BOOT_MARKER } from "../src/boot.js";

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
				(handlers[name] ??= []).push(fn);
			},
		},
		emit: async (name: string, event?: unknown) => Promise.all((handlers[name] ?? []).map((fn) => fn(event))),
	};
}

function turnEvent(systemPrompt = "base prompt") {
	return { systemPrompt, prompt: "hi" };
}

describe("index", () => {
	beforeEach(() => {
		bootSectionMock.mockReset();
	});

	it("injects boot section on first turn", async () => {
		bootSectionMock.mockResolvedValue(`\n\n${BOOT_MARKER}\ninfo`);
		const { pi, emit } = makePi();
		extension(pi as never);
		emit("session_start", { reason: "startup" });

		const result = await emit("before_agent_start", turnEvent());
		expect(result[0]).toEqual({
			systemPrompt: `base prompt\n\n${BOOT_MARKER}\ninfo`,
		});
	});

	it("does not inject on subsequent turns", async () => {
		bootSectionMock.mockResolvedValue(`\n\n${BOOT_MARKER}\ninfo`);
		const { pi, emit } = makePi();
		extension(pi as never);
		emit("session_start", { reason: "startup" });

		await emit("before_agent_start", turnEvent());
		const second = await emit("before_agent_start", turnEvent("base prompt\n\n# ai-memory boot\ninfo"));
		expect(bootSectionMock).toHaveBeenCalledTimes(1);
		expect(second[0]).toBeUndefined();
	});

	it("skips injection when wrap already injected boot output", async () => {
		bootSectionMock.mockResolvedValue(null);
		const { pi, emit } = makePi();
		extension(pi as never);
		emit("session_start", { reason: "startup" });

		const result = await emit("before_agent_start", turnEvent(`base\n\n${BOOT_MARKER}\nexisting`));
		expect(result[0]).toBeUndefined();
		expect(bootSectionMock).not.toHaveBeenCalled();
	});

	it("does not retry after a failed boot within the same session", async () => {
		bootSectionMock.mockResolvedValue(null);
		const { pi, emit } = makePi();
		extension(pi as never);
		emit("session_start", { reason: "startup" });

		await emit("before_agent_start", turnEvent());
		await emit("before_agent_start", turnEvent());
		expect(bootSectionMock).toHaveBeenCalledTimes(1);
	});

	it("re-boots after a new session starts", async () => {
		bootSectionMock.mockResolvedValue(`\n\n${BOOT_MARKER}\ninfo`);
		const { pi, emit } = makePi();
		extension(pi as never);
		emit("session_start", { reason: "startup" });
		await emit("before_agent_start", turnEvent());

		emit("session_start", { reason: "new" });
		const result = await emit("before_agent_start", turnEvent());
		expect(bootSectionMock).toHaveBeenCalledTimes(2);
		expect(result[0]).toBeDefined();
	});
});
