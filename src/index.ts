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
		const sections = event.systemPromptOptions.sections;
		// Transcript-backed sections (pi-coding-agent >= 0.86.0) survive
		// resume and branch navigation with cached prefixes, so a single
		// set carries across turns. The marker check keeps `ai-memory wrap`
		// (which injects the same block into the prompt string) from
		// doubling up.
		if (event.systemPrompt.includes(BOOT_MARKER)) return;
		if (sections.ai_memory_boot !== undefined) return;
		const section = await bootSection();
		// Nothing to inject (missing binary, empty DB, failed spawn).
		// Nothing is set; the next turn retries, so a transient boot
		// failure self-heals.
		if (section === null) return;
		sections.ai_memory_boot = section;
	});
}
