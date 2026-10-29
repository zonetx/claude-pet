param(
  [string]$Dir = '',
  # older versions of the mod start the window with the path of their status file
  [string]$StatusFile = '',
  # tests run a second window under their own name, beside the person's pet
  [string]$Instance = 'ClaudePixelPetOverlay'
)
if ($Dir -eq '' -and $StatusFile -ne '') { $Dir = Split-Path -Parent $StatusFile }
if ($Dir -eq '') { $Dir = $PSScriptRoot }
$legacyMode = $StatusFile -ne ''
$legacyParent = $null
if ($legacyMode) { try { $legacyParent = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId } catch {} }

# The floating pet: one borderless, transparent, always-on-top window for every
# Claude Code session. Each session's mod writes sessions\<id>.json; the window
# shows the busiest one and animates the pet from pet.json. Only the pet is
# drawn, plus a card when a session asks permission while the person is away
# from Claude. The pet also lives: it follows the cursor, likes being petted,
# gets dizzy when shaken, yawns at night and strolls when bored.
# PowerShell names and JSON keys ignore case: keep them distinct by more than case.

trap { try { "$(Get-Date -Format s) $($_ | Out-String)" | Out-File -Append -Encoding UTF8 (Join-Path $Dir 'overlay-error.log') } catch {}; exit 1 }

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, Microsoft.VisualBasic, System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PetWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUT p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUT { public uint cbSize; public uint dwTime; }
  public static double IdleSeconds() {
    LASTINPUT li = new LASTINPUT(); li.cbSize = 8;
    if (!GetLastInputInfo(ref li)) return 0;
    return ((uint)Environment.TickCount - li.dwTime) / 1000.0;
  }
}
'@

$mutex = New-Object System.Threading.Mutex($false, "Local\$Instance")
try { if (-not $mutex.WaitOne(0)) { exit 3 } } catch [System.Threading.AbandonedMutexException] {}

$petFile = Join-Path $Dir 'pet.json'
$prefsFile = Join-Path $Dir 'prefs.json'
$posFile = Join-Path $Dir 'position.json'
$focusFile = Join-Path $Dir 'focus.json'
$lifeFile = Join-Path $Dir 'life.json'
$sessionsDir = Join-Path $Dir 'sessions'
$asksDir = Join-Path $Dir 'asks'
$answersDir = Join-Path $Dir 'answers'
$zoom = 1.4
$VW = 120; $VH = 110
$winW = 300; $winH = 330

