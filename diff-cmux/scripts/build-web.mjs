import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");

await build({
	absWorkingDir: packageDir,
	entryPoints: [path.join(packageDir, "web/index.tsx")],
	bundle: true,
	format: "esm",
	platform: "browser",
	jsx: "automatic",
	entryNames: "app",
	outdir: path.join(packageDir, "web/dist"),
	loader: {
		".css": "css",
	},
	define: {
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
	},
});
