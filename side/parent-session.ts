import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ParentSessionSnapshot } from "./summary";

const MAX_UPDATE_ENTRIES = 50;
const MAX_READ_ENTRIES = 20;
const MAX_SEARCH_RESULTS = 30;
const DEFAULT_UPDATE_ENTRIES = 20;
const DEFAULT_SEARCH_RESULTS = 10;

export type ParentEntryRole = "user" | "assistant" | "toolResult" | "custom";

export interface SanitizedParentEntry {
	id: string;
	role: ParentEntryRole;
	text: string;
}

export interface ParentSessionStatus {
	summaryLeafId?: string;
	currentLeafId?: string;
	parentState: "idle" | "running";
	unreadCount: number;
	branchChanged: boolean;
	cursor?: string;
	cursorOnBranch: boolean;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return !!part && typeof part === "object" && (part as { type?: string }).type === "text";
		})
		.map((part) => part.text)
		.join("\n");
}

function sanitizeArgumentValue(value: unknown, key?: string, depth: number = 0): unknown {
	if (key && /^(?:data|base64|image|images|contentBytes)$/i.test(key)) {
		return "[binary content omitted]";
	}
	if (typeof value === "string") {
		return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (depth >= 5) {
		return "[nested value omitted]";
	}
	if (Array.isArray(value)) {
		return value.slice(0, 20).map((item) => sanitizeArgumentValue(item, undefined, depth + 1));
	}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.slice(0, 40)
			.map(([nestedKey, nestedValue]) => [nestedKey, sanitizeArgumentValue(nestedValue, nestedKey, depth + 1)]),
	);
}

function formatArguments(value: unknown): string {
	try {
		return JSON.stringify(sanitizeArgumentValue(value));
	} catch {
		return "[unserializable arguments]";
	}
}

export function sanitizeParentEntry(entry: SessionEntry): SanitizedParentEntry | null {
	if (entry.type === "custom_message") {
		return {
			id: entry.id,
			role: "custom",
			text: textFromContent(entry.content),
		};
	}
	if (entry.type !== "message") {
		return null;
	}

	const message = entry.message;
	if (message.role === "user") {
		return { id: entry.id, role: "user", text: textFromContent(message.content) };
	}
	if (message.role === "assistant") {
		const parts: string[] = [];
		for (const content of message.content) {
			if (content.type === "text") {
				parts.push(content.text);
			} else if (content.type === "toolCall") {
				parts.push(`Tool call: ${content.name} ${formatArguments(content.arguments)}`);
			}
		}
		return { id: entry.id, role: "assistant", text: parts.join("\n") };
	}
	if (message.role === "toolResult") {
		return {
			id: entry.id,
			role: "toolResult",
			text: `${message.toolName}: ${textFromContent(message.content)}`,
		};
	}
	if (message.role === "custom") {
		return { id: entry.id, role: "custom", text: textFromContent(message.content) };
	}
	if (message.role === "bashExecution") {
		return {
			id: entry.id,
			role: "toolResult",
			text: `Command: ${message.command}\n${message.output}`,
		};
	}
	return null;
}

function truncateEntries(entries: SanitizedParentEntry[]) {
	const serialized = JSON.stringify(entries, null, 2);
	const truncated = truncateHead(serialized, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	return {
		text: truncated.content,
		truncated: truncated.truncated,
		totalBytes: truncated.totalBytes,
		outputBytes: truncated.outputBytes,
	};
}

function toolResult(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: data,
	};
}

function truncatedToolResult(data: Record<string, unknown>, entries: SanitizedParentEntry[]) {
	const truncated = truncateEntries(entries);
	const result = {
		...data,
		entries: truncated.truncated ? undefined : entries,
		truncated: truncated.truncated,
		...(truncated.truncated
			? {
				serializedEntries: truncated.text,
				truncation: {
					outputBytes: truncated.outputBytes,
					totalBytes: truncated.totalBytes,
				},
			}
			: {}),
	};
	return toolResult(result);
}

