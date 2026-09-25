# 起一个**服务器端（cloud 模式）**的实例，用来「看得见」账号那一层。
#
# 为什么单独一个脚本、单独一个端口、单独一个数据目录：
#   你现在这套 Studio（画布、素材、算力）跑在 **8080 的 local 模式**，那是你的工作台；
#   cloud 模式是**服务器上的那一份**（只管账号，M3 之后还有作品与主页）。
#   两者不能挤在同一个端口上，也不该共用一个数据目录。
#
# 用法（在 studio 目录下）：
#   .\scripts\run-cloud.ps1              # 起在 8081，窗口里会打印地址
#   .\scripts\run-cloud.ps1 -Port 8090   # 换个端口
#   .\scripts\run-cloud.ps1 -Stop        # 关掉
#
param(
  [int]$Port = 8081,
  [string]$DataDir = (Join-Path $PSScriptRoot '..\data-cloud'),
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pidFile = Join-Path $DataDir 'cloud.pid'

function Get-Running {
  if (-not (Test-Path $pidFile)) { return $null }
  $saved = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $saved) { return $null }
  $process = Get-Process -Id ([int]$saved) -ErrorAction SilentlyContinue
  if ($process) { return $process }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  return $null
}

if ($Stop) {
  $running = Get-Running
  if (-not $running) { Write-Output '服务器端实例没有在跑。'; return }
  Stop-Process -Id $running.Id -Force
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Output "已关掉服务器端实例（pid $($running.Id)）。数据还在 $DataDir。"
  return
}

$already = Get-Running
if ($already) {
  Write-Output "服务器端实例已经在跑（pid $($already.Id)）：http://127.0.0.1:$Port/"
  return
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# 会话 cookie 的签名密钥：存下来，重启之后不用重新登录（生产环境请换成自己的固定值）。
$secretFile = Join-Path $DataDir 'secret.txt'
if (-not (Test-Path $secretFile)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [System.IO.File]::WriteAllText($secretFile, [Convert]::ToBase64String($bytes))
}
$secret = (Get-Content $secretFile -Raw).Trim()

$env:STUDIO_MODE = 'cloud'
$env:STUDIO_DATA_DIR = $DataDir
$env:STUDIO_PUBLIC_URL = "http://127.0.0.1:$Port"
$env:STUDIO_SECRET = $secret
$env:PORT = "$Port"
$env:HOST = '127.0.0.1'
# 邮件默认打到日志（不需要任何外部服务）；想接自己的转发服务就设 STUDIO_MAIL_WEBHOOK。
Remove-Item Env:STUDIO_PASSWORD -ErrorAction SilentlyContinue

$log = Join-Path $DataDir 'cloud.log'
$process = Start-Process -FilePath 'node' `
  -ArgumentList @('--experimental-strip-types', (Join-Path $repo 'apps\server\src\index.ts')) `
  -WorkingDirectory $repo -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $log -RedirectStandardError (Join-Path $DataDir 'cloud.err.log')

Set-Content -Path $pidFile -Value $process.Id -Encoding ascii

# 等它就绪（最多 30 秒），然后打印地址 —— 不然人点开浏览器会看到「无法连接」。
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2
    if ($health.StatusCode -eq 200) { $ready = $true; break }
  } catch { }
}

if ($ready) {
  Write-Output "服务器端（cloud 模式）已就绪：http://127.0.0.1:$Port/"
  Write-Output "  数据目录：$DataDir"
  Write-Output "  日志：$log"
  Write-Output "  关掉它：.\scripts\run-cloud.ps1 -Stop"
} else {
  Write-Output "没能起来，看看日志：$log"
}
