<#
.SYNOPSIS
    One-way mirror: Azure DevOps -> GitHub.

.DESCRIPTION
    Pushes the release branch of this repo to the public GitHub repo that users
    add with `/plugin marketplace add`. Intended to run from the release
    pipeline after a PR merges into the prod branch, but it is safe to run by
    hand. Behaviour matches scripts/sync-to-github.sh.

    The PAT is passed to git through GIT_ASKPASS so it never appears in the
    process list, in `git remote -v`, or in pipeline logs.

.PARAMETER GithubPat
    GitHub token with `contents: write` on the target repo.
    Defaults to $env:GITHUB_PAT.

.PARAMETER GithubRepo
    Target as `owner/name`, or a full https://github.com/... URL.
    Defaults to $env:GITHUB_REPO.

.PARAMETER SourceRef
    What to push. Default: HEAD.

.PARAMETER TargetBranch
    Branch to update on GitHub. Default: main.

.PARAMETER Force
    Overwrite diverged GitHub history.

.PARAMETER DryRun
    Show what would be pushed and exit.

.EXAMPLE
    ./sync-to-github.ps1 -GithubRepo beezi/beezi-claude-plugins -DryRun
#>
[CmdletBinding()]
param(
    [string]$GithubPat = $env:GITHUB_PAT,
    [string]$GithubRepo = $env:GITHUB_REPO,
    [string]$SourceRef = 'HEAD',
    [string]$TargetBranch = 'main',
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Die($message) {
    Write-Error "sync-to-github: $message"
    exit 1
}

if ([string]::IsNullOrWhiteSpace($GithubPat)) { Die 'GITHUB_PAT is not set.' }
if ([string]::IsNullOrWhiteSpace($GithubRepo)) { Die "GITHUB_REPO is not set (expected 'owner/name')." }

# Accept either `owner/name` or a full URL, and normalise to owner/name.
$slug = $GithubRepo -replace '^https://github\.com/', '' -replace '^git@github\.com:', '' -replace '\.git$', ''
if ($slug -notmatch '^[^/]+/[^/]+$') { Die "GITHUB_REPO '$GithubRepo' is not 'owner/name'." }

$sha = (& git rev-parse $SourceRef 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sha)) {
    Die "SOURCE_REF '$SourceRef' does not resolve in this repo."
}
$sha = $sha.Trim()

Write-Host "sync-to-github: $slug  <-  $SourceRef ($sha) -> $TargetBranch"

if ($DryRun) {
    Write-Host 'sync-to-github: DryRun, nothing pushed.'
    exit 0
}

# Feed the PAT to git without putting it in argv or on the remote URL.
$isWindows = $PSVersionTable.Platform -ne 'Unix'
$askpass = if ($isWindows) {
    Join-Path ([System.IO.Path]::GetTempPath()) "askpass-$([guid]::NewGuid()).cmd"
} else {
    Join-Path ([System.IO.Path]::GetTempPath()) "askpass-$([guid]::NewGuid()).sh"
}

try {
    if ($isWindows) {
        Set-Content -Path $askpass -Value "@echo off`r`necho %GITHUB_PAT%" -Encoding ASCII
    } else {
        Set-Content -Path $askpass -Value "#!/bin/sh`nexec printf %s `"`$GITHUB_PAT`"" -NoNewline:$false
        & chmod 700 $askpass
    }

    $env:GIT_ASKPASS = $askpass
    $env:GITHUB_PAT = $GithubPat
    $env:GIT_TERMINAL_PROMPT = '0'

    $pushArgs = @('push', "https://x-access-token@github.com/$slug.git", "${sha}:refs/heads/$TargetBranch")
    if ($Force) {
        Write-Host 'sync-to-github: Force, overwriting diverged history on GitHub.'
        $pushArgs += '--force'
    }

    & git @pushArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'If GitHub has commits that are not in this repo, reconcile them or re-run with -Force.' -ForegroundColor Yellow
        Die "push failed (exit $LASTEXITCODE)."
    }

    Write-Host "sync-to-github: pushed $sha to $slug@$TargetBranch"
} finally {
    Remove-Item -Path $askpass -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\GIT_ASKPASS -ErrorAction SilentlyContinue
    Remove-Item Env:\GITHUB_PAT -ErrorAction SilentlyContinue
    Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
}
