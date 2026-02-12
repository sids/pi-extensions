import os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { collectAdditionalSkillPaths } from "./utils";

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", (event) => {
		const skillPaths = collectAdditionalSkillPaths({
			cwd: event.cwd,
			homeDir: os.homedir(),
		});

		if (skillPaths.length === 0) {
			return;
		}

		return { skillPaths };
	});
}
