#!/usr/bin/env bash
#
# One-way mirror: Azure DevOps -> GitHub.
#
# Pushes the release branch of this repo to the public GitHub repo that users
# add with `/plugin marketplace add`. Intended to run from the release pipeline
# after a PR merges into the prod branch, but it is safe to run by hand.
#
# Required:
#   GITHUB_PAT     GitHub token with `contents: write` on the target repo.
#   GITHUB_REPO    Target as `owner/name`, or a full https://github.com/... URL.
#
# Optional:
#   SOURCE_REF     What to push. Default: HEAD.
#   TARGET_BRANCH  Branch to update on GitHub. Default: main.
#   FORCE          `true` to overwrite diverged GitHub history. Default: false.
#   DRY_RUN        `true` to show what would be pushed and exit. Default: false.
#   ALLOW_NON_PROD `true` to mirror even if a .mcp.json points at a dev tunnel.
#                  Default: false. The GitHub repo is public - a tunnel URL
#                  published here stays in the commit log.
#
# The PAT is passed to git through GIT_ASKPASS so it never appears in the
# process list, in `git remote -v`, or in pipeline logs.

set -euo pipefail

GITHUB_PAT="${GITHUB_PAT:-}"
GITHUB_REPO="${GITHUB_REPO:-}"
SOURCE_REF="${SOURCE_REF:-HEAD}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"
FORCE="${FORCE:-false}"
DRY_RUN="${DRY_RUN:-false}"
ALLOW_NON_PROD="${ALLOW_NON_PROD:-false}"

die() { echo "sync-to-github: $*" >&2; exit 1; }

[ -n "$GITHUB_PAT" ] || die "GITHUB_PAT is not set."
[ -n "$GITHUB_REPO" ] || die "GITHUB_REPO is not set (expected 'owner/name')."

# Accept either `owner/name` or a full URL, and normalise to owner/name.
slug="$GITHUB_REPO"
slug="${slug#https://github.com/}"
slug="${slug#git@github.com:}"
slug="${slug%.git}"
case "$slug" in
    */*/*) die "GITHUB_REPO '$GITHUB_REPO' has too many path segments." ;;
    */*) : ;;
    *) die "GITHUB_REPO '$GITHUB_REPO' is not 'owner/name'." ;;
esac

git rev-parse --verify "$SOURCE_REF" >/dev/null 2>&1 \
    || die "SOURCE_REF '$SOURCE_REF' does not resolve in this repo."

sha="$(git rev-parse "$SOURCE_REF")"
echo "sync-to-github: $slug  <-  $SOURCE_REF ($sha) -> $TARGET_BRANCH"

# The GitHub mirror is public. Refuse to publish a connector URL that points at
# a dev tunnel or a local box - it would stay in the commit log afterwards.
if [ "$ALLOW_NON_PROD" != "true" ]; then
    non_prod="$(git grep -n -I -E 'ngrok|localhost|127\.0\.0\.1|0\.0\.0\.0' "$sha" -- '*.mcp.json' || true)"
    if [ -n "$non_prod" ]; then
        echo "sync-to-github: refusing to mirror - non-production connector URL found:" >&2
        echo "$non_prod" | sed 's/^/  /' >&2
        echo "Point it at the production Beezi API, or set ALLOW_NON_PROD=true to override." >&2
        exit 1
    fi
fi

if [ "$DRY_RUN" = "true" ]; then
    echo "sync-to-github: DRY_RUN=true, nothing pushed."
    exit 0
fi

# Feed the PAT to git without putting it in argv or on the remote URL.
askpass="$(mktemp)"
chmod 600 "$askpass"
printf '#!/bin/sh\nexec printf %%s "$GITHUB_PAT"\n' > "$askpass"
chmod 700 "$askpass"
trap 'rm -f "$askpass"' EXIT

push_args=(push "https://x-access-token@github.com/$slug.git" "$sha:refs/heads/$TARGET_BRANCH")
if [ "$FORCE" = "true" ]; then
    echo "sync-to-github: FORCE=true, overwriting diverged history on GitHub."
    push_args+=(--force)
fi

if GIT_ASKPASS="$askpass" GITHUB_PAT="$GITHUB_PAT" GIT_TERMINAL_PROMPT=0 git "${push_args[@]}"; then
    echo "sync-to-github: pushed $sha to $slug@$TARGET_BRANCH"
else
    status=$?
    echo "sync-to-github: push failed (exit $status)." >&2
    echo "If GitHub has commits that are not in this repo, reconcile them or re-run with FORCE=true." >&2
    exit $status
fi
