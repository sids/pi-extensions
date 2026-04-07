import { describe, expect, test } from "bun:test";
import planMdExtension from "../index";

type Handler = (event: any, ctx: any) => any;

function createHarness(entries: any[]) {
	const handlers = new Map<string, Handler[]>();
	const appendedEntries: Array<{ customType: string; data: any }> = [];
	const sentMessages: any[] = [];
	const tools: any[] = [];
	const messageRenderers = new Map<string, any>();
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
		registerMessageRenderer(customType: string, renderer: any) {
			messageRenderers.set(customType, renderer);
		},
		registerTool(tool: any) {
			tools.push(tool);
		},
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
		messageRenderers,
		sentMessages,
		tools,
	};
}

describe("plan-md prompt injection", () => {
	test("registers plan mode tools with prompt snippets", async () => {
		const harness = createHarness([]);
		const toolByName = new Map(harness.tools.map((tool) => [tool.name, tool]));

		expect(toolByName.get("set_plan")?.promptSnippet).toBe(
			"Overwrite the current plan file with the latest full plan text.",
		);
		expect(toolByName.get("request_user_input")?.promptSnippet).toBe(
			"Ask the user one or more short questions and wait for answers.",
		);
	});

	test("set_plan throws when plan mode is inactive", async () => {
		const harness = createHarness([]);
		const setPlanTool = harness.tools.find((tool) => tool.name === "set_plan");
		if (!setPlanTool) {
			throw new Error("set_plan tool was not registered");
		}

		let error: unknown;
		try {
			await setPlanTool.execute("call-1", { plan: "Goal\n- Step 1" }, undefined, undefined, {
				cwd: "/tmp",
				hasUI: false,
				sessionManager: {
					getEntries: () => [],
					getSessionFile: () => undefined,
					getSessionDir: () => "/tmp",
					getSessionId: () => "session-1",
				},
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("plan mode is active");
	});

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
					activationId: undefined,
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

	test("hides stale plan mode prompt messages when inactive or from another activation", async () => {
		const entries = [
			{
				type: "custom",
				customType: "plan-md:state",
				data: {
					version: 1,
					active: true,
					activationId: "plan-current",
					planFilePath: "/tmp/session-1.plan.md",
				},
			},
		];
		const harness = createHarness(entries);
		await harness.emit("session_start");

		const renderer = harness.messageRenderers.get("plan-md:prompt");
		expect(renderer).toBeDefined();

		const theme = {
			bg: (_name: string, text: string) => text,
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		} as any;

		expect(
			renderer(
				{
					content: "Plan mode instructions",
					details: {
						activationId: "plan-old",
						instructionsPrompt: "Plan prompt",
					},
				},
				{ expanded: false },
				theme,
			),
		).toBeUndefined();

		entries.push({
			type: "custom",
			customType: "plan-md:state",
			data: {
				version: 1,
				active: false,
				planFilePath: "/tmp/session-1.plan.md",
			},
		});
		await harness.emit("session_tree");

		expect(
			renderer(
				{
					content: "Plan mode instructions",
					details: {
						activationId: "plan-current",
						instructionsPrompt: "Plan prompt",
					},
				},
				{ expanded: false },
				theme,
			),
		).toBeUndefined();
	});
});
