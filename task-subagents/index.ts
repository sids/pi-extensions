import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SteerSubagentSchema, SubagentsSchema } from "./schemas";
import { registerSubagentTools } from "./subagents";

export default function (pi: ExtensionAPI) {
	registerSubagentTools(pi, {
		subagentsSchema: SubagentsSchema,
		steerSubagentSchema: SteerSubagentSchema,
	});
}