function New-Brush([string]$hex) {
  $b = New-Object Windows.Media.SolidColorBrush ([Windows.Media.ColorConverter]::ConvertFromString($hex))
  $b.Freeze(); return $b
}
function New-Grad([string]$from, [string]$to) {
  $g = New-Object Windows.Media.LinearGradientBrush
  $g.StartPoint = '0,0'; $g.EndPoint = '0,1'
  $g.GradientStops.Add((New-Object Windows.Media.GradientStop ([Windows.Media.ColorConverter]::ConvertFromString($from)), 0))
  $g.GradientStops.Add((New-Object Windows.Media.GradientStop ([Windows.Media.ColorConverter]::ConvertFromString($to)), 1))
  $g.Freeze(); return $g
}
function Now-Ms { [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }

$coral = New-Brush '#D97757'
$ink = New-Brush '#2B211C'
$muted = New-Brush '#7A6F69'

# --- window -----------------------------------------------------------------------

$window = New-Object Windows.Window -Property @{
  WindowStyle = 'None'; AllowsTransparency = $true; Background = [Windows.Media.Brushes]::Transparent
  Topmost = $true; ShowInTaskbar = $false; ShowActivated = $false; ResizeMode = 'NoResize'
  Width = $winW; Height = $winH; Title = $(if ($Instance -eq 'ClaudePixelPetOverlay') { 'Claude pet' } else { "Claude pet $Instance" })
}
$root = New-Object Windows.Controls.Grid
$root.RowDefinitions.Add((New-Object Windows.Controls.RowDefinition -Property @{ Height = ($winH - [Math]::Ceiling($VH * $zoom)) }))
$root.RowDefinitions.Add((New-Object Windows.Controls.RowDefinition -Property @{ Height = [Math]::Ceiling($VH * $zoom) }))
$window.Content = $root

$stage = New-Object Windows.Controls.Canvas -Property @{
  Width = $VW; Height = $VH; Background = [Windows.Media.Brushes]::Transparent; Cursor = 'Hand'
  HorizontalAlignment = 'Right'; VerticalAlignment = 'Bottom'
}
$stage.LayoutTransform = New-Object Windows.Media.ScaleTransform($zoom, $zoom)
# appearing and disappearing scale the whole pet around the spot at its feet
$stageScale = New-Object Windows.Media.ScaleTransform(0.35, 0.35, ($VW / 2), 96)
$stage.RenderTransform = $stageScale
$window.Opacity = 0
[Windows.Controls.Grid]::SetRow($stage, 1)
$root.Children.Add($stage) | Out-Null
[Windows.Controls.ToolTipService]::SetInitialShowDelay($stage, 900)
[Windows.Controls.ToolTipService]::SetPlacement($stage, [Windows.Controls.Primitives.PlacementMode]::Top)

# --- the permission card ---------------------------------------------------------------

function New-Pill([string]$label, $bg, $fg, $edge) {
  $t = New-Object Windows.Controls.TextBlock -Property @{ Text = $label; Foreground = $fg; FontSize = 12.5; FontWeight = 'SemiBold'; FontFamily = 'Segoe UI' }
  $b = New-Object Windows.Controls.Border -Property @{
    Background = $bg; BorderBrush = $edge; BorderThickness = 1.5; CornerRadius = 9; Padding = '12,5,12,6'
    Margin = '0,0,6,0'; Cursor = 'Hand'; Child = $t
  }
  return $b
}

$cardTitle = New-Object Windows.Controls.TextBlock -Property @{ FontFamily = 'Segoe UI'; FontSize = 11; Foreground = $coral; FontWeight = 'Bold' }
$cardWhat = New-Object Windows.Controls.TextBlock -Property @{ FontFamily = 'Segoe UI'; FontSize = 13.5; Foreground = $ink; FontWeight = 'SemiBold'; TextWrapping = 'Wrap'; Margin = '0,2,0,6' }
$cardCode = New-Object Windows.Controls.TextBlock -Property @{ FontFamily = 'Consolas'; FontSize = 11.5; Foreground = $ink; TextWrapping = 'Wrap'; MaxHeight = 48; TextTrimming = 'CharacterEllipsis' }
$codeBox = New-Object Windows.Controls.Border -Property @{ Background = (New-Brush '#F3EFE9'); CornerRadius = 6; Padding = '7,4,7,5'; Child = $cardCode; Margin = '0,0,0,9' }
$allowBtn = New-Pill 'Разрешить' $coral (New-Brush '#FFFFFF') $coral
$denyBtn = New-Pill 'Отклонить' (New-Brush '#FFFFFF') $ink (New-Brush '#D8D1CA')
$appBtn = New-Pill 'В Claude ↗' (New-Brush '#FFFFFF') $muted (New-Brush '#FFFFFF')
$buttons = New-Object Windows.Controls.StackPanel -Property @{ Orientation = 'Horizontal' }
foreach ($btn in $allowBtn, $denyBtn, $appBtn) { $buttons.Children.Add($btn) | Out-Null }
$cardMore = New-Object Windows.Controls.TextBlock -Property @{ FontFamily = 'Segoe UI'; FontSize = 11; Foreground = $muted; Margin = '0,6,0,0'; Visibility = 'Collapsed' }
$cardStack = New-Object Windows.Controls.StackPanel
foreach ($el in $cardTitle, $cardWhat, $codeBox, $buttons, $cardMore) { $cardStack.Children.Add($el) | Out-Null }
$card = New-Object Windows.Controls.Border -Property @{
  Background = (New-Brush '#FFFDF9'); BorderBrush = $coral; BorderThickness = 2; CornerRadius = 14; Padding = '12,9,12,11'
  MaxWidth = 286; HorizontalAlignment = 'Right'; VerticalAlignment = 'Bottom'; Margin = '0,0,8,2'
  Child = $cardStack; Visibility = 'Collapsed'
  Effect = (New-Object Windows.Media.Effects.DropShadowEffect -Property @{ BlurRadius = 14; ShadowDepth = 2; Opacity = 0.22; Direction = 270 })
}
[Windows.Controls.Grid]::SetRow($card, 0)
$root.Children.Add($card) | Out-Null

# --- position: remembered, bottom-right by default ---------------------------------

$wa = [Windows.SystemParameters]::WorkArea
$script:homeLeft = $wa.Right - $winW - 8
$script:homeTop = $wa.Bottom - $winH
if (Test-Path $posFile) {
  try {
    $saved = Get-Content $posFile -Raw | ConvertFrom-Json
    $vl = [Windows.SystemParameters]::VirtualScreenLeft; $vt = [Windows.SystemParameters]::VirtualScreenTop
    $vw2 = [Windows.SystemParameters]::VirtualScreenWidth; $vh2 = [Windows.SystemParameters]::VirtualScreenHeight
    # keep the whole window on screen, even if it was saved by a narrower older version
    $script:homeLeft = [Math]::Max($vl, [Math]::Min([double]$saved.left, $vl + $vw2 - $winW))
    $script:homeTop = [Math]::Max($vt, [Math]::Min([double]$saved.top, $vt + $vh2 - $winH))
  } catch {}
}
# never start behind the main screen's taskbar
$homeCx = $script:homeLeft + $winW / 2
if ($homeCx -ge $wa.Left -and $homeCx -le $wa.Right -and $script:homeTop + $winH -gt $wa.Bottom) { $script:homeTop = $wa.Bottom - $winH }
$window.Left = $script:homeLeft
$window.Top = $script:homeTop

# --- the pet's layers ----------------------------------------------------------------

$script:layer = @{}
$script:tx = @{}
$script:shown = @{}
$script:topKind = ''
$script:petWrite = [datetime]::MinValue
$script:faceKey = ''

function New-Layer($parent) {
  $c = New-Object Windows.Controls.Canvas
  $parent.Children.Add($c) | Out-Null
  return $c
}

function New-Moving($parent, [string]$name, [double]$px, [double]$py) {
  $c = New-Layer $parent
  $group = New-Object Windows.Media.TransformGroup
  $scale = New-Object Windows.Media.ScaleTransform(1, 1, $px, $py)
  $rotate = New-Object Windows.Media.RotateTransform(0, $px, $py)
  $move = New-Object Windows.Media.TranslateTransform(0, 0)
  $group.Children.Add($scale); $group.Children.Add($rotate); $group.Children.Add($move)
  $c.RenderTransform = $group
  $script:tx[$name] = @{ scale = $scale; rotate = $rotate; move = $move; canvas = $c }
  return $c
}

function Add-Part($canvas, $part) {
  $path = New-Object Windows.Shapes.Path
  $path.Data = [Windows.Media.Geometry]::Parse([string]$part.d)
  if ($null -ne $part.grad) { $path.Fill = New-Grad ([string]$part.grad[0]) ([string]$part.grad[1]) }
  elseif ($null -ne $part.fill) { $path.Fill = New-Brush ([string]$part.fill) }
  if ($null -ne $part.stroke) {
    $path.Stroke = New-Brush ([string]$part.stroke)
    $path.StrokeThickness = [double]$part.sw
    $path.StrokeStartLineCap = 'Round'; $path.StrokeEndLineCap = 'Round'; $path.StrokeLineJoin = 'Round'
  }
  if ($null -ne $part.opacity) { $path.Opacity = [double]$part.opacity }
  $canvas.Children.Add($path) | Out-Null
}

$faceRoles = 'eyes-open', 'eyes-happy', 'eyes-closed', 'eyes-x', 'eyes-dizzy', 'mouth-smile', 'mouth-small', 'mouth-open', 'mouth-flat'
$fxRoles = 'fx-think', 'fx-dot1', 'fx-dot2', 'fx-dot3', 'fx-bang', 'fx-spark1', 'fx-spark2', 'fx-spark3', 'fx-z1', 'fx-z2', 'fx-drop', 'fx-heart1', 'fx-heart2', 'laptop', 'laptop-logo'

function Build-Pet {
  if (-not (Test-Path $petFile)) { return }
  $w = (Get-Item $petFile).LastWriteTimeUtc
  if ($w -eq $script:petWrite) { return }
  $script:petWrite = $w
  try { $pet = Get-Content $petFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return }

  $stage.Children.Clear()
  $script:layer = @{}; $script:tx = @{}
  $pv = $pet.pivots
  $pt = { param($k) @([double]$pv.$k[0], [double]$pv.$k[1]) }

  $script:layer['shadow'] = New-Moving $stage 'shadow' 60 95
  $flip = New-Moving $stage 'flip' 60 60
  $script:layer['legs'] = New-Moving $flip 'legs' 60 92
  $b = & $pt 'body'
  $bodyC = New-Moving $flip 'body' $b[0] $b[1]
  $q = & $pt 'tail'; $script:layer['tail'] = New-Moving $bodyC 'tail' $q[0] $q[1]
  $script:layer['ears'] = New-Layer $bodyC
  $q = & $pt 'arm-l'; $script:layer['arm-l'] = New-Moving $bodyC 'arm-l' $q[0] $q[1]
  $q = & $pt 'arm-r'; $script:layer['arm-r'] = New-Moving $bodyC 'arm-r' $q[0] $q[1]
  $script:layer['body'] = New-Layer $bodyC
  $q = & $pt 'eyes'
  $eyesC = New-Moving $bodyC 'eyes' $q[0] $q[1]
  foreach ($r in $faceRoles) {
    if ($r -like 'eyes-*') { $script:layer[$r] = New-Layer $eyesC } else { $script:layer[$r] = New-Layer $bodyC }
  }
  $script:layer['top-stem'] = New-Layer $bodyC
  $q = & $pt 'top'; $script:layer['top'] = New-Moving $bodyC 'top' $q[0] $q[1]
  $fxC = New-Layer $stage
  foreach ($r in $fxRoles) { $script:layer[$r] = New-Moving $fxC $r 60 60 }

  foreach ($part in $pet.parts) {
    $target = $script:layer[[string]$part.role]
    if ($null -ne $target) { Add-Part $target $part }
  }
  $script:shown = @{}
  foreach ($m in $pet.shown.PSObject.Properties) { $script:shown[$m.Name] = @($m.Value) }
  $script:topKind = [string]$pet.topKind
  $script:faceKey = ''
}

function Show-Only([string[]]$roles) {
  $key = ($roles | Sort-Object) -join ','
  if ($key -eq $script:faceKey) { return }
  $script:faceKey = $key
  foreach ($r in ($faceRoles + $fxRoles)) {
    $l = $script:layer[$r]
    if ($null -ne $l) { $l.Visibility = $(if ($roles -contains $r) { 'Visible' } else { 'Collapsed' }) }
  }
}

# --- life: energy that remembers, reactions to the person -----------------------------

$script:energy = 60.0
if (Test-Path $lifeFile) { try { $script:energy = [double](Get-Content $lifeFile -Raw | ConvertFrom-Json).energy } catch {} }
function Add-Energy([double]$d) {
  $script:energy = [Math]::Max(0.0, [Math]::Min(100.0, $script:energy + $d))
  try { @{ energy = [Math]::Round($script:energy, 1) } | ConvertTo-Json | Set-Content $lifeFile -Encoding UTF8 } catch {}
}

$script:reaction = ''
$script:reactionUntil = 0.0
$script:reactionStart = 0.0
function Start-Reaction([string]$kind, [double]$seconds) {
  $now = $clock.Elapsed.TotalSeconds
  $script:reaction = $kind; $script:reactionStart = $now; $script:reactionUntil = $now + $seconds
}

$clock = [Diagnostics.Stopwatch]::StartNew()
$script:lastCursor = $null
$script:lastCursorMove = 0.0
$script:petMoves = New-Object System.Collections.ArrayList
$script:lastPetLove = -100.0
$script:nextYawn = 30.0
$script:nextStretch = 70.0
$script:walk = $null
$script:nextWalk = 50.0
$script:facing = 1.0
$script:hidden = $false
$script:wantHidden = $false
$script:fullyHidden = $false
$script:dragging = $false

$script:vis = 0.0          # 0 gone .. 1 fully there
$script:lastFade = 0.0
$script:greeted = $false
$script:lastHello = -1000.0
$script:claudeCheck = 0
$script:closing = $false

# an error inside a timer would otherwise vanish: log it once per place and kind
$script:loggedErrors = @{}
function Write-PetError([string]$where, $err) {
  $key = "$where|$($err.Exception.Message)"
  if ($script:loggedErrors.ContainsKey($key)) { return }
  $script:loggedErrors[$key] = $true
  try { "$(Get-Date -Format s) [$where] $($err | Out-String) $($err.ScriptStackTrace)" | Out-File -Append -Encoding UTF8 (Join-Path $Dir 'overlay-error.log') } catch {}
}

# brings the Claude app forward, restoring it when minimized; its window title
# is the open session's name, so it is found by its process, not its title
$script:claudeAppId = $null
function Show-Claude {
  $app = Get-Process -Name 'claude' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
  if ($null -ne $app) {
    $hw = $app.MainWindowHandle
    if ([PetWin]::IsIconic($hw)) { [void][PetWin]::ShowWindow($hw, 9) }
    [void][PetWin]::SetForegroundWindow($hw)
    return
  }
  # closed with its X, Claude keeps running in the tray with no window: starting
  # the app again makes the running copy show its window
  if ($null -eq $script:claudeAppId) {
    $script:claudeAppId = ''
    try {
      $pkg = Get-AppxPackage -Name 'Claude' -ErrorAction Stop | Select-Object -First 1
      if ($null -ne $pkg) { $script:claudeAppId = "$($pkg.PackageFamilyName)!Claude" }
    } catch {}
  }
  try {
    if ($script:claudeAppId -ne '') { Start-Process "shell:AppsFolder\$($script:claudeAppId)"; return }
    # an install outside the Store: start the desktop app's own executable
    $exe = Get-Process -Name 'claude' -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path -notlike '*claude-code*' } | Select-Object -First 1 -ExpandProperty Path
    if ($exe) { Start-Process $exe }
  } catch { Write-PetError 'show-claude' $_ }
}

