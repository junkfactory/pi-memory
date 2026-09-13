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

		const result = await emit("before_agent_start", turnEvent());
		expect(result[0]).toEqual({
			systemPrompt: `base prompt\n\n${BOOT_MARKER}\ninfo`,
		});
	});

	it("keeps the boot block present across turns", async () => {
		// Pi persists a returned systemPrompt as an override, so the next
		// turn's chained prompt already carries the marker — the extension
		// must skip (no duplicate block, no extra boot call). When no
		// handler returns a systemPrompt, pi resets to base and the
		// extension re-injects. Net effect: marker present every turn.
		bootSectionMock.mockResolvedValue(`\n\n${BOOT_MARKER}\ninfo`);
		const { pi, emit } = makePi();
		extension(pi as never);

		// Turn 0: inject.
		await emit("before_agent_start", turnEvent());
		// Turn 1: pi persisted the override → marker already present.
		const second = await emit(
			"before_agent_start",
			turnEvent(`base prompt\n\n${BOOT_MARKER}\ninfo`),
		);
		expect(second[0]).toBeUndefined();
		// Turn 2: pi reset to base (no handler returned a systemPrompt on
		// turn 1) → re-inject.
		const third = await emit("before_agent_start", turnEvent());
		expect(third[0]).toEqual({
			systemPrompt: `base prompt\n\n${BOOT_MARKER}\ninfo`,
		});
		expect(bootSectionMock).toHaveBeenCalledTimes(2);
	});

	it("skips injection when wrap already injected boot output", async () => {
		const { pi, emit } = makePi();
		extension(pi as never);

		const result = await emit(
			"before_agent_start",
			turnEvent(`base\n\n${BOOT_MARKER}\nexisting`),
		);
		expect(result[0]).toBeUndefined();
		expect(bootSectionMock).not.toHaveBeenCalled();
	});

	it("retries boot on the next turn after a failure", async () => {
		// A transient boot failure must self-heal: the next turn retries
		// instead of staying bootless for the rest of the session.
		bootSectionMock.mockResolvedValueOnce(null);
		bootSectionMock.mockResolvedValueOnce(`\n\n${BOOT_MARKER}\ninfo`);
		const { pi, emit } = makePi();
		extension(pi as never);

		const failed = await emit("before_agent_start", turnEvent());
		expect(failed[0]).toBeUndefined();
		const retried = await emit("before_agent_start", turnEvent());
		expect(retried[0]).toEqual({
			systemPrompt: `base prompt\n\n${BOOT_MARKER}\ninfo`,
		});
		expect(bootSectionMock).toHaveBeenCalledTimes(2);
	});
});
