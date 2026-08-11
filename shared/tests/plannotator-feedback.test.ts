import { describe, expect, test } from "vitest";
import {
	formatPlannotatorFeedbackForPi,
	handlePlannotatorDecision,
	PLANNOTATOR_FEEDBACK_MESSAGE_TYPE,
	registerPlannotatorFeedbackRenderer,
} from "../plannotator-feedback";

function createHarness(isIdle = true) {
	const renderers = new Map<string, unknown>();
	const sentMessages: Array<{ message: any; options?: unknown }> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const pi = {
		registerMessageRenderer(type: string, renderer: unknown) {
			renderers.set(type, renderer);
		},
		sendMessage(message: any, options?: unknown) {
			sentMessages.push({ message, options });
		},
	} as any;
	const ctx = {
		hasUI: true,
		isIdle: () => isIdle,
		ui: {
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
		},
	} as any;
	return { pi, ctx, renderers, sentMessages, notifications };
}

describe("Plannotator feedback display", () => {
	test("removes only the generated outer blockquote", () => {
		const feedback = [
			"# Message Feedback",
			"",
			"## 1. Feedback on a line",
			"> The actual feedback",
			"> > Intentional nested quote",
		].join("\n");

		expect(formatPlannotatorFeedbackForPi(feedback)).toBe([
			"# Message Feedback",
			"",
			"## 1. Feedback on a line",
			"The actual feedback",
			"> Intentional nested quote",
		].join("\n"));
	});

	test("registers the shared custom message renderer", () => {
		const harness = createHarness();
		registerPlannotatorFeedbackRenderer(harness.pi);
		expect(harness.renderers.has(PLANNOTATOR_FEEDBACK_MESSAGE_TYPE)).toBe(true);
	});
});

describe("Plannotator decision handling", () => {
	test("preserves raw feedback sent to the model", async () => {
		const harness = createHarness();
		const feedback = "# Feedback\n\n> First line\n> > Intentional nested quote";

		await handlePlannotatorDecision(
			harness.pi,
			harness.ctx,
			{ feedback },
			{ notifications: { sent: "Feedback sent." } },
		);

		expect(harness.sentMessages).toEqual([{
			message: {
				customType: PLANNOTATOR_FEEDBACK_MESSAGE_TYPE,
				content: feedback,
				display: true,
			},
			options: { triggerTurn: true },
		}]);
		expect(harness.notifications).toEqual([{ message: "Feedback sent.", level: "info" }]);
	});

	test("queues raw feedback while the agent is busy", async () => {
		const harness = createHarness(false);

		await handlePlannotatorDecision(harness.pi, harness.ctx, { feedback: "> Keep this quote" });

		expect(harness.sentMessages[0]).toMatchObject({
			message: { content: "> Keep this quote" },
			options: { deliverAs: "followUp" },
		});
	});

	test("uses an explicit feedback delivery mode regardless of agent state", async () => {
		const harness = createHarness(false);

		await handlePlannotatorDecision(
			harness.pi,
			harness.ctx,
			{ feedback: "Steer the active agent" },
			{ delivery: "steer" },
		);

		expect(harness.sentMessages[0]).toMatchObject({
			message: { content: "Steer the active agent" },
			options: { deliverAs: "steer", triggerTurn: true },
		});
	});

	test("does not send approval notes", async () => {
		const harness = createHarness();
		const approved: string[] = [];

		await handlePlannotatorDecision(
			harness.pi,
			harness.ctx,
			{ approved: true, feedback: "Non-blocking note" },
			{
				onApproved: (feedback) => approved.push(feedback),
				notifications: { approved: "Approved." },
			},
		);

		expect(approved).toEqual(["Non-blocking note"]);
		expect(harness.sentMessages).toEqual([]);
	});

	test("does not send closed or empty decisions", async () => {
		const closed = createHarness();
		await handlePlannotatorDecision(
			closed.pi,
			closed.ctx,
			{ exit: true },
			{ notifications: { closed: "Closed." } },
		);

		const empty = createHarness();
		await handlePlannotatorDecision(
			empty.pi,
			empty.ctx,
			{ feedback: "  " },
			{ notifications: { empty: "No feedback." } },
		);

		expect(closed.sentMessages).toEqual([]);
		expect(empty.sentMessages).toEqual([]);
	});
});
