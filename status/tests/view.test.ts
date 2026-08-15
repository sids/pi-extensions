import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { renderStatusDetails, renderStatusHeader, type StatusDetailsPayload } from "../view";

const plainTheme = {
	fg: (_name: string, text: string) => text,
} as Theme;

const taggedTheme = {
	fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
} as Theme;

const detailsPayload: StatusDetailsPayload = {
	modelLabel: "gpt-5.4",
	thinkingLevel: "high",
	openAIParamsLabel: "/fast 🗣low",
	contextLabel: "43%/128k",
	contextUsage: 42.6,
	agentMinutesLabel: "1m",
	turnTotalMinutesLabel: "2m",
	sessionMinutesLabel: "3m",
};

describe("renderStatusHeader", () => {
	test("renders a dim repository path without an empty PR line", () => {
		const lines = renderStatusHeader(
			{ repoLabel: "~/src/project (main)", sessionName: null, pullRequest: null },
			taggedTheme,
			120,
		);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("<dim>~/src/project (main)</dim>");
	});

	test("renders structured PR data below the path", () => {
		const lines = renderStatusHeader(
			{
				repoLabel: "~/src/project (main)",
				sessionName: "release",
				pullRequest: { url: "https://github.com/org/repo/pull/42", state: "MERGED" },
			},
			taggedTheme,
			160,
		);

		expect(lines[0]).toContain("<accent>release</accent>");
		expect(lines[1]).toContain("<accent>https://github.com/org/repo/pull/42</accent>");
		expect(lines[1]).toContain("<dim> (merged)</dim>");
	});
});

describe("renderStatusDetails", () => {
	test("renders model details on the left and timing on the right", () => {
		const line = renderStatusDetails(detailsPayload, plainTheme, 120)[0] ?? "";

		expect(line.trimStart()).toMatch(/^gpt-5\.4 \(high \/fast 🗣low\) 43%\/128k/);
		expect(line.trimEnd()).toMatch(/1m agent · 2m turn total · 3m session$/);
	});

	test("preserves the left details when the available width is narrow", () => {
		const width = 48;
		const line = renderStatusDetails(detailsPayload, plainTheme, width)[0] ?? "";

		expect(line).toContain("gpt-5.4 (high /fast 🗣low) 43%/128k");
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});
