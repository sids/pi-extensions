import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ServerResponse } from "node:http";
import { html as sendHtml } from "@plannotator/pi-extension/server/helpers.ts";
import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const packageDir = dirname(require.resolve("@plannotator/pi-extension/package.json"));
const htmlFiles = ["plannotator.html", "review-editor.html"];
const releaseUrl = "https://api.github.com/repos/backnotprop/plannotator/releases/latest";

const onboardingCookies = [
	'"plannotator-plan-look-choice-resolved": "true"',
	'"plannotator-look-feel-announcement-seen": "2"',
	'"plannotator-guide-intro-seen": "2"',
	'"plannotator-guide-hint-acked": "true"',
	'"plannotator-review-setup-seen": "true"',
	'"plannotator-edit-mode-announcement-seen": "3"',
	'"plannotator-review-dest-spotlight-seen": "1"',
];

function renderHtml(content: string): string {
	let body = "";
	const response = {
		writeHead() {},
		end(value: string) {
			body = value;
		},
	} as unknown as ServerResponse;
	sendHtml(response, content);
	return body;
}

describe("patched Plannotator browser responses", () => {
	for (const htmlFile of htmlFiles) {
		test(`${htmlFile} suppresses onboarding and remote release checks`, () => {
			const source = readFileSync(join(packageDir, htmlFile), "utf8");
			expect(source).toContain(releaseUrl);

			const html = renderHtml(source);
			const bootstrapEnd = html.indexOf('<script type="module" crossorigin>');
			expect(bootstrapEnd).toBeGreaterThan(0);

			const bootstrap = html.slice(0, bootstrapEnd);
			for (const cookie of onboardingCookies) {
				expect(bootstrap).toContain(cookie);
			}
			expect(html).not.toContain(releaseUrl);
			expect(html).toContain("data:application/json,%7B%22tag_name%22%3A%220.27.6%22");
			expect(html).not.toContain("window.fetch =");
		});
	}

	test("leaves unrelated HTML unchanged", () => {
		const html = "<!doctype html><html><head></head><body>Example</body></html>";
		expect(renderHtml(html)).toBe(html);
	});
});
