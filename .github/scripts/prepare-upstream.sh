#!/usr/bin/env bash
set -euo pipefail

base_branch=${BASE_BRANCH:-selfhost/pocket-id}
upstream_url=${UPSTREAM_URL:-https://github.com/vast-ch/flightbook.git}
upstream_branch=${UPSTREAM_BRANCH:-main}
: "${GITHUB_OUTPUT:?}"
: "${GITHUB_STEP_SUMMARY:?}"

git fetch --no-tags origin "$base_branch:refs/remotes/origin/$base_branch"
git fetch --no-tags "$upstream_url" "$upstream_branch:refs/remotes/upstream/$upstream_branch"
base_sha=$(git rev-parse "refs/remotes/origin/$base_branch")
upstream_sha=$(git rev-parse "refs/remotes/upstream/$upstream_branch")
printf 'upstream=%s\nchanged=false\n' "$upstream_sha" >> "$GITHUB_OUTPUT"

if git merge-base --is-ancestor "$upstream_sha" "$base_sha"; then
  echo 'Upstream is already included in the deployment branch.' >> "$GITHUB_STEP_SUMMARY"
  if [[ ${VALIDATE_CURRENT:-false} == true ]]; then
    printf 'head=%s\n' "$base_sha" >> "$GITHUB_OUTPUT"
  fi
  exit 0
fi

# Preserve an existing bot PR and any human conflict-resolution commits on it.
existing=$(gh pr list --base "$base_branch" --state open --json headRefName,number,isDraft,author,isCrossRepository \
  --jq '[.[] | select(.author.is_bot == true and .isCrossRepository == false and (.headRefName | startswith("automation/upstream-")))][0] // empty')
if [[ -n $existing ]]; then
  branch=$(jq -r .headRefName <<< "$existing")
  pr=$(jq -r .number <<< "$existing")
  if [[ $(jq -r .isDraft <<< "$existing") == false ]]; then
    gh pr ready "$pr" --undo
  fi
  git fetch origin "$branch:refs/remotes/origin/$branch"
  git switch --create "$branch" "refs/remotes/origin/$branch"
else
  branch="automation/upstream-${upstream_sha:0:12}-${base_sha:0:12}"
  # Respect a previously closed proposal for these exact inputs.
  closed=$(gh pr list --base "$base_branch" --head "$branch" --state closed --json number --jq 'length')
  if [[ $closed != 0 ]]; then
    echo 'The proposal for these revisions was closed; leaving it closed.' >> "$GITHUB_STEP_SUMMARY"
    exit 0
  fi
  # A prior failed check may have pushed this branch without opening its PR yet.
  if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    git fetch origin "$branch:refs/remotes/origin/$branch"
    git switch --create "$branch" "refs/remotes/origin/$branch"
  else
    git switch --create "$branch" "$base_sha"
  fi
fi

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
merge_ref() {
  local revision=$1 message=$2 conflicts
  if ! git merge --no-ff -m "$message" "$revision"; then
    conflicts=$(git diff --name-only --diff-filter=U)
    git merge --abort
    {
      echo '### Upstream merge needs manual conflict resolution'
      printf '\nCandidate branch: %s\n\nConflicting paths:\n\n' "$branch"
      printf '    %s\n' "$conflicts"
      echo 'No conflicted changes were pushed. Existing PRs remain drafts.'
    } >> "$GITHUB_STEP_SUMMARY"
    echo '::error::Upstream merge conflicts require manual resolution; see the run summary.'
    return 1
  fi
}
merge_ref "$base_sha" 'Merge current self-hosting branch into upstream proposal'
merge_ref "$upstream_sha" 'Merge vast-ch/flightbook upstream changes'
head_sha=$(git rev-parse HEAD)
git push origin "HEAD:refs/heads/$branch"
printf 'head=%s\nbranch=%s\nchanged=true\n' "$head_sha" "$branch" >> "$GITHUB_OUTPUT"
printf 'Prepared %s at %s for validation.\n' "$branch" "$head_sha" >> "$GITHUB_STEP_SUMMARY"
