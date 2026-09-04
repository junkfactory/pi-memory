/**
 * pi-memory
 *
 * Pi extension injecting ai-memory boot context into every session's
 * system prompt at the first agent turn. Pairs with the ai-memory CLI
 * (https://github.com/junkfactory/pi-memory); store/recall stay on the CLI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BOOT_MARKER, bootSection } from "./boot.js";

export default function extension(pi: ExtensionAPI): void {
	let booted = false;

	// One shot per session: reset on every new/resumed/forked session so
	// memory state changes between sessions are picked up.
	pi.on("session_start", () => {
		booted = false;
	});

	pi.on("before_agent_start", async (event) => {
		// Boot output belongs at turn 0 only...
		if (booted) return undefined;
		// ...and not at all if something else (e.g. `ai-memory wrap`)
		// already injected it.
		if (event.systemPrompt.includes(BOOT_MARKER)) {
			booted = true;
			return undefined;
		}
		const section = await bootSection();
		if (section === null) {
			// Nothing to inject (missing binary, empty DB, failed spawn).
			// Mark done so we don't retry on every turn.
			booted = true;
			return undefined;
		}
		booted = true;
		return { systemPrompt: event.systemPrompt + section };
	});
}