# goes away for good: the same shrinking animation, then the window closes
function Leave {
  $script:closing = $true
  $script:wantHidden = $true
}

# the pet pops in from the spot at its feet with a springy overshoot and a
# wave, and shrinks away into that spot when it should step aside
function Fade {
  $now = $clock.Elapsed.TotalSeconds
  if ($script:closing -and ($script:fullyHidden -or $script:vis -le 0)) { $window.Close(); return }
  $dt = [Math]::Max(0.0, [Math]::Min(0.1, $now - $script:lastFade))
  $script:lastFade = $now
  $show = -not $script:wantHidden

  if ($show -and $script:fullyHidden) {
    $window.Visibility = 'Visible'
    $script:fullyHidden = $false
    $script:greeted = $false
  }
  if ($show) { $script:vis = [Math]::Min(1.0, $script:vis + $dt / 0.5) } else { $script:vis = [Math]::Max(0.0, $script:vis - $dt / 0.32) }
  $p = $script:vis

  if ($show) {
    # ease-out-back: grows past full size a little, then settles
    $q = $p - 1
    $scale = 1 + 2.70158 * $q * $q * $q + 1.70158 * $q * $q
    $window.Opacity = [Math]::Min(1.0, $p * 2.5)
    if (-not $script:greeted -and $p -gt 0.25) {
      $script:greeted = $true
      # waves when it comes back, but not on every switch between windows
      if ($now - $script:lastHello -gt 60) { Start-Reaction 'hello' 1.5; $script:lastHello = $now }
    }
  } else {
    # shrinks down into its shadow while fading
    $scale = 0.35 + 0.65 * $p * $p
    $window.Opacity = $p
  }
  $stageScale.ScaleX = $scale
  $stageScale.ScaleY = $scale

  if ($p -gt 0 -and $p -lt 1) {
    $frameTimer.Interval = [TimeSpan]::FromMilliseconds(16)
  } elseif (-not $show -and $p -le 0 -and -not $script:fullyHidden) {
    $window.Visibility = 'Hidden'
    $script:fullyHidden = $true
    $frameTimer.Interval = [TimeSpan]::FromMilliseconds(250)
  }
}

