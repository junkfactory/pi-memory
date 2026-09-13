/**
 * pi-memory
 *
 * Pi extension injecting ai-memory boot context into every session's
 * system prompt. Pairs with the ai-memory CLI
 * (https://github.com/junkfactory/pi-memory); store/recall stay on the CLI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BOOT_MARKER, bootSection } from "./boot.js";

export default function extension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		// Pi resets extension system-prompt changes at the start of every
		// turn unless an extension re-applies them (agent-session.js resets
		// to the base prompt whenever no handler returns a systemPrompt),
		// and compaction never re-fires session_start — so a one-shot
		// per-session injection silently disappears from turn 1 onward.
		// Re-inject whenever the chained prompt lacks the marker; skip
		// when it is already present (our own override persisted from the
		// previous turn, or an `ai-memory wrap` injection).
		if (event.systemPrompt.includes(BOOT_MARKER)) return undefined;
		const section = await bootSection();
		// Nothing to inject (missing binary, empty DB, failed spawn).
		// Returning without a systemPrompt lets pi reset to base; the
		// next turn retries, so a transient boot failure self-heals.
		if (section === null) return undefined;
		return { systemPrompt: event.systemPrompt + section };
	});
}
