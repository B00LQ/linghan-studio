# Studio 自托管容器的启动脚本（Windows / PowerShell）。
#
# 目的：把「跑起来」这件事固定下来，避免每次靠回忆敲一长串 -e。
# 容器只暴露 8080，本地数据挂在 studio\data（换机器时拷这个目录即可）。
#
# 用法：
#   powershell -File scripts\docker-run.ps1                    # 用 .env / 默认值
#   powershell -File scripts\docker-run.ps1 -Rebuild           # 先重建镜像再起容器
#   powershell -File scripts\docker-run.ps1 -Password 'xxx'    # 临时覆盖
#
# 说明：
# - COMFYUI_URL 用 host.docker.internal，容器里访问宿主机的 ComfyUI。
# - STUDIO_SECRET 固定在同一台机器上，否则重启会让所有人的登录态失效。
# - 加了 --add-host=host.docker.internal:host-gateway，Linux 上也能用同一个地址。
# - NodeImage 默认走国内可达的镜像源：Docker Hub 在国内经常连不上，
#   而 Dockerfile 本身保持可移植（默认 node:24-alpine）。
#
# **这个文件是要进仓库的，所以它不写死任何凭据。**
# 访问密码和会话密钥从仓库根目录的 .env 读（.env 已被 .gitignore 排除），
# 参数 > .env > 现生成并打印。写死过一次，后果很具体：
# 会话完全靠 STUDIO_SECRET 做 HMAC 验签，谁看到那个值就能伪造登录 Cookie，
# 连密码都不需要知道——而它曾经就是这里的一个默认参数值。

param(
  [string]$Name = 'studio',
  [int]$Port = 8080,
  [string]$Image = 'studio:local',
  [string]$Password = '',
  [string]$Secret = '',
  [string]$ComfyUiUrl = 'http://host.docker.internal:8188',
  [string]$ImageDriver = 'comfyui',
  [string]$NodeImage = 'docker.1ms.run/library/node:24-alpine',
  [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root 'data'

# 读仓库根目录的 .env（它不入库）。命令行参数优先，所以下面都写成「为空才回退」。
$envFile = Join-Path $root '.env'
$fromEnv = @{}
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -notmatch '=' -or $line -match '^\s*#') { continue }
    $parts = $line -split '=', 2
    $fromEnv[$parts[0].Trim()] = $parts[1].Trim()
  }
}

if ([string]::IsNullOrWhiteSpace($Password)) { $Password = $fromEnv['STUDIO_PASSWORD'] }
$generatedPassword = $false
if ([string]::IsNullOrWhiteSpace($Password)) {
  $bytes = New-Object byte[] 12
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $Password = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_')
  $generatedPassword = $true
}

if ([string]::IsNullOrWhiteSpace($Secret)) { $Secret = $fromEnv['STUDIO_SECRET'] }
$generatedSecret = $false
if ([string]::IsNullOrWhiteSpace($Secret)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $Secret = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
  $generatedSecret = $true
}

if ($generatedPassword -or $generatedSecret) {
  Write-Host ''
  Write-Host '[studio] 这次是现生成的凭据。**重启前请写进 .env**，否则下次重启登录态全部失效：'
  if ($generatedPassword) { Write-Host "  STUDIO_PASSWORD=$Password" }
  if ($generatedSecret) { Write-Host "  STUDIO_SECRET=$Secret" }
  Write-Host ''
}

if ($Rebuild) {
  Write-Host "[studio] 重建镜像 $Image（base=$NodeImage）..."
  docker build --build-arg "NODE_IMAGE=$NodeImage" -t $Image $root
  if ($LASTEXITCODE -ne 0) { throw 'docker build 失败' }
}

if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }

docker rm -f $Name 2>$null | Out-Null

Write-Host "[studio] 启动容器 $Name（$Port -> 8080，数据目录 $dataDir）"
docker run -d --name $Name `
  -p "${Port}:8080" `
  -v "${dataDir}:/data" `
  --add-host=host.docker.internal:host-gateway `
  -e "STUDIO_PASSWORD=$Password" `
  -e "STUDIO_SECRET=$Secret" `
  -e "STUDIO_SECURE_COOKIES=0" `
  -e "STUDIO_IMAGE_DRIVER=$ImageDriver" `
  -e "COMFYUI_URL=$ComfyUiUrl" `
  $Image | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'docker run 失败' }

for ($i = 0; $i -lt 60; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
    if ($r.StatusCode -eq 200) { Write-Host "[studio] 就绪：http://127.0.0.1:$Port  $($r.Content)"; exit 0 }
  } catch { Start-Sleep -Milliseconds 500 }
}
# 起不来时把容器日志直接打出来，省得再去翻 docker logs。
Write-Host "[studio] 健康检查超时，容器日志："
docker logs $Name --tail 40
throw "容器起来了但 $Port 一直没响应健康检查"
