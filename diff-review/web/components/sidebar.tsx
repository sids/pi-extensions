import React, { useEffect, useMemo, useRef } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";
import type { DiffFileEntry } from "../../types";

type SidebarCounts = {
	unsent: number;
	sent: number;
};

const TREE_SEARCH_CSS = `
[data-file-tree-search-container] {
	box-sizing: border-box !important;
	width: 100% !important;
	min-width: 0 !important;
	max-width: 100% !important;
	padding-inline: 0.75rem !important;
	padding-top: 0.45rem !important;
	overflow: hidden !important;
}

[data-file-tree-search-input] {
	box-sizing: border-box !important;
	width: 100% !important;
	min-width: 0 !important;
	max-width: 100% !important;
	flex: 0 1 auto !important;
}
`;

type SidebarProps = {
	repoName: string;
	targetLabel: string;
	files: DiffFileEntry[];
	activeFileId: string | null;
	searchQuery: string;
	collapsed: boolean;
	overlayMode: boolean;
	commentCounts: Record<string, SidebarCounts>;
	reviewedByFileId: Record<string, boolean>;
	searchRequestCount: number;
	onDismissOverlay: () => void;
	onToggleCollapsed: () => void;
	onSearchChange: (value: string) => void;
	onFileClick: (fileId: string) => void;
};

function statusToGitStatus(status: DiffFileEntry["status"]): GitStatusEntry["status"] {
	switch (status) {
		case "added":
			return "added";
		case "deleted":
			return "deleted";
		case "renamed":
			return "renamed";
		default:
			return "modified";
	}
}

function buildDecoration(file: DiffFileEntry, counts: SidebarCounts | undefined, reviewed: boolean): string {
	const badges = [counts?.unsent ? `${counts.unsent} draft` : null, counts?.sent ? `${counts.sent} sent` : null, reviewed ? "✓" : null].filter(Boolean);
	return badges.join(" · ");
}

export function Sidebar(props: SidebarProps) {
	const fileByPath = useMemo(() => new Map(props.files.map((file) => [file.path, file])), [props.files]);
	const currentPropsRef = useRef(props);
	const currentFileByPathRef = useRef(fileByPath);
	const syncingSelectionRef = useRef(false);
	currentPropsRef.current = props;
	currentFileByPathRef.current = fileByPath;
	const paths = useMemo(() => props.files.map((file) => file.path), [props.files]);
	const gitStatus = useMemo<GitStatusEntry[]>(
		() => props.files.map((file) => ({ path: file.path, status: statusToGitStatus(file.status) })),
		[props.files],
	);
	const activePath = props.files.find((file) => file.id === props.activeFileId)?.path ?? null;
	const { model } = useFileTree({
		paths,
		gitStatus,
		initialExpansion: "open",
		initialSelectedPaths: activePath ? [activePath] : [],
		flattenEmptyDirectories: true,
		icons: "minimal",
		search: true,
		initialSearchQuery: props.searchQuery,
		unsafeCSS: TREE_SEARCH_CSS,
		fileTreeSearchMode: "hide-non-matches",
		searchBlurBehavior: "retain",
		onSearchChange: (value) => currentPropsRef.current.onSearchChange(value ?? ""),
		onSelectionChange: (selectedPaths) => {
			if (syncingSelectionRef.current) {
				return;
			}
			const selectedPath = [...selectedPaths].reverse().find((path) => currentFileByPathRef.current.has(path));
			if (!selectedPath) {
				return;
			}
			const file = currentFileByPathRef.current.get(selectedPath);
			if (file) {
				currentPropsRef.current.onFileClick(file.id);
			}
		},
		renderRowDecoration: ({ item }) => {
			const currentProps = currentPropsRef.current;
			const file = currentFileByPathRef.current.get(item.path);
			if (!file) {
				return null;
			}
			const text = buildDecoration(file, currentProps.commentCounts[file.id], Boolean(currentProps.reviewedByFileId[file.id]));
			return text ? { text } : null;
		},
	});

	useEffect(() => {
		model.resetPaths(paths);
		model.setGitStatus(gitStatus);
	}, [gitStatus, model, paths, props.commentCounts, props.reviewedByFileId]);

	useEffect(() => {
		if (props.searchQuery) {
			model.openSearch(props.searchQuery);
			model.setSearch(props.searchQuery);
			return;
		}
		model.setSearch(null);
	}, [model, props.searchQuery]);

	useEffect(() => {
		if (props.searchRequestCount === 0 || props.collapsed) {
			return;
		}
		model.openSearch(props.searchQuery);
	}, [model, props.collapsed, props.searchQuery, props.searchRequestCount]);

	useEffect(() => {
		if (!activePath) {
			return;
		}
		const selectedPaths = model.getSelectedPaths();
		if (selectedPaths.length === 1 && selectedPaths[0] === activePath) {
			return;
		}
		syncingSelectionRef.current = true;
		for (const selectedPath of selectedPaths) {
			model.getItem(selectedPath)?.deselect();
		}
		const item = model.getItem(activePath);
		item?.select();
		item?.focus();
		const timeout = window.setTimeout(() => {
			syncingSelectionRef.current = false;
		}, 0);
		return () => window.clearTimeout(timeout);
	}, [activePath, model]);

	const handleHeaderAction = props.overlayMode ? props.onDismissOverlay : props.onToggleCollapsed;
	const headerActionLabel = props.overlayMode ? "×" : props.collapsed ? "→" : "←";

	return (
		<aside className={`sidebar ${props.collapsed ? "is-collapsed" : ""} ${props.overlayMode ? "is-overlay" : ""}`}>
			<div className="sidebar__header">
				<button className="sidebar__toggle" onClick={handleHeaderAction} type="button">
					{headerActionLabel}
				</button>
				{!props.collapsed ? (
					<div>
						<div className="sidebar__repo">{props.repoName}</div>
						<div className="sidebar__target">{props.targetLabel}</div>
					</div>
				) : null}
			</div>
			{!props.collapsed ? <FileTree className="sidebar__tree" model={model} /> : null}
		</aside>
	);
}
