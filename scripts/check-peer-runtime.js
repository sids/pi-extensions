const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const rootPackageJsonPath = path.join(rootDir, "package.json");
const packageDirs = ["answer", "fetch-url", "web-search", "status", "plan-md", "review", "mention-skills", "shared"];

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const rootPackageJson = readJson(rootPackageJsonPath);
const rootDevDependencies = new Set(Object.keys(rootPackageJson.devDependencies ?? {}));

const missingByPackage = [];

for (const packageDir of packageDirs) {
	const packageJsonPath = path.join(rootDir, packageDir, "package.json");
	const packageJson = readJson(packageJsonPath);
	const peerDependencies = Object.keys(packageJson.peerDependencies ?? {});
	const missing = peerDependencies.filter((name) => !rootDevDependencies.has(name));

	if (missing.length > 0) {
		missingByPackage.push({
			packageDir,
			packageName: packageJson.name,
			missing,
		});
	}
}

if (missingByPackage.length > 0) {
	console.error("Peer runtime check failed. Add missing packages to root devDependencies:");
	for (const entry of missingByPackage) {
		console.error(`- ${entry.packageName} (${entry.packageDir}): ${entry.missing.join(", ")}`);
	}
	process.exit(1);
}

console.log("Peer runtime check passed.");
