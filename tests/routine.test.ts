import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LEGACY_PATH,
	markRun,
	routineDue,
	STATE_PATH,
} from "../src/routine.js";

// Routine state is plain fs (no spawns): every case uses a real tmpdir so
// the read/seed/write behavior is exercised end to end, never mocked.
const TODAY = "2026-10-31";

let root: string;
let statePath: string;
let legacyPath: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-memory-routine-"));
	statePath = join(root, "pi-memory", "last-run.txt");
	legacyPath = join(root, "self-improve", "last-run.txt");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function writeState(path: string, content: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
}

describe("routineDue", () => {
	it("is due when the state file is missing", async () => {
		const state = await routineDue(statePath, legacyPath, TODAY);

		expect(state).toEqual({ due: true, lastRun: null });
		await expect(readFile(statePath, "utf8")).rejects.toThrow();
	});

	it("is due when the last run is stale", async () => {
		await writeState(statePath, "2026-10-30\n");

		const state = await routineDue(statePath, legacyPath, TODAY);

		expect(state).toEqual({ due: true, lastRun: "2026-10-30" });
	});

	it("is not due when the state file holds today", async () => {
		await writeState(statePath, `${TODAY}\n`);

		const state = await routineDue(statePath, legacyPath, TODAY);

		expect(state).toEqual({ due: false, lastRun: TODAY });
	});

	it("treats invalid state content as never-run", async () => {
		await writeState(statePath, "not a date\n");

		const state = await routineDue(statePath, legacyPath, TODAY);

		expect(state).toEqual({ due: true, lastRun: null });
	});

	it("is due from a valid legacy date and seeds the new state path", async () => {
		await writeState(legacyPath, "2026-10-15\n");

		const state = await routineDue(statePath, legacyPath, TODAY);

		expect(state).toEqual({ due: true, lastRun: "2026-10-15" });
		expect(await readFile(statePath, "utf8")).toBe("2026-10-15\n");
	});

	it("treats a legacy date equal to today as already run", async () => {
		await writeState(legacyPath, `${TODAY}\n`);

		const state = await routineDue(statePath, legacyPath, TODAY);

		expect(state).toEqual({ due: false, lastRun: TODAY });
		expect(await readFile(statePath, "utf8")).toBe(`${TODAY}\n`);
	});

	it("ignores an invalid legacy date and never seeds", async () => {
		await writeState(legacyPath, "yesterday\n");

		const state = await routineDue(statePath, legacyPath, TODAY);

		expect(state).toEqual({ due: true, lastRun: null });
		await expect(readFile(statePath, "utf8")).rejects.toThrow();
	});

	it("ignores legacy state when the state file exists", async () => {
		await writeState(statePath, "2026-10-20\n");
		await writeState(legacyPath, "2026-10-15\n");

		const state = await routineDue(statePath, legacyPath, TODAY);

		expect(state).toEqual({ due: true, lastRun: "2026-10-20" });
		expect(await readFile(statePath, "utf8")).toBe("2026-10-20\n");
	});

	it("propagates a non-ENOENT state read error instead of reporting never-run", async () => {
		// A directory at the state path fails readFile with EISDIR on every
		// platform this package targets (no chmod needed).
		await mkdir(statePath, { recursive: true });

		await expect(
			routineDue(statePath, legacyPath, TODAY),
		).rejects.toMatchObject({ code: "EISDIR" });
	});

	it("propagates a non-ENOENT legacy read error when the state file is missing", async () => {
		await mkdir(legacyPath, { recursive: true });

		await expect(
			routineDue(statePath, legacyPath, TODAY),
		).rejects.toMatchObject({ code: "EISDIR" });
	});
});

describe("markRun", () => {
	it("creates missing parent directories and writes a trailing newline", async () => {
		const nested = join(root, "deep", "nested", "last-run.txt");

		await markRun(nested, TODAY);

		expect(await readFile(nested, "utf8")).toBe(`${TODAY}\n`);
	});

	it("stamps the run so the routine is no longer due", async () => {
		await mkdir(join(statePath, ".."), { recursive: true });
		await markRun(statePath, TODAY);

		const state = await routineDue(statePath, legacyPath, TODAY);

		expect(state).toEqual({ due: false, lastRun: TODAY });
	});
});

describe("paths", () => {
	it("points the state file at ~/.pi/agent/pi-memory and the legacy seed elsewhere", () => {
		expect(
			STATE_PATH.endsWith(join(".pi", "agent", "pi-memory", "last-run.txt")),
		).toBe(true);
		expect(
			LEGACY_PATH.endsWith(
				join(".pi", "agent", "self-improve", "last-run.txt"),
			),
		).toBe(true);
	});
});
