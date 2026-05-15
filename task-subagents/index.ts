import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SteerSubagentSchema, SubagentsSchema } from "./schemas";
import { registerSubagentTools } from "./subagents";

export default function (pi: ExtensionAPI) {
	registerSubagentTools(pi, {
		subagentsSchema: SubagentsSchema,
		steerSubagentSchema: SteerSubagentSchema,
	});
}
