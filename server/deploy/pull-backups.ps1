# Pull production DB backups from the ShengLong server to this PC.
#
# Why: the server keeps 30 days of backups locally only. If the whole server
# dies, those backups die with it. This copies them to G:\sl\backups.
#
# Runs daily via Task Scheduler (task name: ShengLong-BackupPull).
# NOTE: this file is deliberately ASCII-only -- Windows PowerShell 5.1
# mis-decodes UTF-8 files without a BOM, and mojibake in a script path or
# command is a hard failure.

$ErrorActionPreference = 'Stop'

$key       = Join-Path $env:USERPROFILE '.ssh\id_ed25519_sljxc'
$remote    = 'ubuntu@119.91.206.235'
$remoteDir = '/var/backups/shenglong-mysql'
$localDir  = 'G:\sl\backups'
$keepDays  = 60
$logFile   = Join-Path $localDir 'pull-backups.log'

New-Item -ItemType Directory -Force -Path $localDir | Out-Null

function Write-Log([string]$msg) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

if (-not (Test-Path -LiteralPath $key)) {
    Write-Log "FAILED: ssh key not found at $key"
    exit 1
}

$scpArgs = @(
    '-i', $key,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
    "$remote`:$remoteDir/shenglong-*.sql.gz",
    $localDir
)

Write-Log '--- start pulling backups ---'

try {
    $out = & scp @scpArgs 2>&1
    $code = $LASTEXITCODE
} catch {
    Write-Log "FAILED (exception): $($_.Exception.Message)"
    exit 1
}

if ($code -ne 0) {
    Write-Log ("FAILED (scp exit {0}): {1}" -f $code, (($out | Out-String).Trim()))
    exit 1
}

# verify: at least one fresh backup landed
$files = @(Get-ChildItem -LiteralPath $localDir -Filter 'shenglong-*.sql.gz' -File)
if ($files.Count -eq 0) {
    Write-Log 'FAILED: no backup file present after pull'
    exit 1
}

$newest = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$ageH   = [math]::Round(((Get-Date) - $newest.LastWriteTime).TotalHours, 1)
Write-Log ("OK: {0} file(s) local, newest = {1} ({2} MB, {3}h old)" -f `
    $files.Count, $newest.Name, [math]::Round($newest.Length / 1MB, 2), $ageH)

# prune local copies older than $keepDays (only our own shenglong-*.sql.gz)
$cut = (Get-Date).AddDays(-$keepDays)
$old = @($files | Where-Object { $_.LastWriteTime -lt $cut })
if ($old.Count -gt 0) {
    $old | Remove-Item -Force
    Write-Log ("pruned {0} local file(s) older than {1} days" -f $old.Count, $keepDays)
}
