<#
.SYNOPSIS
    把已构建的 Mod 安装到游戏 Mods 目录（可回滚）。
.DESCRIPTION
    - 需要先运行 scripts/build-mod.ps1 生成 artifacts/mod/StardewAgentBridge。
    - 游戏正在运行时拒绝安装：SMAPI 不会热加载新 Mod，强行覆盖会留下半加载状态。
    - 覆盖安装前把旧目录移动为 StardewAgentBridge.bak-<时间戳>，供 rollback-mod.ps1 恢复。
#>
[CmdletBinding()]
param(
    [string]$GamePath,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$artifact = Join-Path $repo 'artifacts\mod\StardewAgentBridge'

if (-not (Test-Path (Join-Path $artifact 'StardewAgentBridge.dll'))) {
    throw '没有找到构建产物，请先运行 scripts/build-mod.ps1。'
}

function Resolve-GamePath {
    param([string]$Explicit)
    if ($Explicit) { return (Resolve-Path $Explicit).Path }
    if ($env:STARDEW_GAME_PATH) { return (Resolve-Path $env:STARDEW_GAME_PATH).Path }
    $steam = (Get-ItemProperty -Path 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath
    if ($steam) {
        $libraryFile = Join-Path $steam 'steamapps\libraryfolders.vdf'
        if (Test-Path $libraryFile) {
            foreach ($match in (Select-String -Path $libraryFile -Pattern '"path"\s+"(.+?)"')) {
                $root = $match.Matches[0].Groups[1].Value -replace '\\\\', '\'
                $candidate = Join-Path $root 'steamapps\common\Stardew Valley'
                if (Test-Path (Join-Path $candidate 'Stardew Valley.dll')) { return (Resolve-Path $candidate).Path }
            }
        }
    }
    throw '未找到星露谷安装目录。请用 -GamePath 或设置环境变量 STARDEW_GAME_PATH。'
}

$resolved = Resolve-GamePath -Explicit $GamePath
$mods = Join-Path $resolved 'Mods'
if (-not (Test-Path $mods)) { throw "找不到 Mods 目录：$mods" }

$running = Get-Process -Name 'StardewModdingAPI', 'Stardew Valley' -ErrorAction SilentlyContinue
if ($running -and -not $Force) {
    throw "游戏正在运行（$($running.Name -join ', ')）。请先正常退出游戏再安装；SMAPI 不支持热加载新 Mod。"
}

$target = Join-Path $mods 'StardewAgentBridge'
if (Test-Path $target) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = Join-Path $mods "StardewAgentBridge.bak-$stamp"
    Move-Item $target $backup
    Write-Host "[install-mod] 旧版本已备份：$backup"
}

New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $artifact '*') $target -Recurse -Force

# 审计：安装目录里不能出现游戏 DLL 或本次会话的存档。
$forbidden = Get-ChildItem $target -Recurse -Include 'Stardew Valley.dll', 'StardewModdingAPI.dll', '*.save' -ErrorAction SilentlyContinue
if ($forbidden) { throw "安装目录包含禁止文件：$($forbidden.Name -join ', ')" }

Write-Host "[install-mod] 已安装到：$target"
Write-Host "[install-mod] 下一步：1) 启动一次 Bridge 生成凭据（npm start）；2) 通过 SMAPI 启动游戏并加载测试存档；3) 运行 npm run doctor 确认连接。"
