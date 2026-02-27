#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REGISTRY="https://registry.npmjs.org/"
DRY_RUN=false

ALL_PACKAGES=(
  "shared"
  "answer"
  "plan-md"
  "fetch-url"
  "web-search"
  "status"
  "review"
  "mention-skills"
)

usage() {
  cat <<'EOF'
Publish extension packages to npmjs.org.

Usage:
  scripts/publish-npmjs.sh <directory> [--dry-run]
  scripts/publish-npmjs.sh --all [--dry-run]

Examples:
  scripts/publish-npmjs.sh plan-md
  scripts/publish-npmjs.sh plan-md --dry-run
  scripts/publish-npmjs.sh --all
  scripts/publish-npmjs.sh --all --dry-run
EOF
}

publish_package() {
  local package_dir="$1"
  local package_json="$REPO_ROOT/$package_dir/package.json"

  if [[ ! -f "$package_json" ]]; then
    echo "Missing package.json in $package_dir" >&2
    exit 1
  fi

  local package_name
  package_name="$(node -p "require(process.argv[1]).name" "$package_json")"

  local npm_args=(publish --registry="$REGISTRY")
  if [[ "$DRY_RUN" == "true" ]]; then
    npm_args+=(--dry-run)
  fi

  echo
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "==> Dry-run publishing $package_name from $package_dir"
  else
    echo "==> Publishing $package_name from $package_dir"
  fi

  (
    cd "$REPO_ROOT/$package_dir"
    npm "${npm_args[@]}"
  )
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

if [[ "$DRY_RUN" != "true" ]]; then
  if ! npm whoami --registry="$REGISTRY" >/dev/null 2>&1; then
    echo "Not authenticated to $REGISTRY" >&2
    echo "Run: npm login --registry=$REGISTRY" >&2
    exit 1
  fi
else
  echo "Running in dry-run mode; skipping npm auth check."
fi

if [[ "$TARGET" == "--all" ]]; then
  for package_dir in "${ALL_PACKAGES[@]}"; do
    publish_package "$package_dir"
  done
  exit 0
fi

package_dir="${TARGET%/}"
package_dir="${package_dir#./}"

if [[ ! -d "$REPO_ROOT/$package_dir" ]]; then
  echo "Directory not found: $package_dir" >&2
  exit 1
fi

publish_package "$package_dir"
