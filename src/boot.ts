import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const BOOT_MARKER = "# ai-memory boot";

/**
 * Run `ai-memory boot --quiet` and return the formatted system-prompt
 * section, or null when there is nothing to inject (missing binary,
 * non-zero exit, empty output). Never throws.
 */
export async function bootSection(): Promise<string | null> {
	try {
		const { stdout } = await run("ai-memory", ["boot", "--quiet"], {
			timeout: 10_000,
		});
		const text = stdout.trim();
		if (!text) return null;
		return `\n\n${BOOT_MARKER}\n${text}`;
	} catch {
		return null;
	}
}
