import { describe, expect, test } from "vitest";
import {
	getCommentSendHint,
	getSendAllHint,
	isApplePlatform,
	isCommentSendShortcut,
	isFocusSearchShortcut,
	isRefreshShortcut,
	isSendAllShortcut,
} from "../web/shortcuts";

describe("comment shortcuts", () => {
	test("detects Apple platforms", () => {
		expect(isApplePlatform("MacIntel")).toBe(true);
		expect(isApplePlatform("iPhone")).toBe(true);
		expect(isApplePlatform("Linux x86_64")).toBe(false);
	});

	test("uses cmd+enter on Apple platforms", () => {
		expect(
			isCommentSendShortcut(
				{
					key: "Enter",
					metaKey: true,
					ctrlKey: false,
				},
				"MacIntel",
			),
		).toBe(true);
		expect(
			isCommentSendShortcut(
				{
					key: "Enter",
					metaKey: false,
					ctrlKey: true,
				},
				"MacIntel",
			),
		).toBe(false);
	});

	test("uses ctrl+enter on non-Apple platforms", () => {
		expect(
			isCommentSendShortcut(
				{
					key: "Enter",
					metaKey: false,
					ctrlKey: true,
				},
				"Linux x86_64",
			),
		).toBe(true);
		expect(
			isCommentSendShortcut(
				{
					key: "Enter",
					metaKey: true,
					ctrlKey: false,
				},
				"Linux x86_64",
			),
		).toBe(false);
	});

	test("does not trigger comment send on plain enter or shift+enter", () => {
		expect(
			isCommentSendShortcut(
				{
					key: "Enter",
					metaKey: false,
					ctrlKey: false,
				},
				"MacIntel",
			),
		).toBe(false);
		expect(
			isCommentSendShortcut(
				{
					key: "Enter",
					metaKey: true,
					ctrlKey: false,
					shiftKey: true,
				},
				"MacIntel",
			),
		).toBe(false);
	});

	test("returns the correct comment send hint", () => {
		expect(getCommentSendHint("MacIntel")).toBe("⌘↵");
		expect(getCommentSendHint("Linux x86_64")).toBe("Ctrl+↵");
	});

	test("uses cmd+alt+enter for send all on Apple platforms", () => {
		expect(
			isSendAllShortcut(
				{
					key: "Enter",
					metaKey: true,
					ctrlKey: false,
					altKey: true,
				},
				"MacIntel",
			),
		).toBe(true);
		expect(
			isSendAllShortcut(
				{
					key: "Enter",
					metaKey: true,
					ctrlKey: false,
				},
				"MacIntel",
			),
		).toBe(false);
	});

	test("uses ctrl+alt+enter for send all on non-Apple platforms", () => {
		expect(
			isSendAllShortcut(
				{
					key: "Enter",
					metaKey: false,
					ctrlKey: true,
					altKey: true,
				},
				"Linux x86_64",
			),
		).toBe(true);
		expect(
			isSendAllShortcut(
				{
					key: "Enter",
					metaKey: false,
					ctrlKey: true,
					altKey: false,
				},
				"Linux x86_64",
			),
		).toBe(false);
	});

	test("returns the correct send all hint", () => {
		expect(getSendAllHint("MacIntel")).toBe("⌘⌥↵");
		expect(getSendAllHint("Linux x86_64")).toBe("Ctrl+Alt+↵");
	});

	test("detects the search shortcut", () => {
		expect(
			isFocusSearchShortcut({
				key: "t",
				metaKey: false,
				ctrlKey: false,
			}),
		).toBe(true);
		expect(
			isFocusSearchShortcut({
				key: "T",
				metaKey: false,
				ctrlKey: false,
				shiftKey: true,
			}),
		).toBe(false);
	});

	test("detects the refresh shortcut", () => {
		expect(
			isRefreshShortcut({
				key: "r",
				metaKey: false,
				ctrlKey: false,
			}),
		).toBe(true);
		expect(
			isRefreshShortcut({
				key: "r",
				metaKey: false,
				ctrlKey: true,
			}),
		).toBe(false);
	});
});
