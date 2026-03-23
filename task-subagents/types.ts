export const SUBAGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const SUBAGENT_TOOL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const SUBAGENT_CONTEXT_MODES = ["fresh", "fork"] as const;

export type SubagentTask = {
	id?: string;
	prompt: string;
	cwd?: string;
};

export type NormalizedSubagentTask = {
	id: string;
	prompt: string;
	cwd?: string;
};

export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];
export type SubagentToolThinkingLevel = (typeof SUBAGENT_TOOL_THINKING_LEVELS)[number];
export type SubagentContextMode = (typeof SUBAGENT_CONTEXT_MODES)[number];

export type ReviewedSubagentTask = {
	taskId: string;
	prompt: string;
	cwd: string;
	modelOverride?: string;
	defaultThinking?: SubagentThinkingLevel;
	thinkingOverride?: SubagentThinkingLevel;
	launchContext: SubagentContextMode;
	launchStatus: "ready" | "cancelled";
	cancellationNote?: string;
};

export type SubagentActivityKind = "status" | "tool" | "assistant" | "toolResult" | "stderr";

export type SubagentActivity = {
	kind: SubagentActivityKind;
	text: string;
	timestamp: number;
};

export type SubagentTaskResult = {
	taskId: string;
	task: string;
	cwd: string;
	status: "completed" | "failed" | "cancelled";
	modelOverride?: string;
	thinkingOverride?: SubagentThinkingLevel;
	launchModel?: string;
	launchThinking?: SubagentThinkingLevel;
	launchContext: SubagentContextMode;
	forkSessionFile?: string;
	cancellationNote?: string;
	output: string;
	references: string[];
	exitCode: number | null;
	stderr: string;
	activities: SubagentActivity[];
	startedAt: number | null;
	finishedAt: number | null;
	steeringNotes: string[];
};

export type SubagentTaskProgress = {
	taskId: string;
	prompt: string;
	cwd: string;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
	modelOverride?: string;
	thinkingOverride?: SubagentThinkingLevel;
	launchContext: SubagentContextMode;
	cancellationNote?: string;
	latestActivity?: string;
	activityCount: number;
};

export type SubagentRunDetails = {
	runId: string;
	tasks: SubagentTaskResult[];
	launchedCount: number;
	successCount: number;
	failedCount: number;
	cancelledCount: number;
	totalCount: number;
};

export type SubagentProgressDetails = {
	runId: string;
	completed: number;
	total: number;
	launchedCount: number;
	succeededCount: number;
	failedCount: number;
	cancelledCount: number;
	tasks: SubagentTaskProgress[];
};

export type SubagentRunRecord = {
	runId: string;
	createdAt: number;
	tasks: SubagentTaskResult[];
};
