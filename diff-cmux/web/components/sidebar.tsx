import React from "react";
import type { DiffFileEntry } from "../../types";

type SidebarCounts = {
	unsent: number;
	sent: number;
};

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
	registerSearchInput: (element: HTMLInputElement | null) => void;
	onDismissOverlay: () => void;
	onToggleCollapsed: () => void;
	onSearchChange: (value: string) => void;
	onFileClick: (fileId: string) => void;
};

function dirname(filePath: string): string {
	const index = filePath.lastIndexOf("/");
	return index >= 0 ? filePath.slice(0, index) : ".";
}

function basename(filePath: string): string {
	const index = filePath.lastIndexOf("/");
	return index >= 0 ? filePath.slice(index + 1) : filePath;
}

function statusMarker(status: DiffFileEntry["status"]): string {
	switch (status) {
		case "added":
			return "A";
		case "deleted":
			return "D";
		case "renamed":
			return "R";
		default:
			return "M";
	}
}

export function Sidebar(props: SidebarProps) {
	const groups = new Map<string, DiffFileEntry[]>();
	for (const file of props.files) {
		const directory = dirname(file.path);
		const key = directory === "." ? "(root)" : directory;
		const list = groups.get(key) ?? [];
		list.push(file);
		groups.set(key, list);
	}

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
			{!props.collapsed ? (
				<>
					<div className="sidebar__search-row">
						<input
							ref={props.registerSearchInput}
							className="sidebar__search"
							type="search"
							placeholder="Search files"
							value={props.searchQuery}
							onChange={(event) => props.onSearchChange(event.target.value)}
						/>
						<span className="shortcut-chip">T</span>
					</div>
					<div className="sidebar__groups">
						{Array.from(groups.entries()).map(([group, files]) => (
							<section className="sidebar__group" key={group}>
								<div className="sidebar__group-label">{group}</div>
								{files.map((file) => {
									const counts = props.commentCounts[file.id] ?? { unsent: 0, sent: 0 };
									return (
										<button
											className={`sidebar__file ${props.activeFileId === file.id ? "is-active" : ""}`}
											key={file.id}
											onClick={() => props.onFileClick(file.id)}
										>
											<span className={`sidebar__status sidebar__status--${file.status}`}>{statusMarker(file.status)}</span>
											<span className="sidebar__path">{basename(file.path)}</span>
											{counts.unsent > 0 ? <span className="sidebar__badge sidebar__badge--unsent">{counts.unsent}</span> : null}
											{counts.sent > 0 ? <span className="sidebar__badge">{counts.sent}</span> : null}
											<span className={`sidebar__reviewed ${props.reviewedByFileId[file.id] ? "is-reviewed" : ""}`}>
												{props.reviewedByFileId[file.id] ? "✓" : "○"}
											</span>
										</button>
									);
								})}
							</section>
						))}
					</div>
				</>
			) : null}
		</aside>
	);
}
