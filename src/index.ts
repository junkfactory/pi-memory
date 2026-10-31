/**
 * pi-memory
 *
 * Pi extension injecting ai-memory boot context into every session's
 * system prompt. Pairs with the ai-memory CLI
 * (https://github.com/junkfactory/pi-memory); store/recall stay on the CLI.
 */

import { createHash } from "node:crypto";
import type {
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { BOOT_MARKER, bootSection, resolveBinary } from "./boot.js";
import { recallForPrompt } from "./recall.js";

/** Text of a user message: plain string or an array of text content parts. */
function userText(message: unknown): string | null {
	if (typeof message !== "object" || message === null) return null;
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	return content
		.map((part) =>
			typeof part === "object" &&
			part !== null &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.join("");
}

export default function extension(pi: ExtensionAPI): void {
	// Last user-prompt hash this session already recalled for. Keeps the
	// repeated `context` events within one turn (tool-call iterations) from
	// re-running recall. In-memory only; never persisted.
	let lastPromptHash: string | null = null;

	// Async binary resolution rules out load-time registration, so this
	// runs on session_start. Skips when an `ai-memory` server already
	// exists (earlier registration or mcp.json entry) and registers nothing
	// when the binary is absent.
	pi.on("session_start", async () => {
		// Dedupe state is per session branch: resume/new must not inherit the
		// previous session's hash or its first recall would be suppressed.
		lastPromptHash = null;
		if (pi.getMcpServers().some((server) => server.name === "ai-memory")) {
			return;
		}
		const command = await resolveBinary();
		if (command === null) return;
		try {
			pi.registerMcpServer("ai-memory", {
				command,
				args: ["mcp"],
				description: "ai-memory CLI — store/recall/search learned memories",
			});
		} catch {
			// A duplicate registered by another extension since our guard ran:
			// theirs wins; never fatal.
		}
	});

	// Branch navigation swaps the transcript; the hash is per branch, so a
	// return to a branch whose prompt was already recalled must re-recall.
	pi.on("session_tree", () => {
		lastPromptHash = null;
	});

	// Compaction replaces older messages with a summary. The recall block was
	// never persisted (ephemeral per request), while the last user prompt is
	// unchanged — without this reset the first post-compaction turn would
	// silently skip recall, exactly when context memory is scarcest.
	pi.on("session_compact", () => {
		lastPromptHash = null;
	});

	pi.on(
		"context",
		async (
			event: ContextEvent,
			ctx,
		): Promise<ContextEventResult | undefined> => {
			try {
				const messages = event.messages ?? [];
				let prompt: string | null = null;
				for (let i = messages.length - 1; i >= 0; i--) {
					const message = messages[i] as { role?: unknown };
					if (message?.role !== "user") continue;
					prompt = userText(message);
					break;
				}
				if (prompt === null) return undefined;

				const hash = createHash("sha256").update(prompt).digest("hex");
				if (hash === lastPromptHash) return undefined;
				// Record before awaiting: a miss (or failure) must not re-run for
				// later tool-call iterations of the same turn.
				lastPromptHash = hash;

				const block = await recallForPrompt(prompt, ctx?.signal);
				if (block === null) return undefined;
				return {
					messages: [
						...messages,
						{ role: "user" as const, content: block, timestamp: Date.now() },
					],
				};
			} catch {
				// Recall must never block or fail a turn.
				return undefined;
			}
		},
	);

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
