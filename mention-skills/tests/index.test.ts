import { describe, expect, test } from "bun:test";
import mentionSkillsExtension from "../index";

type Handler = (event: any, ctx: any) => any;

function createHarness(commands: any[]) {
	const handlers = new Map<string, Handler[]>();

	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		getCommands() {
			return commands;
		},
	} as any;

	mentionSkillsExtension(pi);

	return {
		async emit(name: string, event: any = {}, ctx: any = {}) {
			const list = handlers.get(name) ?? [];
			let result;
			for (const handler of list) {
				result = await handler(event, ctx);
			}
			return result;
		},
	};
}

describe("mention-skills extension", () => {
	test("installs a custom editor on session start", async () => {
		const harness = createHarness([{ name: "skill:commit", source: "skill", path: "/skills/commit/SKILL.md" }]);
		let installedFactory: ((...args: any[]) => unknown) | undefined;

		await harness.emit(
			"session_start",
			{},
			{
				hasUI: true,
				ui: {
					setEditorComponent: (factory: typeof installedFactory) => {
						installedFactory = factory;
					},
				},
			},
		);

		expect(typeof installedFactory).toBe("function");
	});

	test("transforms skill mentions using discovered skills", async () => {
		const harness = createHarness([
			{ name: "skill:commit", source: "skill", path: "/skills/commit/SKILL.md" },
			{ name: "skill:pdf", source: "skill", path: "/skills/pdf/SKILL.md" },
		]);

		await harness.emit("resources_discover");

		const result = await harness.emit(
			"input",
			{ text: "Use $commit and $pdf", images: [], source: "interactive" },
			{},
		);

		expect(result).toEqual({
			action: "transform",
			text: "Use /skills/commit/SKILL.md and /skills/pdf/SKILL.md",
			images: [],
		});
	});
});
