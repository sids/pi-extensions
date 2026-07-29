import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSessionPathEquivalence } from "./session-manager";

export default function sessionPaths(pi: ExtensionAPI) {
	const patchState = installSessionPathEquivalence();

	pi.on("session_start", async (_event, ctx) => {
		patchState.currentCwd = ctx.cwd;
		patchState.currentSessionDir = ctx.sessionManager.getSessionDir();
	});

	pi.on("session_shutdown", async () => {
		patchState.uninstall();
	});
}
