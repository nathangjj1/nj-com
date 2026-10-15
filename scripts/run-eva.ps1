# Run the eVA scrape in the installed Chrome, then publish eva-appraisals/ to main.
# Put EVA_EMAIL and EVA_PASSWORD in eva.local.env (gitignored) to skip the prompts.

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

function Import-LocalEnv([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) { continue }
    $split = $trimmed.IndexOf("=")
    if ($split -lt 1) { continue }
    $name = $trimmed.Substring(0, $split).Trim()
    $value = $trimmed.Substring($split + 1)
    if ($value.Length -ge 2) {
      $quote = $value.Substring(0, 1)
      if (($quote -eq '"' -or $quote -eq "'") -and $value.EndsWith($quote)) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    Set-Item -Path "Env:$name" -Value $value
  }
}

Import-LocalEnv (Join-Path $root "eva.local.env")

if (-not $env:EVA_EMAIL) {
  $env:EVA_EMAIL = Read-Host "eVA email"
}
if (-not $env:EVA_PASSWORD) {
  $secure = Read-Host "eVA password" -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $env:EVA_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules\playwright"))) {
  npm install
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$env:EVA_HEADED = "1"
$env:EVA_BROWSER = "chrome"

node (Join-Path $root "scripts\eva-scrape.mjs")
$code = $LASTEXITCODE
Remove-Item Env:\EVA_PASSWORD -ErrorAction SilentlyContinue
if ($code -ne 0) { exit $code }

git add -- eva-appraisals
$changes = git diff --cached --name-only
if (-not $changes) {
  Write-Host "No changes to the appraisal feed."
  exit 0
}

git commit -m "Update eVA appraisals from the past 30 days."
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git push origin HEAD
exit $LASTEXITCODE