export class ParentSessionView {
	private disposed = false;
	private lastInspectedCursor?: string;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionContext,
		private readonly snapshot: ParentSessionSnapshot,
	) {}

	dispose(): void {
		this.disposed = true;
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	private identityMatches(): boolean {
		return (
			this.ctx.sessionManager.getSessionId() === this.snapshot.sessionId &&
			this.ctx.sessionManager.getSessionFile() === this.snapshot.sessionFile
		);
	}

	private activeBranch(): SessionEntry[] {
		return this.ctx.sessionManager.getBranch() as SessionEntry[];
	}

	private unreadEntries(branch: SessionEntry[]): SessionEntry[] {
		if (this.lastInspectedCursor) {
			const cursorIndex = branch.findIndex((entry) => entry.id === this.lastInspectedCursor);
			if (cursorIndex >= 0) {
				return branch.slice(cursorIndex + 1);
			}
		}
		return branch.filter((entry) => !this.snapshot.entryIds.has(entry.id));
	}

	status(): ParentSessionStatus {
		const branch = this.activeBranch();
		const currentLeafId = branch.at(-1)?.id;
		const summaryIndex = this.snapshot.leafId
			? branch.findIndex((entry) => entry.id === this.snapshot.leafId)
			: -1;
		const cursorOnBranch = !this.lastInspectedCursor || branch.some((entry) => entry.id === this.lastInspectedCursor);
		return {
			summaryLeafId: this.snapshot.leafId,
			currentLeafId,
			parentState: this.ctx.isIdle() ? "idle" : "running",
			unreadCount: this.unreadEntries(branch).length,
			branchChanged: Boolean(this.snapshot.leafId && summaryIndex < 0) || !cursorOnBranch,
			cursor: this.lastInspectedCursor,
			cursorOnBranch,
		};
	}

	updates(after?: string, requestedLimit: number = DEFAULT_UPDATE_ENTRIES) {
		const branch = this.activeBranch();
		const limit = Math.max(1, Math.min(MAX_UPDATE_ENTRIES, Math.floor(requestedLimit)));
		const cursor = after || this.lastInspectedCursor || this.snapshot.leafId;
		let entries: SessionEntry[];
		let branchChanged = false;

		if (cursor) {
			const index = branch.findIndex((entry) => entry.id === cursor);
			if (index < 0) {
				entries = [];
				branchChanged = true;
			} else {
				entries = branch.slice(index + 1);
			}
		} else {
			entries = branch.filter((entry) => !this.snapshot.entryIds.has(entry.id));
		}

		const page = entries.slice(0, limit);
		const sanitized = page
			.map(sanitizeParentEntry)
			.filter((entry): entry is SanitizedParentEntry => entry !== null);
		const nextCursor = page.at(-1)?.id ?? cursor;
		if (nextCursor && !branchChanged) {
			this.lastInspectedCursor = nextCursor;
		}
		return {
			cursor,
			nextCursor,
			remaining: Math.max(0, entries.length - page.length),
			branchChanged,
			entries: sanitized,
		};
	}

	search(query: string, roles?: ParentEntryRole[], requestedLimit: number = DEFAULT_SEARCH_RESULTS) {
		const normalized = query.trim().toLowerCase();
		const roleSet = roles?.length ? new Set(roles) : null;
		const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(requestedLimit)));
		const matches = this.activeBranch()
			.map(sanitizeParentEntry)
			.filter((entry): entry is SanitizedParentEntry => entry !== null)
			.filter((entry) => !roleSet || roleSet.has(entry.role))
			.filter((entry) => entry.text.toLowerCase().includes(normalized))
			.slice(-limit)
			.map((entry) => ({
				id: entry.id,
				role: entry.role,
				snippet: entry.text.replace(/\s+/g, " ").slice(0, 500),
			}));
		return { query, matches };
	}

	read(entryIds: string[]) {
		const requested = entryIds.slice(0, MAX_READ_ENTRIES);
		const branch = this.activeBranch();
		const branchById = new Map(branch.map((entry) => [entry.id, entry]));
		const missing = requested.filter((id) => !branchById.has(id));
		const entries = requested
			.map((id) => branchById.get(id))
			.filter((entry): entry is SessionEntry => !!entry)
			.map(sanitizeParentEntry)
			.filter((entry): entry is SanitizedParentEntry => entry !== null);
		return { entries, missing, limited: entryIds.length > MAX_READ_ENTRIES };
	}

	async sendMessage(message: string, mode: "steer" | "followUp") {
		const text = message.trim();
		if (!text) {
			return { status: "rejected", reason: "Message must not be empty." };
		}
		if (this.disposed || !this.identityMatches()) {
			return { status: "stale", reason: "The parent session has been replaced or the side chat is closing." };
		}

		this.pi.sendUserMessage(text, { deliverAs: mode });
		return {
			status: mode === "steer" ? "sent" : "queued",
			mode,
			message: text,
		};
	}
}

