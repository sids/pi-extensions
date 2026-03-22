export type PlanModeState = {
	version: number;
	active: boolean;
	originLeafId?: string | null;
	planFilePath?: string;
	lastPlanLeafId?: string;
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
