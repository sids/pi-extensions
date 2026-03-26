const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const ignoredDirs = new Set([".git", ".pi", "node_modules"]);
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const importPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

function listPackageDirs() {
	return fs
		.readdirSync(rootDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !ignoredDirs.has(entry.name))
		.map((entry) => entry.name)
		.filter((dirName) => fs.existsSync(path.join(rootDir, dirName, "package.json")));
}

function isWithinDirectory(targetPath, directoryPath) {
	const relative = path.relative(directoryPath, targetPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function collectSourceFiles(directoryPath) {
	const files = [];
	for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "tests") {
			continue;
		}
		const entryPath = path.join(directoryPath, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectSourceFiles(entryPath));
			continue;
		}
		if (sourceExtensions.has(path.extname(entry.name))) {
			files.push(entryPath);
		}
	}
	return files;
}

const violations = [];

for (const packageDir of listPackageDirs()) {
	const packageRoot = path.join(rootDir, packageDir);
	for (const filePath of collectSourceFiles(packageRoot)) {
		const contents = fs.readFileSync(filePath, "utf8");
		for (const match of contents.matchAll(importPattern)) {
			const specifier = match[1] || match[2];
			if (!specifier || !specifier.startsWith(".")) {
				continue;
			}
			const resolvedPath = path.resolve(path.dirname(filePath), specifier);
			if (isWithinDirectory(resolvedPath, packageRoot)) {
				continue;
			}
			violations.push({
				packageDir,
				filePath: path.relative(rootDir, filePath),
				specifier,
				resolvedPath: path.relative(rootDir, resolvedPath),
			});
		}
	}
}

if (violations.length > 0) {
	console.error("Package boundary check failed. Runtime source files must not import outside their package directory:");
	for (const violation of violations) {
		console.error(`- ${violation.packageDir}: ${violation.filePath} -> ${violation.specifier} (${violation.resolvedPath})`);
	}
	process.exit(1);
}

console.log("Package boundary check passed.");
