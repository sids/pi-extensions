import { describe, expect, test } from "bun:test";
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
		expect(isApplePlatform("MacIntel")).toBeTrue();
		expect(isApplePlatform("iPhone")).toBeTrue();
		expect(isApplePlatform("Linux x86_64")).toBeFalse();
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
		).toBeTrue();
		expect(
			isCommentSendShortcut(
				{
					key: "Enter",
					metaKey: false,
					ctrlKey: true,
				},
				"MacIntel",
			),
		).toBeFalse();
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
		).toBeTrue();
		expect(
			isCommentSendShortcut(
				{
					key: "Enter",
					metaKey: true,
					ctrlKey: false,
				},
				"Linux x86_64",
			),
		).toBeFalse();
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
		).toBeFalse();
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
		).toBeFalse();
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
		).toBeTrue();
		expect(
			isSendAllShortcut(
				{
					key: "Enter",
					metaKey: true,
					ctrlKey: false,
				},
				"MacIntel",
			),
		).toBeFalse();
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
		).toBeTrue();
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
		).toBeFalse();
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
		).toBeTrue();
		expect(
			isFocusSearchShortcut({
				key: "T",
				metaKey: false,
				ctrlKey: false,
				shiftKey: true,
			}),
		).toBeFalse();
	});

	test("detects the refresh shortcut", () => {
		expect(
			isRefreshShortcut({
				key: "r",
				metaKey: false,
				ctrlKey: false,
			}),
		).toBeTrue();
		expect(
			isRefreshShortcut({
				key: "r",
				metaKey: false,
				ctrlKey: true,
			}),
		).toBeFalse();
	});
});
