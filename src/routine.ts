/**
 * Self-improvement routine state: a date file marking the last completed
 * routine run, plus the one-time read of the legacy path owned by the old
 * AGENTS.md prose.
 *
 * fs-only and spawn-free by design. Boot composes the "routine due" line
 * from `routineDue`; the extension never stamps — only a completed routine
 * writes the state, otherwise a session that opens and never runs the
 * routine would claim it had.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Current state location, owned by this extension. */
export const STATE_PATH = join(
	homedir(),
	".pi",
	"agent",
	"pi-memory",
	"last-run.txt",
);

/** Pre-migration location: read as a seed once, never written. */
export const LEGACY_PATH = join(
	homedir(),
	".pi",
	"agent",
	"self-improve",
	"last-run.txt",
);

export interface RoutineState {
	/** True when the routine has not run today (or has never run). */
	due: boolean;
	/** Last completed run as YYYY-MM-DD, or null when never/invalid. */
	lastRun: string | null;
}

/** Strict calendar-date shape; anything else is treated as never-run. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar date; midnight-spanning sessions fire the routine once. */
function localToday(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A missing file is a never-run state; any other read failure is real. */
function isMissing(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Trimmed contents when the file holds a bare date, else null. A missing
 * file reads as null; every other read error (EACCES, EISDIR, EIO) is
 * rethrown so the caller never mistakes a broken read for "never run".
 */
async function readDate(path: string): Promise<string | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		if (isMissing(err)) return null;
		throw err;
	}
	const trimmed = text.trim();
	return DATE.test(trimmed) ? trimmed : null;
}

/**
 * Stamp `date` (YYYY-MM-DD) as the last completed run, creating the parent
 * directory when missing. Only a finished routine should call this.
 */
export async function markRun(statePath: string, date: string): Promise<void> {
	await mkdir(dirname(statePath), { recursive: true });
	await writeFile(statePath, `${date}\n`);
}

/**
 * Resolve whether the routine is due by `today`. On a missing state file the
 * legacy file is consulted and its valid date seeds the new state path, so a
 * run completed before the move does not fire again. Invalid content reads as
 * never-run; a missing file reads as never-run, but a non-missing read error
 * (EACCES, EISDIR, …) is propagated so a broken state cannot fake a due line.
 */
export async function routineDue(
	statePath: string = STATE_PATH,
	legacyPath: string = LEGACY_PATH,
	today: string = localToday(),
): Promise<RoutineState> {
	let lastRun = await readDate(statePath);

	if (lastRun === null) {
		const legacy = await readDate(legacyPath);
		if (legacy !== null) {
			lastRun = legacy;
			try {
				await markRun(statePath, legacy);
			} catch {
				// Seeding is best-effort: the answer still reflects the legacy date.
			}
		}
	}

	return { due: lastRun !== today, lastRun };
}
