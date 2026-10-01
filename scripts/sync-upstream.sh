#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?GH_REPO deve identificar o fork}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT deve estar definido}"

branch=$(git branch --show-current)
if [[ "$branch" != main ]]; then
    echo "::error::A sincronização exige checkout de main."
    exit 1
fi
if git rev-parse --verify --quiet MERGE_HEAD >/dev/null; then
    echo "::error::Já existe um merge em andamento."
    exit 1
fi

find_review() {
    gh api --method GET "repos/$GH_REPO/pulls" \
        -f state=open -f base=main -f "head=${GH_REPO%/*}:sync/upstream" \
        --jq '.[0].html_url // empty'
}

request_review() {
    git fetch --prune origin
    local update_branch=true
    local recycle_branch=false
    local sync_head=""
    if git show-ref --verify --quiet refs/remotes/origin/sync/upstream; then
        sync_head=$(git rev-parse refs/remotes/origin/sync/upstream)
        if git merge-base --is-ancestor "$sync_head" upstream/main; then
            update_branch=true
        else
            local ancestor_status=$?
            if [[ "$ancestor_status" != 1 ]]; then
                return "$ancestor_status"
            fi
            if git merge-base --is-ancestor "$sync_head" HEAD; then
                recycle_branch=true
                echo "A resolução anterior de sync/upstream já está integrada em main; preparando a próxima revisão."
            else
                ancestor_status=$?
                if [[ "$ancestor_status" != 1 ]]; then
                    return "$ancestor_status"
                fi
                update_branch=false
                echo "sync/upstream contém alterações manuais; a branch foi preservada. Integre upstream/main nela durante a resolução."
            fi
        fi
    else
        local ref_status=$?
        if [[ "$ref_status" != 1 ]]; then
            return "$ref_status"
        fi
    fi

    if [[ "$update_branch" == true ]]; then
        if [[ "$recycle_branch" == true ]]; then
            git push "--force-with-lease=refs/heads/sync/upstream:$sync_head" origin upstream/main:refs/heads/sync/upstream
        else
            git push origin upstream/main:refs/heads/sync/upstream
        fi
    fi

    local pr_url
    pr_url=$(find_review)
    if [[ -z "$pr_url" ]]; then
        if pr_url=$(gh pr create --repo "$GH_REPO" \
            --base main --head sync/upstream \
            --title "Sync upstream Vencord (conflitos - resolver manualmente)" \
            --body "O merge de Vendicated:main conflitou com as modificações do fork. Resolva na branch sync/upstream deste fork, preservando suas alterações, e faça merge em main. Se a branch já contém trabalho manual, incorpore nela o upstream/main atual antes de concluir."); then
            :
        else
            local create_status=$?
            pr_url=$(find_review)
            if [[ -z "$pr_url" ]]; then
                echo "::error::Não foi possível criar nem encontrar um PR aberto para sync/upstream em $GH_REPO."
                return "$create_status"
            fi
        fi
    fi
    echo "Revisão necessária: $pr_url"
    echo "status=review" >> "$GITHUB_OUTPUT"
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
        printf 'Conflitos aguardando resolução: %s\n' "$pr_url" >> "$GITHUB_STEP_SUMMARY"
    fi
}

if git merge-base --is-ancestor upstream/main HEAD; then
    echo "main já contém upstream/main."
    echo "status=noop" >> "$GITHUB_OUTPUT"
    exit 0
else
    ancestor_status=$?
    if [[ "$ancestor_status" != 1 ]]; then
        exit "$ancestor_status"
    fi
fi

if git merge --no-edit --no-commit --no-ff upstream/main; then
    git commit --no-edit
    git push origin HEAD:refs/heads/main
    echo "status=updated" >> "$GITHUB_OUTPUT"
else
    merge_status=$?
    conflicts=$(git diff --name-only --diff-filter=U)
    if [[ -z "$conflicts" ]] || ! git rev-parse --verify --quiet MERGE_HEAD >/dev/null; then
        echo "::error::git merge falhou sem produzir conflitos resolvíveis; consulte o erro original acima."
        exit "$merge_status"
    fi
    git merge --abort
    request_review
fi
