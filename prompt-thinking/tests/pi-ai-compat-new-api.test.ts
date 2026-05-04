import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NEW_PI_AI_STUB = `
export function getSupportedThinkingLevels() {
	return ["off", "minimal", "high", "provider-specific", "xhigh"];
}
`;

describe("getAvailableThinkingLevels with newer pi-ai API", () => {
	test("uses getSupportedThinkingLevels when supportsXhigh is unavailable", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "prompt-thinking-new-pi-ai-"));
		try {
			await mkdir(join(tempDir, "node_modules", "@mariozechner", "pi-ai"), { recursive: true });
			await writeFile(join(tempDir, "package.json"), JSON.stringify({ type: "module" }));
			await writeFile(join(tempDir, "utils.ts"), await Bun.file(new URL("../utils.ts", import.meta.url)).text());
			await writeFile(
				join(tempDir, "node_modules", "@mariozechner", "pi-ai", "package.json"),
				JSON.stringify({ type: "module", exports: "./index.ts" }),
			);
			await writeFile(join(tempDir, "node_modules", "@mariozechner", "pi-ai", "index.ts"), NEW_PI_AI_STUB);

			const loaded = await import(join(tempDir, "utils.ts"));

			expect(loaded.getAvailableThinkingLevels({ id: "reasoning-model", reasoning: true })).toEqual([
				"off",
				"minimal",
				"high",
				"xhigh",
			]);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
