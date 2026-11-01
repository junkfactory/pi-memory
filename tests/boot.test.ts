import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BOOT_MARKER,
	bootSection,
	resetBinaryCache,
	resolveBinary,
} from "../src/boot.js";
import * as routine from "../src/routine.js";

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

// Routine state is plain fs (no spawns): every case points bootSection at a
// real tmpdir, so neither the due check nor legacy seeding touches ~/.pi.
const TODAY = "2026-10-31";

let root: string;
let statePath: string;
let legacyPath: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-memory-boot-"));
	statePath = join(root, "pi-memory", "last-run.txt");
	legacyPath = join(root, "self-improve", "last-run.txt");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** bootSection wired to the tmpdir state files instead of the real ones. */
const boot = () => bootSection({ statePath, legacyPath, today: TODAY });

describe("bootSection", () => {
	beforeEach(() => {
		execFileMock.queue = [];
	});

	it("returns formatted section on success", async () => {
		execFileMock.queue = ["# ai-memory boot: info\nversion: 0.10.0"];
		const out = await boot();
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
		await expect(boot()).resolves.toBeNull();
	});

	it("returns null on non-zero exit", async () => {
		execFileMock.queue = [new Error("exit 1")];
		await expect(boot()).resolves.toBeNull();
	});

	it("returns null when binary is missing", async () => {
		execFileMock.queue = [new Error("spawn ai-memory ENOENT")];
		await expect(boot()).resolves.toBeNull();
	});
});

describe("routine due line", () => {
	beforeEach(() => {
		execFileMock.queue = [
			"# ai-memory boot: ok\n#   db: /Users/me/memory.db (schema=v80)\n- [long/fad33ada] some memory",
		];
	});

	it("flags the routine as never run when no state file exists", async () => {
		const out = await boot();
		const section = out ?? "";

		expect(out).toContain(
			"# self-improvement: routine due (last run: never) — run the AGENTS.md routine first",
		);
		// Inside the boot block: after the marker and rows, before OPS.
		expect(section.indexOf(BOOT_MARKER)).toBeLessThan(
			section.indexOf("# self-improvement:"),
		);
		expect(section.indexOf("- [long/fad33ada]")).toBeLessThan(
			section.indexOf("# self-improvement:"),
		);
		expect(section.indexOf("# self-improvement:")).toBeLessThan(
			section.indexOf("# Memory usage"),
		);
		// Composed before redaction, so db redaction still applies.
		expect(out).not.toContain("memory.db");
	});

	it("shows the stale last-run date when the routine is due", async () => {
		await mkdir(join(statePath, ".."), { recursive: true });
		await writeFile(statePath, "2026-10-30\n");

		const out = await boot();

		expect(out).toContain(
			"# self-improvement: routine due (last run: 2026-10-30) — run the AGENTS.md routine first",
		);
	});

	it("omits the line when the routine already ran today", async () => {
		await mkdir(join(statePath, ".."), { recursive: true });
		await writeFile(statePath, `${TODAY}\n`);

		const out = await boot();

		expect(out).not.toContain("self-improvement");
		expect(out).toContain(BOOT_MARKER);
		expect(out).toContain("# Memory usage");
	});

	it("drops the line but keeps the section when routine state cannot be read", async () => {
		const spy = vi
			.spyOn(routine, "routineDue")
			.mockRejectedValueOnce(new Error("EACCES: permission denied"));
		try {
			const out = await boot();

			expect(out).not.toContain("self-improvement");
			expect(out).toContain(`${BOOT_MARKER}\n# ai-memory boot: ok`);
			expect(out).toContain("# Memory usage");
		} finally {
			spy.mockRestore();
		}
	});

	it("drops the line but keeps the section on a real (non-ENOENT) read error", async () => {
		// A directory at the state path makes readFile fail with EISDIR: the
		// error must reach boot.ts's catch, not read as "never run".
		await mkdir(statePath, { recursive: true });

		const out = await boot();

		expect(out).not.toContain("self-improvement");
		expect(out).toContain(`${BOOT_MARKER}\n# ai-memory boot: ok`);
		expect(out).toContain("# Memory usage");
	});
});

