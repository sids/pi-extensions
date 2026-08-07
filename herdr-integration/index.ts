import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	appendInputNeededInstruction,
	hasInputNeededMarker,
	isHerdrSession,
	parseWaitingForUserInputEvent,
	stripInputNeededMarker,
} from "./utils";

const HERDR_BLOCKED_EVENT = "herdr:blocked";
const USER_INPUT_WAIT_EVENT = "pi:waiting-for-user-input";
const BLOCKED_LABEL = "input needed";

function lastUnansweredAssistantText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch();

	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "message") {
			continue;
		}
		if (entry.message.role === "user") {
			return "";
		}
		if (entry.message.role !== "assistant") {
			continue;
		}

		return entry.message.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map((content) => content.text)
			.join("\n");
	}

	return "";
}

export function createHerdrIntegrationExtension(
	env: Record<string, string | undefined> = process.env,
) {
	return function herdrIntegrationExtension(pi: ExtensionAPI): void {
		if (!isHerdrSession(env)) {
			return;
		}

		let rootSession = false;
		let markerWaiting = false;
		let blocked = false;
		let restoreTimer: ReturnType<typeof setTimeout> | null = null;
		const runtimeWaits = new Set<string>();

		const clearRestoreTimer = () => {
			if (restoreTimer === null) {
				return;
			}
			clearTimeout(restoreTimer);
			restoreTimer = null;
		};

		const setBlocked = (active: boolean) => {
			if (blocked === active) {
				return;
			}

			blocked = active;
			pi.events.emit(
				HERDR_BLOCKED_EVENT,
				active ? { active: true, label: BLOCKED_LABEL } : { active: false },
			);
		};

		const syncBlocked = () => {
			setBlocked(markerWaiting || runtimeWaits.size > 0);
		};

		pi.registerMarkdownTransformer((markdown, context) =>
			rootSession && context.messageType === "assistant"
				? stripInputNeededMarker(markdown, context.isStreaming)
				: markdown,
		);

		pi.events.on(USER_INPUT_WAIT_EVENT, (data) => {
			if (!rootSession) {
				return;
			}
			const event = parseWaitingForUserInputEvent(data);
			if (!event) {
				return;
			}

			const key = `${event.source}:${event.id}`;
			if (event.waiting) {
				runtimeWaits.add(key);
			} else {
				runtimeWaits.delete(key);
			}
			syncBlocked();
		});

		pi.on("before_agent_start", (event) => {
			if (!rootSession) {
				return;
			}
			return { systemPrompt: appendInputNeededInstruction(event.systemPrompt) };
		});

		pi.on("session_start", (_event, ctx) => {
			clearRestoreTimer();
			markerWaiting = false;
			runtimeWaits.clear();
			syncBlocked();
			rootSession = ctx.hasUI === true;
			if (!rootSession) {
				return;
			}

			// Herdr ignores blocked events until its own Pi integration has
			// activated the root session, so restore after session_start drains.
			restoreTimer = setTimeout(() => {
				restoreTimer = null;
				markerWaiting = hasInputNeededMarker(lastUnansweredAssistantText(ctx));
				syncBlocked();
			}, 0);
			restoreTimer.unref?.();
		});

		pi.on("agent_start", () => {
			if (!rootSession) {
				return;
			}
			clearRestoreTimer();
			markerWaiting = false;
			syncBlocked();
		});

		pi.on("agent_settled", (_event, ctx) => {
			if (!rootSession) {
				return;
			}
			markerWaiting = hasInputNeededMarker(lastUnansweredAssistantText(ctx));
			syncBlocked();
		});

		pi.on("session_shutdown", () => {
			clearRestoreTimer();
			markerWaiting = false;
			runtimeWaits.clear();
			syncBlocked();
			rootSession = false;
		});
	};
}

export default createHerdrIntegrationExtension();
