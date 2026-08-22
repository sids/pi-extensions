import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { QnATuiComponent } from "../qna-tui";

describe("QnATuiComponent", () => {
	test("keeps every rendered line within a narrow terminal width", () => {
		const questions = Array.from({ length: 8 }, (_, index) => ({
			header: `Question ${index + 1}`,
			question: "May the tool create one webhook per repository and persist the specific PRs being watched?",
			context: "GitHub webhooks are repository-scoped rather than PR-scoped.",
		}));
		const component = new QnATuiComponent(
			questions,
			{ requestRender() {}, terminal: { rows: 24, columns: 37 } } as any,
			() => {},
		);

		const lines = component.render(37);

		expect(lines.every((line) => visibleWidth(line) <= 37)).toBe(true);
	});
});
