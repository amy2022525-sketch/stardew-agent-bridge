<#
.SYNOPSIS
    回滚 Mod：移除本次安装的 StardewAgentBridge，并按需恢复最近的备份。
.DESCRIPTION
    - 默认只移除当前安装目录（游戏需先退出）。
    - -RestoreLatest 会把最近的 StardewAgentBridge.bak-* 恢复为 StardewAgentBridge。
    - 绝不触碰存档、游戏本体或其他 Mod。
#>
[CmdletBinding()]
param(
    [string]$GamePath,
    [switch]$RestoreLatest,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

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
$target = Join-Path $mods 'StardewAgentBridge'

$running = Get-Process -Name 'StardewModdingAPI', 'Stardew Valley' -ErrorAction SilentlyContinue
if ($running -and -not $Force) {
    throw "游戏正在运行（$($running.Name -join ', ')）。请先正常退出游戏再回滚。"
}

if (Test-Path $target) {
    Remove-Item $target -Recurse -Force
    Write-Host "[rollback-mod] 已移除：$target"
} else {
    Write-Host "[rollback-mod] 当前没有安装 StardewAgentBridge。"
}

if ($RestoreLatest) {
    $backups = Get-ChildItem $mods -Directory -Filter 'StardewAgentBridge.bak-*' | Sort-Object Name -Descending
    if ($backups.Count -eq 0) {
        Write-Host '[rollback-mod] 没有可恢复的备份。'
    } else {
        $latest = $backups[0]
        Move-Item $latest.FullName $target
        Write-Host "[rollback-mod] 已恢复备份：$($latest.Name) → StardewAgentBridge"
    }
}

Write-Host '[rollback-mod] 完成。游戏存档与游戏本体未被修改。'
