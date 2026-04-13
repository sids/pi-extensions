import { describe, expect, test } from "bun:test";
import { getAppLayoutClassName } from "../web/layout";

describe("getAppLayoutClassName", () => {
	test("uses the normal layout when the sidebar is expanded", () => {
		expect(getAppLayoutClassName(false, false)).toBe("app-layout");
	});

	test("uses the collapsed layout when the sidebar is collapsed", () => {
		expect(getAppLayoutClassName(true, false)).toBe("app-layout app-layout--sidebar-collapsed");
	});

	test("adds the popover class when the sidebar drawer is open", () => {
		expect(getAppLayoutClassName(false, true)).toBe("app-layout app-layout--sidebar-popover-open");
	});
});