const RoleSchema = StringEnum(["user", "assistant", "toolResult", "custom"] as const);
const DeliverySchema = StringEnum(["steer", "followUp"] as const);

export function createParentSessionTools(view: ParentSessionView): ToolDefinition[] {
	return [
		{
			name: "main_session_status",
			label: "Main session status",
			description: "Report whether the live main chat changed after the side-chat summary. Use this when current parent state matters.",
			parameters: Type.Object({}, { additionalProperties: false }),
			constrainedSampling: false,
			async execute() {
				return toolResult(view.status());
			},
		},
		{
			name: "main_session_updates",
			label: "Main session updates",
			description: "Read finalized messages and tool activity added to the live main chat after a stable cursor.",
			parameters: Type.Object(
				{
					after: Type.Optional(Type.String()),
					limit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_UPDATE_ENTRIES })),
				},
				{ additionalProperties: false },
			),
			constrainedSampling: false,
			async execute(_id, params: any) {
				const result = view.updates(params.after, params.limit);
				return truncatedToolResult(
					{
						cursor: result.cursor,
						nextCursor: result.nextCursor,
						remaining: result.remaining,
						branchChanged: result.branchChanged,
					},
					result.entries,
				);
			},
		},
		{
			name: "main_session_search",
			label: "Search main session",
			description: "Search finalized text on the main chat's current active branch and return entry IDs and snippets.",
			parameters: Type.Object(
				{
					query: Type.String({ minLength: 1 }),
					roles: Type.Optional(Type.Array(RoleSchema)),
					limit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
				},
				{ additionalProperties: false },
			),
			constrainedSampling: false,
			async execute(_id, params: any) {
				return toolResult(view.search(params.query, params.roles, params.limit));
			},
		},
		{
			name: "main_session_read",
			label: "Read main session entries",
			description: "Read exact sanitized content for bounded entry IDs on the main chat's current active branch.",
			parameters: Type.Object(
				{
					entryIds: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_READ_ENTRIES }),
				},
				{ additionalProperties: false },
			),
			constrainedSampling: { type: "json_schema", strict: "prefer" },
			async execute(_id, params: any) {
				const result = view.read(params.entryIds);
				return truncatedToolResult({ missing: result.missing, limited: result.limited }, result.entries);
			},
		},
		{
			name: "main_session_send_message",
			label: "Send message to main chat",
			description: "After the side-chat user explicitly asks to affect the main chat, send the exact message as steer or followUp. Never call this proactively.",
			parameters: Type.Object(
				{
					message: Type.String({ minLength: 1 }),
					mode: DeliverySchema,
				},
				{ additionalProperties: false },
			),
			constrainedSampling: { type: "json_schema", strict: "prefer" },
			async execute(_id, params: any) {
				return toolResult(await view.sendMessage(params.message, params.mode));
			},
		},
	] as ToolDefinition[];
}