describe("global boot merge", () => {
	const cwdBody =
		"# ai-memory boot: ok\n#   version: 0.10.0\n- [long/aaaaaaa] cwd memory";
	const globalArgs = [
		"boot",
		"--quiet",
		"--namespace",
		"global",
		"--limit",
		"20",
	];

	beforeEach(() => {
		execFileMock.queue = [];
	});

	it("keeps global rows when the cwd pass succeeds with empty output", async () => {
		execFileMock.queue = [
			"  \n  ",
			"# ai-memory boot: global\n- [long/ccccccc] global only",
		];

		const out = await boot();

		expect(out).toContain(BOOT_MARKER);
		expect(out).toContain("- [long/ccccccc] global only");
		expect(out).toContain("# self-improvement: routine due");
		expect(execFileMock).toHaveBeenCalledWith(
			"ai-memory",
			globalArgs,
			expect.objectContaining({ timeout: 10_000 }),
			expect.any(Function),
		);
	});

	it("returns null when the cwd pass is empty and the global pass fails", async () => {
		execFileMock.queue = ["  \n  ", new Error("exit 2")];

		await expect(boot()).resolves.toBeNull();
	});

	it("leaves the section unchanged when the global pass fails", async () => {
		execFileMock.queue = [cwdBody, new Error("exit 2")];

		const out = await boot();

		expect(out).toContain(cwdBody);
		expect(out).not.toContain("bbbbbbb");
		expect(execFileMock).toHaveBeenCalledWith(
			"ai-memory",
			globalArgs,
			expect.objectContaining({ timeout: 10_000 }),
			expect.any(Function),
		);
	});

	it("leaves the section unchanged when the global pass is empty", async () => {
		execFileMock.queue = [cwdBody, "# ai-memory boot: global\n"];

		const out = await boot();

		expect(out).toContain(cwdBody);
		expect(out).not.toContain("ai-memory boot: global");
	});

	it("drops a global row whose id already appears in the cwd rows", async () => {
		execFileMock.queue = [
			cwdBody,
			"# ai-memory boot: global\n- [long/aaaaaaa] cwd memory\n- [long/ccccccc] global only",
		];

		const out = (await boot()) ?? "";

		expect(out.match(/aaaaaaa/g)).toHaveLength(1);
		expect(out).toContain("- [long/ccccccc] global only");
		expect(out.match(/- \[long\//g)).toHaveLength(2);
	});

	it("appends distinct global rows after the cwd rows, before the due line", async () => {
		execFileMock.queue = [
			cwdBody,
			"# ai-memory boot: global\n- [long/ccccccc] global only",
		];

		const out = (await boot()) ?? "";

		const cwdRow = out.indexOf("- [long/aaaaaaa] cwd memory");
		const globalRow = out.indexOf("- [long/ccccccc] global only");
		expect(cwdRow).toBeGreaterThanOrEqual(0);
		expect(globalRow).toBeGreaterThan(cwdRow);
		expect(globalRow).toBeLessThan(out.indexOf("# self-improvement:"));
		expect(out.indexOf(BOOT_MARKER)).toBeLessThan(cwdRow);
	});

	it("keeps only the global pass's rows, not its header lines", async () => {
		execFileMock.queue = [
			cwdBody,
			"# ai-memory boot: global\n#   db: /Users/me/memory.db\n#   tier: semantic\n- [short/bbbbbbb] global only",
		];

		const out = (await boot()) ?? "";

		expect(out).toContain("- [short/bbbbbbb] global only");
		expect(out).not.toContain("ai-memory boot: global");
		expect(out).not.toContain("tier: semantic", "only the cwd header remains");
		expect(out.split(`\n\n${BOOT_MARKER}\n`)).toHaveLength(2);
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
		const out = await boot();
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
		await expect(boot()).resolves.toBeNull();
		await expect(boot()).resolves.toBeNull();
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
		const out = await boot();
		expect(out).toBeDefined();
		expect(out).not.toContain(".agents/memory");
		expect(out).toContain("#   version: 0.10.0");
		expect(out).toContain("- [long/fad33ada] some memory");
	});

	it("strips a db line without comment decoration", async () => {
		execFileMock.queue = [
			"# ai-memory boot: ok\ndb: /Users/me/memory.db (schema=v80)\n#   tier: semantic",
		];
		const out = await boot();
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
