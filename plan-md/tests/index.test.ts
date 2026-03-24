import { describe, expect, test } from "bun:test";
import planMdExtension from "../index";

type Handler = (event: any, ctx: any) => any;

function createHarness(entries: any[]) {
	const handlers = new Map<string, Handler[]>();
	const appendedEntries: Array<{ customType: string; data: any }> = [];
	const sentMessages: any[] = [];
	let activeTools: string[] = [];

	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		appendEntry(customType: string, data: any) {
			appendedEntries.push({ customType, data });
			entries.push({ type: "custom", customType, data });
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(nextTools: string[]) {
			activeTools = nextTools;
		},
		registerMessageRenderer() {},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		sendMessage(message: any) {
			sentMessages.push(message);
		},
	} as any;

	planMdExtension(pi);

	const ctx = {
		hasUI: false,
		cwd: "/tmp",
		ui: {
			notify() {},
			setWidget() {},
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionFile: () => undefined,
			getSessionDir: () => "/tmp",
			getSessionId: () => "session-1",
		},
	} as any;

	async function emit(name: string, event: any = {}) {
		const list = handlers.get(name) ?? [];
		let result;
		for (const handler of list) {
			result = await handler(event, ctx);
		}
		return result;
	}

	return {
		emit,
		appendedEntries,
		sentMessages,
	};
}

describe("plan-md prompt injection", () => {
	test("posts the prompt only once until the session is compacted", async () => {
		const entries = [
			{
				type: "custom",
				customType: "plan-md:state",
				data: {
					version: 1,
					active: true,
					planFilePath: "/tmp/session-1.plan.md",
					promptPending: true,
				},
			},
		];
		const harness = createHarness(entries);

		await harness.emit("session_start");

		const firstResult = await harness.emit("before_agent_start", { prompt: "first" });
		expect(firstResult).toMatchObject({
			message: {
				customType: "plan-md:context",
				display: false,
			},
		});
		expect(typeof firstResult.message.content).toBe("string");
		expect(firstResult.message.content.length).toBeGreaterThan(0);

		const secondResult = await harness.emit("before_agent_start", { prompt: "second" });
		expect(secondResult).toBeUndefined();

		await harness.emit("session_compact");
		expect(harness.sentMessages).toEqual([
			{
				customType: "plan-md:prompt",
				content: "Plan mode instructions",
				display: true,
				details: {
					instructionsPrompt: expect.any(String),
				},
			},
		]);

		const thirdResult = await harness.emit("before_agent_start", { prompt: "third" });
		expect(thirdResult).toMatchObject({
			message: {
				customType: "plan-md:context",
				display: false,
			},
		});

		expect(
			harness.appendedEntries
				.filter((entry) => entry.customType === "plan-md:state")
				.map((entry) => entry.data.promptPending),
		).toEqual([false, true, false]);
	});
});
