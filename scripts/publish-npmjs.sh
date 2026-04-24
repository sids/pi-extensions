#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REGISTRY="https://registry.npmjs.org/"
DRY_RUN=false
ONLY_UNPUBLISHED=false

usage() {
  cat <<'EOF'
Publish extension packages to npmjs.org.

Usage:
  scripts/publish-npmjs.sh <directory> [--dry-run] [--only-unpublished]
  scripts/publish-npmjs.sh --all [--dry-run] [--only-unpublished]

Examples:
  scripts/publish-npmjs.sh plan-md
  scripts/publish-npmjs.sh plan-md --dry-run
  scripts/publish-npmjs.sh shared --only-unpublished
  scripts/publish-npmjs.sh --all
  scripts/publish-npmjs.sh --all --only-unpublished --dry-run
EOF
}

list_all_packages() {
  node - "$REPO_ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const rootDir = process.argv[2];
const ignoredDirs = new Set([".git", ".pi", "node_modules"]);
const packageDirs = fs
  .readdirSync(rootDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !ignoredDirs.has(entry.name))
  .map((entry) => entry.name)
  .filter((dir) => fs.existsSync(path.join(rootDir, dir, "package.json")));

const packages = new Map();
for (const dir of packageDirs) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, dir, "package.json"), "utf8"));
  const dependencyNames = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ];
  packages.set(dir, {
    name: packageJson.name,
    dependencyNames,
  });
}

const dirByPackageName = new Map(
  [...packages.entries()].map(([dir, pkg]) => [pkg.name, dir]),
);
const ordered = [];
const visiting = new Set();
const visited = new Set();

function visit(dir) {
  if (visited.has(dir)) return;
  if (visiting.has(dir)) {
    throw new Error(`Circular local package dependency detected for ${dir}`);
  }

  visiting.add(dir);
  for (const dependencyName of packages.get(dir).dependencyNames) {
    const dependencyDir = dirByPackageName.get(dependencyName);
    if (dependencyDir) {
      visit(dependencyDir);
    }
  }
  visiting.delete(dir);
  visited.add(dir);
  ordered.push(dir);
}

for (const dir of [...packages.keys()].sort()) {
  visit(dir);
}

process.stdout.write(`${ordered.join("\n")}\n`);
NODE
}

package_version_is_published() {
  local package_name="$1"
  local package_version="$2"

  npm view "$package_name@$package_version" version --registry="$REGISTRY" >/dev/null 2>&1
}

run_publish_checks() {
  echo "==> Running publish checks"
  (
    cd "$REPO_ROOT"
    npm run check:peer-runtime
    npm run check:package-boundaries
  )
}

ensure_npm_auth() {
  local npm_user

  if npm_user="$(npm whoami --registry="$REGISTRY" 2>/dev/null)"; then
    echo "==> Authenticated to $REGISTRY as $npm_user"
    return 0
  fi

  echo "==> Not authenticated to $REGISTRY"
  echo "==> Running npm login --registry=$REGISTRY"
  npm login --registry="$REGISTRY"

  if npm_user="$(npm whoami --registry="$REGISTRY" 2>/dev/null)"; then
    echo "==> Authenticated to $REGISTRY as $npm_user"
    return 0
  fi

  echo "==> npm login completed, but authentication could not be verified" >&2
  return 1
}

publish_package() {
  local package_dir="$1"
  local package_json="$REPO_ROOT/$package_dir/package.json"

  if [[ ! -f "$package_json" ]]; then
    echo "Missing package.json in $package_dir" >&2
    return 1
  fi

  local package_name
  package_name="$(node -p "require(process.argv[1]).name" "$package_json")"

  local package_version
  package_version="$(node -p "require(process.argv[1]).version" "$package_json")"

  if [[ "$ONLY_UNPUBLISHED" == "true" ]] && package_version_is_published "$package_name" "$package_version"; then
    echo
    echo "==> Skipping $package_name@$package_version from $package_dir (already published)"
    return 0
  fi

  local npm_args=(publish --registry="$REGISTRY")
  if [[ "$DRY_RUN" == "true" ]]; then
    npm_args+=(--dry-run)
  fi

  echo
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "==> Dry-run publishing $package_name@$package_version from $package_dir"
  else
    echo "==> Publishing $package_name@$package_version from $package_dir"
  fi

  local status=0
  (
    cd "$REPO_ROOT/$package_dir"
    npm "${npm_args[@]}"
  ) || status=$?

  if [[ "$status" -ne 0 ]]; then
    echo "==> Failed publishing $package_name@$package_version from $package_dir (exit $status)" >&2
  fi

  return "$status"
}

TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      if [[ -n "$TARGET" ]]; then
        echo "Only one target is allowed" >&2
        usage
        exit 1
      fi
      TARGET="--all"
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    --only-unpublished)
      ONLY_UNPUBLISHED=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -* )
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -n "$TARGET" ]]; then
        echo "Only one target is allowed" >&2
        usage
        exit 1
      fi
      TARGET="$1"
      ;;
  esac
  shift
done

if [[ -z "$TARGET" ]]; then
  usage
  exit 1
fi

run_publish_checks

if [[ "$DRY_RUN" != "true" ]]; then
  ensure_npm_auth
else
  echo "Running in dry-run mode; skipping npm auth check."
fi

if [[ "$TARGET" == "--all" ]]; then
  failed_packages=()
  package_dirs=()

  while IFS= read -r package_dir; do
    package_dirs+=("$package_dir")
  done < <(list_all_packages)

  for package_dir in "${package_dirs[@]}"; do
    if [[ -z "$package_dir" ]]; then
      continue
    fi

    if ! publish_package "$package_dir"; then
      failed_packages+=("$package_dir")
    fi
  done

  if [[ "${#failed_packages[@]}" -gt 0 ]]; then
    echo >&2
    echo "Publish completed with failures in: ${failed_packages[*]}" >&2
    exit 1
  fi

  exit 0
fi

package_dir="${TARGET%/}"
package_dir="${package_dir#./}"

if [[ ! -d "$REPO_ROOT/$package_dir" ]]; then
  echo "Directory not found: $package_dir" >&2
  exit 1
fi

publish_package "$package_dir"
