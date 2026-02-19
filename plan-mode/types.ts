export type PlanModeState = {
	version: number;
	active: boolean;
	originLeafId?: string;
	planFilePath?: string;
	lastPlanLeafId?: string;
};

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
	output: string;
	references: string[];
	exitCode: number;
	stderr: string;
	activities: SubagentActivity[];
	startedAt: number;
	finishedAt: number;
	steeringNotes: string[];
};

export type SubagentTaskProgress = {
	taskId: string;
	prompt: string;
	status: "queued" | "running" | "completed" | "failed";
	latestActivity?: string;
	activityCount: number;
};

export type SubagentRunDetails = {
	runId: string;
	tasks: SubagentTaskResult[];
	successCount: number;
	totalCount: number;
};

export type SubagentProgressDetails = {
	runId: string;
	completed: number;
	total: number;
	tasks: SubagentTaskProgress[];
};

export type SubagentRunRecord = {
	runId: string;
	createdAt: number;
	tasks: SubagentTaskResult[];
};

export type RequestUserInputOption = {
	label: string;
	description: string;
};

export type RequestUserInputQuestion = {
	id: string;
	header: string;
	question: string;
	options?: RequestUserInputOption[];
};

export type NormalizedRequestUserInputQuestion = Omit<RequestUserInputQuestion, "options"> & {
	options: RequestUserInputOption[];
};

export type RequestUserInputAnswer = {
	answers: string[];
};

export type RequestUserInputResponse = {
	answers: Record<string, RequestUserInputAnswer>;
};

export type RequestUserInputDetails = {
	questions: NormalizedRequestUserInputQuestion[];
	response: RequestUserInputResponse;
};
