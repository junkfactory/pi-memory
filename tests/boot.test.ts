import { beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_MARKER, bootSection } from "../src/boot.js";

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
		expect(out).toBe(
			`\n\n${BOOT_MARKER}\n# ai-memory boot: info\nversion: 0.10.0`,
		);
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