# --- sessions and permission questions ------------------------------------------------

$script:sessions = @()
$script:mood = ''
$script:focusId = ''
$script:night = $false
$script:eyeX = 0.0
$script:eyeY = 0.0
$script:nextBlink = 2.0
$script:blinkTwice = $false
$script:moodSince = 0.0
$script:pinned = ''
$script:lonelySince = $null
$script:ask = $null
$script:answered = @{}
$script:claudeFront = $false
$script:away = $false
$script:focusWritten = -100.0

function Get-Priority($s) {
  switch ([string]$s.mood) {
    'waiting' { 5 } 'working' { 4 } 'thinking' { 4 } 'error' { 3 } 'done' { 3 } 'idle' { 1 } default { 0 }
  }
}

function Read-Folder([string]$folder, [double]$maxAge) {
  $list = @()
  if (Test-Path $folder) {
    foreach ($file in Get-ChildItem $folder -Filter '*.json' -ErrorAction SilentlyContinue) {
      $age = ((Get-Date).ToUniversalTime() - $file.LastWriteTimeUtc).TotalSeconds
      try { $s = Get-Content $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
      # a session whose own process exited (Claude closed) is gone at once
      $dead = $false
      if ($null -ne $s.pid -and [int]$s.pid -gt 0) {
        # an exited process can linger in the list while something holds it open
        $owner = Get-Process -Id ([int]$s.pid) -ErrorAction SilentlyContinue
        $dead = $null -eq $owner -or $owner.HasExited
      }
      if ($s.gone -eq $true -or $age -gt $maxAge -or $dead) { Remove-Item $file.FullName -ErrorAction SilentlyContinue; continue }
      $list += $s
    }
  }
  return , $list
}

function Select-Focus {
  $alive = $script:sessions
  if ($alive.Count -eq 0) { return $null }
  if ($script:pinned -ne '') {
    $hit = $alive | Where-Object { $_.id -eq $script:pinned } | Select-Object -First 1
    if ($null -ne $hit) { return $hit }
  }
  return $alive | Sort-Object @{ Expression = { Get-Priority $_ }; Descending = $true }, @{ Expression = { [double]$_.changed }; Descending = $true } | Select-Object -First 1
}

function Update-Foreground {
  $h = [PetWin]::GetForegroundWindow()
  $procId = [uint32]0
  [void][PetWin]::GetWindowThreadProcessId($h, [ref]$procId)
  $name = ''
  try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  # Claude counts as in use only when its real window is up front: minimized,
  # Windows hands the foreground to a hidden helper window of the same app
  # (an invisible one, still "visible" to Windows): only the app's main window counts
  $front = $false
  if ($name -eq 'claude' -and -not [PetWin]::IsIconic($h)) {
    $mains = @(Get-Process -Name 'claude' -ErrorAction SilentlyContinue | ForEach-Object { $_.MainWindowHandle } | Where-Object { $_ -ne [IntPtr]::Zero })
    $front = $mains -contains $h
  }

  # hide during full-screen apps (games, video), unless a question waits
  $full = $false
  if ($procId -ne $PID -and $name -ne 'explorer') {
    $sb = New-Object System.Text.StringBuilder 64
    [void][PetWin]::GetClassName($h, $sb, 64)
    $cls = $sb.ToString()
    if ($cls -ne 'Progman' -and $cls -ne 'WorkerW' -and $cls -ne 'Shell_TrayWnd') {
      $rc = New-Object PetWin+RECT
      if ([PetWin]::GetWindowRect($h, [ref]$rc)) {
        $scr = [Windows.Forms.Screen]::FromHandle($h).Bounds
        $full = $rc.Left -le $scr.Left -and $rc.Top -le $scr.Top -and $rc.Right -ge $scr.Right -and $rc.Bottom -ge $scr.Bottom
      }
    }
  }
  # the pet steps aside while the person works in Claude itself or in a
  # full-screen app (a game, a video); a waiting question still shows it
  $script:wantHidden = $script:closing -or (($front -or $full) -and $null -eq $script:ask -and -not $script:dragging)

  # whether the person is at this computer at all: they may follow Claude from a phone
  $idle = [PetWin]::IdleSeconds()
  $away = $idle -gt 60
  $now = $clock.Elapsed.TotalSeconds
  if ($front -ne $script:claudeFront -or $away -ne $script:away -or $now - $script:focusWritten -gt 4) {
    $script:claudeFront = $front
    $script:away = $away
    $script:focusWritten = $now
    try { @{ claude = $front; idle = [Math]::Round($idle); at = (Now-Ms) } | ConvertTo-Json -Compress | Set-Content $focusFile -Encoding UTF8 } catch {}
  }
}

function Send-Answer([string]$decision) {
  $a = $script:ask
  if ($null -eq $a) { return }
  $script:answered[[string]$a.id] = $true
  try {
    if (-not (Test-Path $answersDir)) { New-Item -ItemType Directory $answersDir -Force | Out-Null }
    @{ decision = $decision } | ConvertTo-Json -Compress | Set-Content (Join-Path $answersDir "$($a.id).json") -Encoding UTF8
    Remove-Item (Join-Path $asksDir "$($a.id).json") -ErrorAction SilentlyContinue
  } catch {}
  $script:ask = $null
  $card.Visibility = 'Collapsed'
  if ($decision -eq 'allow') { Start-Reaction 'nod' 0.9 } else { Start-Reaction 'shrug' 0.9 }
}

function Update-Asks {
  $all = Read-Folder $asksDir 660
  $pending = @($all | Where-Object { -not $script:answered.ContainsKey([string]$_.id) } | Sort-Object { [double]$_.created })
  if ($pending.Count -eq 0 -or $script:claudeFront) {
    $script:ask = $null
    $card.Visibility = 'Collapsed'
    return
  }
  $a = $pending[0]
  $script:ask = $a
  $cardTitle.Text = "Нужно разрешение · $($a.label)"
  $cardWhat.Text = [string]$a.title
  $cardCode.Text = [string]$a.detail
  if ($pending.Count -gt 1) { $cardMore.Text = "Ещё вопросов: $($pending.Count - 1)"; $cardMore.Visibility = 'Visible' } else { $cardMore.Visibility = 'Collapsed' }
  $card.Visibility = 'Visible'
}

function Update-Status {
  if ($script:closing) { return }
  if (Test-Path $prefsFile) {
    try { if ((Get-Content $prefsFile -Raw | ConvertFrom-Json).shown -eq $false -and -not $legacyMode) { Leave; return } } catch {}
  }
  if ($legacyMode -and $null -ne $legacyParent -and -not (Get-Process -Id $legacyParent -ErrorAction SilentlyContinue)) { Leave; return }
  # Claude closed completely (the app and every Claude Code process): leave at once
  $script:claudeCheck++
  if (($script:claudeCheck % 5) -eq 0 -and -not (Get-Process -Name 'claude' -ErrorAction SilentlyContinue)) { Leave; return }
  Build-Pet
  Update-Foreground
  $script:sessions = Read-Folder $sessionsDir 90
  # a session still running an older version of the mod writes status.json instead
  $legacy = Join-Path $Dir 'status.json'
  if (Test-Path $legacy) {
    $legacyAge = ((Get-Date).ToUniversalTime() - (Get-Item $legacy).LastWriteTimeUtc).TotalSeconds
    if ($legacyMode) {
      try {
        $old = Get-Content $legacy -Raw -Encoding UTF8 | ConvertFrom-Json
        $script:sessions += [pscustomobject]@{
          id = 'legacy'; label = 'сессия (старая версия)'; mood = [string]$old.mood; text = [string]$old.text
          changed = [DateTimeOffset]::new((Get-Item $legacy).LastWriteTimeUtc).ToUnixTimeMilliseconds()
        }
      } catch {}
    }
  }
  Update-Asks
  if ($script:sessions.Count -eq 0) {
    if ($null -eq $script:lonelySince) { $script:lonelySince = $clock.Elapsed.TotalSeconds }
    elseif ($clock.Elapsed.TotalSeconds - $script:lonelySince -gt 6) { Leave; return }
  } else { $script:lonelySince = $null }

  $focus = Select-Focus
  $mood = if ($null -eq $focus) { 'sleeping' } else { [string]$focus.mood }
  $focusId = if ($null -eq $focus) { '' } else { [string]$focus.id }
  if ($mood -ne $script:mood -or $focusId -ne $script:focusId) {
    # energy follows real outcomes, not the pet switching to another session
    if ($focusId -eq $script:focusId) {
      if ($mood -eq 'done') { Add-Energy 6 }
      if ($mood -eq 'error') { Add-Energy -8 }
    }
    $script:mood = $mood
    $script:focusId = $focusId
    $script:moodSince = $clock.Elapsed.TotalSeconds
  }
  $hour = (Get-Date).Hour
  $script:night = $hour -ge 23 -or $hour -lt 7

  $lines = foreach ($s in $script:sessions) {
    $mark = if ($null -ne $focus -and $s.id -eq $focus.id) { '▸' } else { '  ' }
    "$mark $($s.label): $($s.text)"
  }
  $mood2 = if ($script:energy -ge 75) { 'бодрый' } elseif ($script:energy -le 30) { 'уставший' } else { 'спокойный' }
  $stage.ToolTip = $(if ($lines) { ($lines -join "`n") + "`nНастроение: $mood2" } else { 'Нет активных сессий Claude Code' })
}

# --- motion ----------------------------------------------------------------------------

function Set-T([string]$name, [double]$dx = 0, [double]$dy = 0, [double]$rot = 0, [double]$sx = 1, [double]$sy = 1) {
  $t = $script:tx[$name]
  if ($null -eq $t) { return }
  $t.move.X = $dx; $t.move.Y = $dy; $t.rotate.Angle = $rot; $t.scale.ScaleX = $sx; $t.scale.ScaleY = $sy
}
function Set-O([string]$name, [double]$o) { $t = $script:tx[$name]; if ($null -ne $t) { $t.canvas.Opacity = $o } }
function Clamp([double]$v, [double]$lo, [double]$hi) { [Math]::Max($lo, [Math]::Min($hi, $v)) }

function Update-Walk([double]$now, [double]$dt) {
  # never fight the person's hand: no strolling while dragged or out of sight
  if ($script:dragging -or $script:wantHidden) { $script:walk = $null; return $false }
  $idle = $script:mood -eq 'idle' -and $script:reaction -eq ''
  if ($null -eq $script:walk) {
    $away = $window.Left - $script:homeLeft
    if (-not $idle -and [Math]::Abs($away) -gt 1) {
      $script:walk = @{ target = $script:homeLeft; speed = 90 }
    } elseif ($idle -and $now -gt $script:nextWalk -and $script:energy -gt 35 -and -not $stage.IsMouseOver -and $now - $script:moodSince -gt 30) {
      $dist = 60 + (Get-Random -Maximum 110)
      $dir = $(if ((Get-Random -Maximum 2) -eq 0) { -1 } else { 1 })
      if ([Math]::Abs($away) -gt 40) { $dir = -[Math]::Sign($away) }
      # strolls stay near home, so a pet on a second monitor stays there
      $target = Clamp ($window.Left + $dir * $dist) ($script:homeLeft - 180) ($script:homeLeft + 180)
      $script:walk = @{ target = $target; speed = 24 + $script:energy * 0.2 }
      $script:nextWalk = $now + 40 + (Get-Random -Maximum 50)
    }
  }
  if ($null -ne $script:walk) {
    $diff = $script:walk.target - $window.Left
    if ([Math]::Abs($diff) -lt 1.5) { $script:walk = $null; return $false }
    $step = [Math]::Sign($diff) * [Math]::Min([Math]::Abs($diff), $script:walk.speed * $dt)
    $window.Left = $window.Left + $step
    $script:facing = $(if ($diff -lt 0) { -1.0 } else { 1.0 })
    return $true
  }
  return $false
}

$script:lastFrame = 0.0
function Animate {
  if ($script:tx.Count -eq 0) { return }
  $t = $clock.Elapsed.TotalSeconds
  $dt = Clamp ($t - $script:lastFrame) 0 0.1
  $script:lastFrame = $t
  $mt = $t - $script:moodSince
  if ($script:reaction -ne '' -and $t -gt $script:reactionUntil) { $script:reaction = '' }
  $rt = $t - $script:reactionStart

  $dx = 0.0; $dy = 0.0; $rot = 0.0; $sy = 1.0; $sx = 1.0
  $lookX = 0.0; $lookY = 0.0; $blink = 1.0; $eyeScale = 1.0
  $top = [Math]::Sin($t * 1.5) * 6; $armL = 0.0; $armR = 0.0; $tail = [Math]::Sin($t * 2) * 8
  $spin = $script:topKind -eq 'spark'
  $vigor = 0.6 + $script:energy / 100
  $tired = $script:energy -lt 30
  $night = $script:night

  # blinks come at uneven intervals, sometimes twice in a row
  if ($t -ge $script:nextBlink) {
    if ($t -lt $script:nextBlink + 0.13) { $blink = 0.1 }
    elseif ($script:blinkTwice -and $t -lt $script:nextBlink + 0.25) { $blink = 1.0 }
    elseif ($script:blinkTwice -and $t -lt $script:nextBlink + 0.38) { $blink = 0.1 }
    else {
      $script:nextBlink = $t + 2.5 + (Get-Random -Maximum 35) / 10
      $script:blinkTwice = (Get-Random -Maximum 4) -eq 0
    }
  }

  # follow the cursor with the eyes when it moves
  $pnt = New-Object PetWin+POINT
  [void][PetWin]::GetCursorPos([ref]$pnt)
  if ($null -ne $script:lastCursor -and ($pnt.X -ne $script:lastCursor.X -or $pnt.Y -ne $script:lastCursor.Y)) { $script:lastCursorMove = $t }
  $script:lastCursor = $pnt
  $tracking = $t - $script:lastCursorMove -lt 3.5
  if ($tracking) {
    try {
      $eyeAt = $stage.PointToScreen((New-Object Windows.Point 60, 62))
      $lx = Clamp (($pnt.X - $eyeAt.X) / 160) -1 1
      $ly = Clamp (($pnt.Y - $eyeAt.Y) / 160) -1 1
    } catch { $lx = 0; $ly = 0 }
  }

  $face = @($script:shown[$script:mood])
  $walking = Update-Walk $t $dt

  switch ($script:mood) {
    'idle' {
      $dy = ([Math]::Sin($t * 2.1 * $vigor) - 1) * 0.9 * $vigor
      $sy = 1 + [Math]::Sin($t * 2.1) * 0.012
      $lookX = 2.2 * [Math]::Pow([Math]::Sin($t * 0.45), 3)
      $armL = [Math]::Sin($t * 2.1) * 4; $armR = -$armL
      if ($tired) { $eyeScale = 0.82; $top = -10 }
      if ($walking) {
        $dy = -[Math]::Abs([Math]::Sin($t * 9)) * 2
        $armL = [Math]::Sin($t * 9) * 14; $armR = $armL
      } elseif ($script:reaction -eq '') {
        $sleepy = $night -or $tired
        if ($sleepy -and $t -gt $script:nextYawn) { Start-Reaction 'yawn' 2.0; $script:nextYawn = $t + 25 + (Get-Random -Maximum 30) }
        elseif (-not $sleepy -and $t -gt $script:nextStretch) { Start-Reaction 'stretch' 1.6; $script:nextStretch = $t + 70 + (Get-Random -Maximum 60) }
      }
    }
    'thinking' {
      $dy = ([Math]::Sin($t * 1.4) - 1) * 1.2
      $lookX = 1.6; $lookY = -2.4
      if ($spin) { $top = $t * 140 } else { $top = [Math]::Sin($t * 3) * 12 }
      $armR = 20 + [Math]::Sin($t * 2) * 6
      $n = [Math]::Floor(($t * 1.8) % 4)
      Set-O 'fx-dot1' $(if ($n -ge 1) { 1 } else { 0.18 })
      Set-O 'fx-dot2' $(if ($n -ge 2) { 1 } else { 0.18 })
      Set-O 'fx-dot3' $(if ($n -ge 3) { 1 } else { 0.18 })
      $float = [Math]::Sin($t * 1.6) * 1.2
      foreach ($k in 'fx-think', 'fx-dot1', 'fx-dot2', 'fx-dot3') { Set-T $k 0 $float }
    }
    'working' {
      $dy = -[Math]::Abs([Math]::Sin($t * 9)) * 1.1
      $lookY = 2.6; $eyeScale = 0.75
      if ($spin) { $top = $t * 70 }
      $armL = [Math]::Sin($t * 15) * 16 - 10; $armR = -[Math]::Sin($t * 15 + 1.3) * 16 + 10
      Set-O 'laptop-logo' (0.65 + 0.35 * [Math]::Sin($t * 4))
    }
    'waiting' {
      $rot = [Math]::Sin($t * 3) * 3
      $eyeScale = 1.18
      $armR = -45 + [Math]::Sin($t * 9) * 22
      Set-T 'fx-bang' 0 (-[Math]::Abs([Math]::Sin($t * 4.5)) * 4)
    }
    'done' {
      if ($mt -lt 1.2) {
        $hop = [Math]::Abs([Math]::Sin($mt * [Math]::PI * 2.5))
        $dy = -$hop * 13 * $vigor
        $sy = 1 + ($hop - 0.5) * 0.08
      } else { $dy = -[Math]::Abs([Math]::Sin($t * 3)) * 2 }
      $armL = 38 + [Math]::Sin($t * 8) * 10; $armR = -$armL
      if ($spin) { $top = $t * 200 }
      $i = 0
      foreach ($k in 'fx-spark1', 'fx-spark2', 'fx-spark3') { Set-O $k (([Math]::Sin($t * 4 + $i * 2.1) + 1) / 2); $i++ }
    }
    'error' {
      if ($mt -lt 0.5) { $dx = [Math]::Sin($mt * 55) * 2.4 }
      $sy = 0.985; $top = -12; $armL = -15; $armR = 15
      $ph = ($t * 0.8) % 1
      Set-T 'fx-drop' 0 ($ph * 8); Set-O 'fx-drop' (1 - $ph)
    }
    'sleeping' {
      $sy = 1 + [Math]::Sin($t * 1.6) * 0.025
      $blink = 1; $top = -8; $tail = 0; $armL = -8; $armR = 8
      $i = 0
      foreach ($k in 'fx-z1', 'fx-z2') {
        $ph = (($t * 0.33) + $i * 0.5) % 1
        Set-T $k ([Math]::Sin($ph * 6) * 2) (-$ph * 14)
        Set-O $k ([Math]::Sin($ph * [Math]::PI))
        $i++
      }
    }
  }

  # the eyes follow a moving cursor, except while busy at the laptop or asleep
  if ($tracking -and $script:mood -ne 'working' -and $script:mood -ne 'sleeping') {
    $lookX = $lx * 2.8; $lookY = $ly * 2.3
  }

  # reactions to the person win over the mood for a moment
  switch ($script:reaction) {
    'pet' {
      $face = @('eyes-happy', 'mouth-smile', 'fx-heart1', 'fx-heart2')
      $rot = [Math]::Sin($rt * 5) * 4; $sy = 1 + [Math]::Sin($rt * 10) * 0.02
      $armL = 25; $armR = -25
      Set-T 'fx-heart1' ([Math]::Sin($rt * 3) * 2) (-$rt * 9); Set-O 'fx-heart1' (Clamp (1.6 - $rt * 0.6) 0 1)
      Set-T 'fx-heart2' ([Math]::Sin($rt * 3 + 1) * 2) (-$rt * 7); Set-O 'fx-heart2' (Clamp (1.8 - $rt * 0.7) 0 1)
    }
    'poke' {
      $face = @('eyes-open', 'mouth-open')
      $eyeScale = 1.25
      $sq = [Math]::Exp(-$rt * 6) * [Math]::Cos($rt * 22)
      $sy = 1 - $sq * 0.14; $sx = 1 + $sq * 0.08; $dy = -[Math]::Max(0.0, $sq) * 3
    }
    'dizzy' {
      $face = @('eyes-dizzy', 'mouth-flat')
      $rot = [Math]::Sin($rt * 7) * 9 * [Math]::Max(0.0, 1 - $rt / 2.4)
      $dx = [Math]::Sin($rt * 7) * 1.5
    }
    'yawn' {
      $face = @('eyes-closed', 'mouth-open')
      $s = [Math]::Sin([Math]::Min(1.0, $rt / 2.0) * [Math]::PI)
      $sy = 1 + $s * 0.06; $armL = 30 * $s; $armR = -30 * $s; $top = -6
    }
    'stretch' {
      $face = @('eyes-happy', 'mouth-small')
      $s = [Math]::Sin([Math]::Min(1.0, $rt / 1.6) * [Math]::PI)
      $sy = 1 + $s * 0.07; $armL = 55 * $s; $armR = -55 * $s
    }
    'nod' {
      $face = @('eyes-happy', 'mouth-smile')
      $dy = [Math]::Abs([Math]::Sin($rt * 9)) * 1.5
    }
    'shrug' {
      $face = @('eyes-open', 'mouth-flat')
      $armL = 20; $armR = -20; $rot = [Math]::Sin($rt * 6) * 2
    }
    'hello' {
      $face = @('eyes-happy', 'mouth-smile')
      $armR = -70 + [Math]::Sin($rt * 14) * 28
      $dy = -[Math]::Abs([Math]::Sin($rt * 6)) * 2.5 * [Math]::Max(0.0, 1 - $rt / 1.5)
    }
  }
  Show-Only $face
  if ($script:reaction -eq '' -and $script:mood -eq 'sleeping') { Set-O 'top' 0.55 } else { Set-O 'top' 1 }

  Set-T 'flip' 0 0 0 $script:facing 1
  Set-T 'body' $dx $dy $rot $sx $sy
  $lift = [Math]::Min(0.0, $dy)
  if ($lift -lt -2) { Set-T 'legs' $dx $lift } else { Set-T 'legs' $dx 0 }
  if ($walking) { Set-T 'legs' 0 (-[Math]::Abs([Math]::Sin($t * 9 + 1.5)) * 1.2) }
  Set-T 'shadow' 0 0 0 (1 - [Math]::Min(0.35, -$lift / 40)) 1
  # calm moments need fewer frames: resting or asleep, with nothing moving fast
  $calm = ($script:mood -eq 'idle' -or $script:mood -eq 'sleeping') -and $script:reaction -eq '' -and -not $walking -and -not $tracking
  $wantMs = $(if ($calm) { 66 } else { 33 })
  if ($frameTimer.Interval.TotalMilliseconds -ne $wantMs) { $frameTimer.Interval = [TimeSpan]::FromMilliseconds($wantMs) }

  # the eyes glide toward where they look instead of jumping
  $ease = [Math]::Min(1.0, $dt * 9)
  $script:eyeX += ($lookX - $script:eyeX) * $ease
  $script:eyeY += ($lookY - $script:eyeY) * $ease
  Set-T 'eyes' ($script:eyeX * $script:facing) $script:eyeY 0 $eyeScale ($blink * $eyeScale)
  Set-T 'top' 0 0 $top
  Set-T 'arm-l' 0 0 $armL
  Set-T 'arm-r' 0 0 $armR
  Set-T 'tail' 0 0 $tail
}

# --- interaction --------------------------------------------------------------------------

# petting: the cursor rubbing back and forth over the pet
$stage.Add_MouseMove({
  param($sender, $e)
  if ($e.LeftButton -eq 'Pressed') { return }
  $now = $clock.Elapsed.TotalSeconds
  $p = $e.GetPosition($stage)
  [void]$script:petMoves.Add(@{ t = $now; x = $p.X })
  while ($script:petMoves.Count -gt 0 -and $now - $script:petMoves[0].t -gt 1.2) { $script:petMoves.RemoveAt(0) }
  $turns = 0; $lastSign = 0
  for ($i = 1; $i -lt $script:petMoves.Count; $i++) {
    $d = $script:petMoves[$i].x - $script:petMoves[$i - 1].x
    if ([Math]::Abs($d) -lt 0.8) { continue }
    $sg = [Math]::Sign($d)
    if ($lastSign -ne 0 -and $sg -ne $lastSign) { $turns++ }
    $lastSign = $sg
  }
  if ($turns -ge 3 -and $script:reaction -ne 'pet') {
    Start-Reaction 'pet' 2.6
    $script:petMoves.Clear()
    if ($now - $script:lastPetLove -gt 10) { Add-Energy 3; $script:lastPetLove = $now }
  }
})

# dragging: a gentle drag moves the pet, a wild shake makes it dizzy
$script:dragTrack = $null
$window.Add_LocationChanged({
  if ($null -eq $script:dragTrack) { return }
  $now = $clock.Elapsed.TotalSeconds
  $tr = $script:dragTrack
  $dxx = $window.Left - $tr.x
  if ([Math]::Abs($dxx) -gt 6) {
    $sg = [Math]::Sign($dxx)
    if ($tr.sign -ne 0 -and $sg -ne $tr.sign) { $tr.turns++ }
    $tr.sign = $sg
    $speed = [Math]::Abs($dxx) / [Math]::Max(0.005, $now - $tr.t)
    if ($speed -gt $tr.top) { $tr.top = $speed }
    $tr.x = $window.Left; $tr.t = $now
  }
})

$stage.Add_MouseLeftButtonDown({
  param($sender, $e)
  if ($e.ClickCount -ge 2) { Show-Claude; return }
  $script:walk = $null
  $script:dragging = $true
  $startL = $window.Left; $startT = $window.Top
  $script:dragTrack = @{ x = $window.Left; t = $clock.Elapsed.TotalSeconds; sign = 0; turns = 0; top = 0.0 }
  try { $window.DragMove() } catch {}
  $script:dragging = $false
  $tr = $script:dragTrack
  $script:dragTrack = $null
  $moved = [Math]::Abs($window.Left - $startL) + [Math]::Abs($window.Top - $startT)
  if ($moved -lt 3) { Start-Reaction 'poke' 0.9; return }
  # dropped behind the taskbar of the main screen: lift it back above
  $cx = $window.Left + $winW / 2
  if ($cx -ge $wa.Left -and $cx -le $wa.Right -and $window.Top + $winH -gt $wa.Bottom) { $window.Top = $wa.Bottom - $winH }
  $script:homeLeft = $window.Left; $script:homeTop = $window.Top
  try { @{ left = $window.Left; top = $window.Top } | ConvertTo-Json | Set-Content -Path $posFile -Encoding UTF8 } catch {}
  if ($tr.turns -ge 3 -and $tr.top -gt 900) { Start-Reaction 'dizzy' 2.4; Add-Energy -5 }
})

$allowBtn.Add_MouseLeftButtonUp({ Send-Answer 'allow' })
$denyBtn.Add_MouseLeftButtonUp({ Send-Answer 'deny' })
$appBtn.Add_MouseLeftButtonUp({ Show-Claude })

$menu = New-Object Windows.Controls.ContextMenu
$menu.Add_Opened({
  $menu.Items.Clear()
  $head = New-Object Windows.Controls.MenuItem -Property @{ Header = 'Сессии Claude Code'; IsEnabled = $false }
  $menu.Items.Add($head) | Out-Null
  $auto = New-Object Windows.Controls.MenuItem -Property @{ Header = 'Следить за самой активной'; IsCheckable = $true; IsChecked = ($script:pinned -eq '') }
  $auto.Add_Click({ $script:pinned = '' })
  $menu.Items.Add($auto) | Out-Null
  foreach ($s in $script:sessions) {
    $item = New-Object Windows.Controls.MenuItem -Property @{
      Header = "$($s.label): $($s.text)"; IsCheckable = $true; IsChecked = ($script:pinned -eq [string]$s.id); Tag = [string]$s.id
    }
    $item.Add_Click({ param($src, $ev) $script:pinned = [string]$src.Tag })
    $menu.Items.Add($item) | Out-Null
  }
  $menu.Items.Add((New-Object Windows.Controls.Separator)) | Out-Null
  $reset = New-Object Windows.Controls.MenuItem -Property @{ Header = 'Вернуть в угол экрана' }
  $reset.Add_Click({
    $script:homeLeft = $wa.Right - $winW - 8; $script:homeTop = $wa.Bottom - $winH
    $window.Left = $script:homeLeft; $window.Top = $script:homeTop
    Remove-Item $posFile -ErrorAction SilentlyContinue
  })
  $menu.Items.Add($reset) | Out-Null
  $close = New-Object Windows.Controls.MenuItem -Property @{ Header = 'Убрать питомца (вернётся с новой сессией или по /pet)' }
  $close.Add_Click({
    try { '{"shown":false}' | Set-Content -Path $prefsFile -Encoding UTF8 } catch {}
    Leave
  })
  $menu.Items.Add($close) | Out-Null
})
$menu.Items.Add((New-Object Windows.Controls.MenuItem)) | Out-Null
$stage.ContextMenu = $menu

# --- timers ------------------------------------------------------------------------------

$frameTimer = New-Object Windows.Threading.DispatcherTimer
$frameTimer.Interval = [TimeSpan]::FromMilliseconds(33)
$frameTimer.Add_Tick({ try { if (-not $script:fullyHidden) { Animate }; Fade } catch { Write-PetError "frame" $_ } })
$pollTimer = New-Object Windows.Threading.DispatcherTimer
$pollTimer.Interval = [TimeSpan]::FromMilliseconds(300)
$pollTimer.Add_Tick({ try { Update-Status } catch { Write-PetError "poll" $_ } })

$window.Add_Loaded({ Update-Status; $frameTimer.Start(); $pollTimer.Start() })
$window.Add_Closed({
  $frameTimer.Stop(); $pollTimer.Stop()
  try { @{ claude = $true; at = 0 } | ConvertTo-Json -Compress | Set-Content $focusFile -Encoding UTF8 } catch {}
  try { $mutex.ReleaseMutex() } catch {}
})

$app = New-Object Windows.Application
$app.ShutdownMode = 'OnMainWindowClose'
[void]$app.Run($window)
