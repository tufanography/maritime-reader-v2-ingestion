# Local runner for sources the GitHub runner cannot reach (sources.runner = 'local').
# TEMPORARY for Container News: GitHub's IPs get HTTP 403 there since 2026-10-07.
# Run by Windows Task Scheduler; the cloud workflow only takes runner = 'cloud',
# so a source is never scraped by both.
#
# Catch-up after the PC was off:
#   - every run reads the newest 100 posts (wp_rest_per_page), about 5 days
#   - if the last successful run is older than 4 days, the same-pipeline backfill
#     script fills the whole gap first (idempotent: known URLs are skipped)
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path $PSScriptRoot -Parent)
$log = 'tmp\local-scrape.log'
$stamp = 'tmp\local-scrape.last-ok'
function Say($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Out-File -FilePath $log -Append -Encoding utf8 }

$last = if (Test-Path $stamp) { [datetime](Get-Content $stamp -Raw).Trim() } else { $null }
if ($last -and ((Get-Date) - $last).TotalDays -gt 4) {
  $after = $last.AddDays(-1).ToString('yyyy-MM-dd'); $before = (Get-Date).AddDays(1).ToString('yyyy-MM-dd')
  Say "GAP: last ok run $($last.ToString('yyyy-MM-dd HH:mm')) - backfilling Container News $after..$before"
  & npx tsx scripts/backfill-archive.ts --source 'Container News' --after $after --before $before --apply 2>&1 | Select-Object -Last 6 | ForEach-Object { Say "  backfill: $_" }
  if ($LASTEXITCODE -ne 0) { Say "FAILED: backfill exit code $LASTEXITCODE (will retry next run)"; exit 1 }
}

$out = & npx tsx scripts/cron-scrape.ts --runner=local 2>&1
$code = $LASTEXITCODE
$out | Where-Object { "$_" -match 'scrapeAllDue|Done in|^\s*\[(success|empty|error)\]|Missing|ENOTFOUND|fetch failed' } | ForEach-Object { Say "  $_" }
if ($code -ne 0) { Say "FAILED: scrape exit code $code - $(("$($out | Select-Object -Last 3)") -replace '\s+', ' ')"; exit $code }
# cron-scrape exits 0 even when a source fails (it logs the failure and moves on),
# so read the per-source result lines: only a clean run advances the catch-up stamp.
if ($out | Where-Object { "$_" -match '^\s*\[error\]' }) { Say 'FAILED: a source returned an error (see the [error] line above); will retry next run'; exit 2 }
if ($out | Where-Object { "$_" -match '^\s*\[(success|empty)\]' }) { (Get-Date).ToString('o') | Out-File -FilePath $stamp -Encoding ascii }
Say 'OK'
