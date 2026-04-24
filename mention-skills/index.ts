import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	buildSkillAutocompleteItems,
	collectDiscoveredSkills,
	createMentionAutocompleteProvider,
	replaceSkillMentions,
} from "./utils";

export default function (pi: ExtensionAPI) {
	let skillMap = new Map<string, string>();
	let skillItems = buildSkillAutocompleteItems(skillMap);

	function refreshSkillMap() {
		skillMap = collectDiscoveredSkills(pi.getCommands());
		skillItems = buildSkillAutocompleteItems(skillMap);
	}

	pi.on("session_start", (_event, ctx) => {
		refreshSkillMap();
		if (ctx.hasUI) {
			ctx.ui.addAutocompleteProvider((current) => createMentionAutocompleteProvider(current, () => skillItems));
		}
	});

	pi.on("resources_discover", () => {
		refreshSkillMap();
	});

	pi.on("input", (event, _ctx) => {
		if (skillMap.size === 0) {
			return { action: "continue" as const };
		}
		const replaced = replaceSkillMentions(event.text, skillMap);
		if (replaced === event.text) {
			return { action: "continue" as const };
		}
		return { action: "transform" as const, text: replaced, images: event.images };
	});
}
