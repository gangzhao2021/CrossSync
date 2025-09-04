param(
  [string]$Branch = "master",
  [switch]$Force,
  [string]$Token,
  [switch]$UseSSH,
  [string]$Remote = "origin",
  [string]$Repo = "yashirq/CrossSync.git"
)

$ErrorActionPreference = 'Stop'
Set-Location -Path "$PSScriptRoot"

function HasGit {
  return (Get-Command git -ErrorAction SilentlyContinue) -ne $null
}
if (-not (HasGit)) { throw 'git is not installed or not on PATH.' }

# Ensure remote exists
$remotes = git remote | Out-String
if (-not ($remotes -match "^$Remote$")) {
  if ($UseSSH) {
    git remote add $Remote "git@github.com:$Repo"
  } else {
    git remote add $Remote "https://github.com/$Repo"
  }
}

# Commit pending changes if any
$changed = git status --porcelain
if ($changed) {
  git add -A
  git commit -m "chore: publish sync"
}

# Push
$args = @($Remote, $Branch)
if ($Force) { $args += '--force' }

if (-not $UseSSH -and (-not $Token)) { $Token = $env:GITHUB_TOKEN }

if ($Token) {
  # Use PAT without persisting to config
  git -c "http.extraheader=AUTHORIZATION: bearer $Token" push @args
} else {
  # Interactive login via Git Credential Manager
  git config --global credential.helper manager-core | Out-Null
  git push @args
}

Write-Host "Pushed to $Remote/$Branch" -ForegroundColor Green

