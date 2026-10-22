<#
.SYNOPSIS
    把已构建的 Mod 安装到游戏 Mods 目录（可回滚）。
.DESCRIPTION
    - 需要先运行 scripts/build-mod.ps1 生成 artifacts/mod/StardewAgentBridge。
    - 游戏正在运行时拒绝安装：SMAPI 不会热加载新 Mod，强行覆盖会留下半加载状态。
    - 安装前将本项目旧版和 AgentStardew 迁移到 Mods 外的备份目录，供 rollback-mod.ps1 恢复。
#>
[CmdletBinding()]
param(
    [string]$GamePath,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'mod-install-common.ps1')
$repo = Split-Path -Parent $PSScriptRoot
$artifact = Join-Path $repo 'artifacts\mod\StardewAgentBridge'
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'mod\StardewAgentBridge.dll')) { $artifact = Join-Path $PSScriptRoot 'mod' }

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
$mods = Assert-SabChild -Path (Join-Path $resolved 'Mods') -Root $resolved
if (-not (Test-Path $mods)) { throw "找不到 Mods 目录：$mods" }

$running = Get-Process -Name 'StardewModdingAPI', 'Stardew Valley' -ErrorAction SilentlyContinue
if ($running) {
    throw "游戏正在运行（$($running.Name -join ', ')）。请先正常退出游戏再安装；SMAPI 不支持热加载新 Mod。"
}

$target = Assert-SabChild -Path (Join-Path $mods 'StardewAgentBridge') -Root $mods
$newManifest = Get-Content -LiteralPath (Join-Path $artifact 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($newManifest.UniqueID -ne 'StardewAgentBridge.Bridge') { throw '待安装 manifest 的标识不符合本项目。' }
$backupRoot = Get-SabBackupRoot -GameRoot $resolved
$snapshot = Assert-SabChild -Path (Join-Path $backupRoot ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff'))) -Root $backupRoot
$entries = @()
foreach ($directory in (Get-ChildItem -LiteralPath $mods -Directory)) {
    $manifestPath = Join-Path $directory.FullName 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { if ($directory.FullName -eq $target) { throw '目标目录已存在但缺少 manifest，拒绝覆盖。' }; continue }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.UniqueID -in @('AgentStardew.Bridge', 'StardewAgentBridge.Bridge')) {
        $null = Assert-SabChild -Path $directory.FullName -Root $mods
        $entries += [pscustomobject]@{ Name=$directory.Name; UniqueID=$manifest.UniqueID }
    } elseif ($directory.FullName -eq $target) { throw '目标目录属于其他 Mod，拒绝覆盖。' }
}
New-Item -ItemType Directory -Path $snapshot -Force | Out-Null
$state = [pscustomobject]@{ SchemaVersion=1; GamePath=$resolved; Snapshot=$snapshot; Status='prepared'; Previous=$entries }
Write-SabInstallState -State $state -BackupRoot $backupRoot
foreach ($entry in $entries) {
    $source = Assert-SabChild -Path (Join-Path $mods $entry.Name) -Root $mods
    $destination = Assert-SabChild -Path (Join-Path $snapshot $entry.Name) -Root $snapshot
    Move-Item -LiteralPath $source -Destination $destination
    Write-Host "[install-mod] 已备份并停用旧桥接：$($entry.Name)"
}

New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $artifact '*') $target -Recurse -Force
$previousConfig = Join-Path $snapshot 'StardewAgentBridge\config.json'
if (Test-Path -LiteralPath $previousConfig) { Copy-Item -LiteralPath $previousConfig -Destination (Join-Path $target 'config.json') }

# 审计：安装目录里不能出现游戏 DLL 或本次会话的存档。
$forbidden = Get-ChildItem $target -Recurse -Include 'Stardew Valley.dll', 'StardewModdingAPI.dll', '*.save' -ErrorAction SilentlyContinue
if ($forbidden) { throw "安装目录包含禁止文件：$($forbidden.Name -join ', ')" }
$state.Status = 'installed'
Write-SabInstallState -State $state -BackupRoot $backupRoot

Write-Host "[install-mod] 已安装到：$target"
Write-Host "[install-mod] 下一步：1) 启动一次 Bridge 生成凭据（npm start）；2) 通过 SMAPI 启动游戏并加载测试存档；3) 运行 npm run doctor 确认连接。"
