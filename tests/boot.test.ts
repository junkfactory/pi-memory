import { homedir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	BOOT_MARKER,
	bootSection,
	resetBinaryCache,
	resolveBinary,
} from "../src/boot.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	execFile: (...args: unknown[]) => execFileMock(...args),
}));

// node:child_process is mocked, so promisify wraps our mock. Easier to
// stub the promisified call target: promisify(execFile) calls execFile with
// (file, args, options, callback). Provide a callback-style impl.
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

describe("bootSection", () => {
	beforeEach(() => {
		execFileMock.queue = [];
	});

	it("returns formatted section on success", async () => {
		execFileMock.queue = ["# ai-memory boot: info\nversion: 0.10.0"];
		const out = await bootSection();
		expect(out).toContain(
			`\n\n${BOOT_MARKER}\n# ai-memory boot: info\nversion: 0.10.0`,
		);
		expect(out).toContain("# Memory usage");
		expect(out).toContain("Destructive");
		expect(execFileMock).toHaveBeenCalledWith(
			"ai-memory",
			["boot", "--quiet"],
			expect.objectContaining({ timeout: 10_000 }),
			expect.any(Function),
		);
	});

	it("returns null on empty output (quiet + empty DB)", async () => {
		execFileMock.queue = ["  \n  "];
		await expect(bootSection()).resolves.toBeNull();
	});

	it("returns null on non-zero exit", async () => {
		execFileMock.queue = [new Error("exit 1")];
		await expect(bootSection()).resolves.toBeNull();
	});

	it("returns null when binary is missing", async () => {
		execFileMock.queue = [new Error("spawn ai-memory ENOENT")];
		await expect(bootSection()).resolves.toBeNull();
	});
});

describe("fallback spawn", () => {
	beforeEach(() => {
		execFileMock.queue = [];
	});

	it("retries at ~/.cargo/bin when the bare name fails", async () => {
		execFileMock.queue = [
			new Error("spawn ai-memory ENOENT"),
			"# ai-memory boot: info",
		];
		const out = await bootSection();
		expect(out).toContain(BOOT_MARKER);
		expect(execFileMock).toHaveBeenCalledWith(
			join(homedir(), ".cargo", "bin", "ai-memory"),
			["boot", "--quiet"],
			expect.objectContaining({ timeout: 10_000 }),
			expect.any(Function),
		);
	});

	it("returns null and warns exactly once when both spawns fail", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		execFileMock.queue = [
			new Error("spawn ai-memory ENOENT"),
			new Error("spawn ENOENT"),
		];
		await expect(bootSection()).resolves.toBeNull();
		await expect(bootSection()).resolves.toBeNull();
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toContain("[pi-memory]");
		warnSpy.mockRestore();
	});
});

describe("redactPaths (via bootSection)", () => {
	it("strips the db path line, keeps the rest", async () => {
		execFileMock.queue = [
			"# ai-memory boot: ok\n#   version: 0.10.0\n#   db: /Users/amielmontecillo/.agents/memory/ai-memory.db (schema=v80, 6 memories)\n#   tier: semantic\n- [long/fad33ada] some memory",
		];
		const out = await bootSection();
		expect(out).toBeDefined();
		expect(out).not.toContain(".agents/memory");
		expect(out).toContain("#   version: 0.10.0");
		expect(out).toContain("- [long/fad33ada] some memory");
	});

	it("strips a db line without comment decoration", async () => {
		execFileMock.queue = [
			"# ai-memory boot: ok\ndb: /Users/me/memory.db (schema=v80)\n#   tier: semantic",
		];
		const out = await bootSection();
		expect(out).not.toContain("memory.db");
		expect(out).toContain("#   tier: semantic");
	});
});

describe("resolveBinary", () => {
	beforeEach(() => {
		execFileMock.queue = [];
		execFileMock.mockClear();
		resetBinaryCache();
	});

	it("caches a positive probe and skips re-probing", async () => {
		execFileMock.queue = ["ai-memory 0.10.0"];

		await expect(resolveBinary()).resolves.toBe("ai-memory");
		await expect(resolveBinary()).resolves.toBe("ai-memory");
		expect(execFileMock).toHaveBeenCalledTimes(1);
	});

	it("treats a miss as valid for 60s, then re-probes for a fresh install", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			execFileMock.queue = [
				new Error("spawn ENOENT"),
				new Error("spawn ENOENT"),
			];
			await expect(resolveBinary()).resolves.toBeNull();
			expect(execFileMock).toHaveBeenCalledTimes(2);

			// Inside the TTL a miss is reused: no probe spawns at all.
			vi.setSystemTime(30_000);
			await expect(resolveBinary()).resolves.toBeNull();
			expect(execFileMock).toHaveBeenCalledTimes(2);

			// Past the TTL it re-probes and a fresh install self-heals.
			vi.setSystemTime(61_000);
			execFileMock.queue = ["ai-memory 0.10.0"];
			await expect(resolveBinary()).resolves.toBe("ai-memory");
			expect(execFileMock).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});
});
