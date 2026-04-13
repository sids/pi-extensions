import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FileDiff } from "../web/components/file-diff";
import { Toolbar } from "../web/components/toolbar";

describe("ui controls", () => {
	test("renders wrap lines as a checkbox control", () => {
		const markup = renderToStaticMarkup(
			React.createElement(Toolbar, {
				repoName: "diff-cmux",
				targetLabel: "uncommitted",
				viewMode: "unified",
				wrapLines: true,
				unsentCount: 0,
				expired: false,
				onViewModeChange: () => {},
				onWrapToggle: () => {},
				onToggleSidebarPopover: () => {},
				onRefresh: () => {},
				onSendAll: () => {},
			}),
		);

		expect(markup).toContain("Wrap lines");
		expect(markup).toContain('type="checkbox"');
		expect(markup).not.toContain("Disable wrap");
	});

	test("renders viewed as a checkbox control", () => {
		const markup = renderToStaticMarkup(
			React.createElement(FileDiff, {
				file: {
					id: "file-1",
					path: "src/example.ts",
					oldPath: null,
					newPath: "src/example.ts",
					status: "modified",
					anchorId: "file-1",
					isBinary: false,
				},
				payload: null,
				loading: false,
				loadError: null,
				viewMode: "unified",
				wrapLines: true,
				reviewed: true,
				collapsed: true,
				expired: false,
				comments: [],
				onToggleCollapsed: () => {},
				onToggleReviewed: () => {},
				onAddFileComment: () => {},
				onCreateLineComment: () => {},
				onCommentTextChange: () => {},
				onRemoveComment: () => {},
				onToggleCommentCollapsed: () => {},
				isCommentCollapsed: () => false,
				registerCommentTextarea: () => {},
				onSendComment: () => {},
			}),
		);

		expect(markup).toContain("Viewed");
		expect(markup).toContain('type="checkbox"');
		expect(markup).not.toContain("Mark reviewed");
		expect(markup).not.toContain("Mark unreviewed");
	});

	test("renders the add file comment action as an icon button", () => {
		const markup = renderToStaticMarkup(
			React.createElement(FileDiff, {
				file: {
					id: "file-1",
					path: "src/example.ts",
					oldPath: null,
					newPath: "src/example.ts",
					status: "modified",
					anchorId: "file-1",
					isBinary: false,
				},
				payload: null,
				loading: false,
				loadError: null,
				viewMode: "unified",
				wrapLines: true,
				reviewed: true,
				collapsed: true,
				expired: false,
				comments: [],
				onToggleCollapsed: () => {},
				onToggleReviewed: () => {},
				onAddFileComment: () => {},
				onCreateLineComment: () => {},
				onCommentTextChange: () => {},
				onRemoveComment: () => {},
				onToggleCommentCollapsed: () => {},
				isCommentCollapsed: () => false,
				registerCommentTextarea: () => {},
				onSendComment: () => {},
			}),
		);

		expect(markup).toContain('aria-label="Add file comment"');
		expect(markup).toContain("file-section__comment-icon");
		expect(markup).not.toContain("Add file comment</button>");
	});
});
