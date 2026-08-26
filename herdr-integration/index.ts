import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHerdrReporter, type HerdrAgentState, type HerdrReporter } from "./herdr-client";
import {
	appendInputNeededInstruction,
	hasInputNeededMarker,
	isHerdrSession,
	parseWaitingForUserInputEvent,
	stripInputNeededMarker,
} from "./utils";

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
	createReporter: (env: Record<string, string | undefined>) => HerdrReporter = createHerdrReporter,
) {
	return function herdrIntegrationExtension(pi: ExtensionAPI): void {
		if (!isHerdrSession(env)) {
			return;
		}

		const reporter = createReporter(env);
		let rootSession = false;
		let markerWaiting = false;
		let agentActive = false;
		let lastState: HerdrAgentState | undefined;
		let lastMessage: string | undefined;
		let restoreTimer: ReturnType<typeof setTimeout> | null = null;
		let activeContext: ExtensionContext | null = null;
		const runtimeWaits = new Set<string>();

		const clearRestoreTimer = () => {
			if (restoreTimer === null) {
				return;
			}
			clearTimeout(restoreTimer);
			restoreTimer = null;
		};

		const desiredState = (): { state: HerdrAgentState; message?: string } => {
			if (markerWaiting || runtimeWaits.size > 0) {
				return { state: "blocked", message: BLOCKED_LABEL };
			}
			return { state: agentActive ? "working" : "idle" };
		};

		const reportState = (force = false) => {
			if (!rootSession || !activeContext) {
				return;
			}
			const next = desiredState();
			if (!force && next.state === lastState && next.message === lastMessage) {
				return;
			}
			lastState = next.state;
			lastMessage = next.message;
			reporter.reportState(next.state, next.message, activeContext);
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
			reportState();
		});

		pi.on("before_agent_start", (event) => {
			if (!rootSession) {
				return;
			}
			return { systemPrompt: appendInputNeededInstruction(event.systemPrompt) };
		});

		pi.on("session_start", async (event, ctx) => {
			clearRestoreTimer();
			markerWaiting = false;
			agentActive = false;
			runtimeWaits.clear();
			lastState = undefined;
			lastMessage = undefined;
			activeContext = null;
			rootSession = ctx.mode === "tui";
			if (!rootSession) {
				return;
			}

			activeContext = ctx;
			await reporter.reportSession(ctx, event.reason);
			agentActive = ctx.isIdle() === false;
			reportState(true);

			restoreTimer = setTimeout(() => {
				restoreTimer = null;
				markerWaiting = hasInputNeededMarker(lastUnansweredAssistantText(ctx));
				reportState();
			}, 0);
			restoreTimer.unref?.();
		});

		pi.on("agent_start", (_event, ctx) => {
			if (!rootSession) {
				return;
			}
			clearRestoreTimer();
			activeContext = ctx;
			markerWaiting = false;
			agentActive = true;
			void reporter.reportSession(ctx);
			reportState();
		});

		pi.on("agent_settled", (_event, ctx) => {
			if (!rootSession || ctx.isIdle() !== true) {
				return;
			}
			activeContext = ctx;
			agentActive = false;
			markerWaiting = hasInputNeededMarker(lastUnansweredAssistantText(ctx));
			reportState();
		});

		pi.on("session_shutdown", () => {
			clearRestoreTimer();
			markerWaiting = false;
			agentActive = false;
			runtimeWaits.clear();
			activeContext = null;
			rootSession = false;
		});
	};
}

export default createHerdrIntegrationExtension();
