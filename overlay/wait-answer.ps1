param(
  [Parameter(Mandatory = $true)][string]$Answer,
  [Parameter(Mandatory = $true)][string]$Focus,
  [int]$TimeoutSec = 570
)

# Waits for the person's answer to a permission question shown on the pet.
# Prints allow or deny from the pet's card, or app when the question belongs
# in Claude's own dialog: Claude came to the front, the window is gone, or time ran out.

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $Answer) {
    try {
      $decision = [string](Get-Content $Answer -Raw -Encoding UTF8 | ConvertFrom-Json).decision
      Remove-Item $Answer -ErrorAction SilentlyContinue
      if ($decision -eq 'allow' -or $decision -eq 'deny') { $decision; exit 0 }
    } catch {}
  }
  try {
    $f = Get-Content $Focus -Raw -Encoding UTF8 | ConvertFrom-Json
    $age = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() - [double]$f.at
    # Claude came to the front, the pet stopped, or the person walked away from the computer
    if ($f.claude -eq $true -or $age -gt 15000 -or [double]$f.idle -gt 120) { 'app'; exit 0 }
  } catch { 'app'; exit 0 }
  Start-Sleep -Milliseconds 200
}
'app'
