import { describe, expect, test } from "bun:test";
import reviewExtension from "../index";

type Handler = (event: any, ctx: any) => any;

function createHarness(entries: any[]) {
	const handlers = new Map<string, Handler[]>();
	const messageRenderers = new Map<string, any>();

	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		appendEntry(_customType: string, data: any) {
			entries.push({ type: "custom", customType: "review-mode:state", data });
		},
		getActiveTools() {
			return [];
		},
		setActiveTools() {},
		registerMessageRenderer(customType: string, renderer: any) {
			messageRenderers.set(customType, renderer);
		},
		registerTool() {},
		registerCommand() {},
	} as any;

	reviewExtension(pi);

	const ctx = {
		hasUI: false,
		cwd: "/tmp",
		ui: {
			notify() {},
			setWidget() {},
		},
		sessionManager: {
			getEntries: () => entries,
		},
	} as any;

	async function emit(name: string, event: any = {}) {
		const list = handlers.get(name) ?? [];
		for (const handler of list) {
			await handler(event, ctx);
		}
	}

	return {
		emit,
		messageRenderers,
	};
}

describe("review prompt renderer", () => {
	test("hides stale review prompts when inactive or from another run", async () => {
		const entries = [
			{
				type: "custom",
				customType: "review-mode:state",
				data: {
					version: 1,
					active: true,
					runId: "review-current",
					targetHint: "current changes",
					reviewInstructionsPrompt: "Review prompt",
				},
			},
		];
		const harness = createHarness(entries);
		await harness.emit("session_start");

		const renderer = harness.messageRenderers.get("review-mode:prompt");
		expect(renderer).toBeDefined();

		const theme = {
			bg: (_name: string, text: string) => text,
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		} as any;

		expect(
			renderer(
				{
					content: "Review instructions",
					details: {
						runId: "review-old",
						targetHint: "current changes",
						instructionsPrompt: "Review prompt",
					},
				},
				{ expanded: false },
				theme,
			),
		).toBeUndefined();

		entries.push({
			type: "custom",
			customType: "review-mode:state",
			data: {
				version: 1,
				active: false,
			},
		});
		await harness.emit("session_tree");

		expect(
			renderer(
				{
					content: "Review instructions",
					details: {
						runId: "review-current",
						targetHint: "current changes",
						instructionsPrompt: "Review prompt",
					},
				},
				{ expanded: false },
				theme,
			),
		).toBeUndefined();
	});
});
