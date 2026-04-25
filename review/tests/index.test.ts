import { describe, expect, test } from "bun:test";
import { initTheme } from "@mariozechner/pi-coding-agent";
import reviewExtension from "../index";

initTheme(undefined, false);

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

describe("review change summary renderer", () => {
	test("shows a short preview until expanded", () => {
		const harness = createHarness([]);
		const renderer = harness.messageRenderers.get("review-mode:change-summary");
		expect(renderer).toBeDefined();

		const theme = {
			bg: (_name: string, text: string) => text,
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		} as any;
		const message = {
			content: ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n"),
		};

		const collapsed = renderer(message, { expanded: false }, theme).render(120).join("\n");
		expect(collapsed).toContain("line 1");
		expect(collapsed).toContain("line 4");
		expect(collapsed).not.toContain("line 5");
		expect(collapsed).toContain("to expand");

		const expanded = renderer(message, { expanded: true }, theme).render(120).join("\n");
		expect(expanded).toContain("line 5");
		expect(expanded).not.toContain("to expand");
	});
});

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
