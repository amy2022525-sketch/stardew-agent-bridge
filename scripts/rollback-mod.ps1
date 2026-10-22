<#
.SYNOPSIS
    回滚 Mod：移除本次安装的 StardewAgentBridge，并按需恢复最近的备份。
.DESCRIPTION
    - 默认把当前安装移到备份目录，并恢复最近一次安装前的桥接目录。
    - -RemoveOnly 只停用当前安装；-RestoreLatest 保留为兼容参数。
    - 绝不触碰存档、游戏本体或其他 Mod。
#>
[CmdletBinding()]
param(
    [string]$GamePath,
    [switch]$RestoreLatest,
    [switch]$RemoveOnly,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'mod-install-common.ps1')

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
$target = Assert-SabChild -Path (Join-Path $mods 'StardewAgentBridge') -Root $mods

$running = Get-Process -Name 'StardewModdingAPI', 'Stardew Valley' -ErrorAction SilentlyContinue
if ($running) {
    throw "游戏正在运行（$($running.Name -join ', ')）。请先正常退出游戏再回滚。"
}

$backupRoot = Get-SabBackupRoot -GameRoot $resolved
$statePath = Join-Path $backupRoot 'latest.json'
if (-not (Test-Path -LiteralPath $statePath)) { throw '没有本项目安装记录，拒绝猜测或删除现有目录。' }
$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([IO.Path]::GetFullPath($state.GamePath) -ne [IO.Path]::GetFullPath($resolved)) { throw '备份不属于指定游戏目录。' }
if ($state.Status -eq 'rolled_back') { Write-Host '[rollback-mod] 此次安装已经回退。'; return }
$snapshot = Assert-SabChild -Path $state.Snapshot -Root $backupRoot
foreach ($entry in $state.Previous) {
    if ($entry.Name -in @('.', '..') -or [IO.Path]::GetFileName($entry.Name) -ne $entry.Name) { throw '备份记录中的目录名不合法。' }
    $source = Assert-SabChild -Path (Join-Path $snapshot $entry.Name) -Root $snapshot
    $destination = Assert-SabChild -Path (Join-Path $mods $entry.Name) -Root $mods
    if ((Test-Path -LiteralPath $source) -and (Test-Path -LiteralPath $destination) -and $destination -ne $target) { throw "恢复目标已存在，拒绝覆盖：$destination" }
}
if (Test-Path -LiteralPath $target) {
    $manifest = Get-Content -LiteralPath (Join-Path $target 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.UniqueID -ne 'StardewAgentBridge.Bridge') { throw '当前目录不是本项目 Mod，拒绝移动。' }
    $currentBackup = Assert-SabChild -Path (Join-Path $snapshot ('rollback-current-' + [DateTime]::UtcNow.ToString('HHmmssfff'))) -Root $snapshot
    Move-Item -LiteralPath $target -Destination $currentBackup
}
if (-not $RemoveOnly) { foreach ($entry in $state.Previous) {
    $source = Assert-SabChild -Path (Join-Path $snapshot $entry.Name) -Root $snapshot
    $destination = Assert-SabChild -Path (Join-Path $mods $entry.Name) -Root $mods
    if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination $destination; Write-Host "[rollback-mod] 已恢复：$($entry.Name)" }
} }
$state.Status = 'rolled_back'
Write-SabInstallState -State $state -BackupRoot $backupRoot

Write-Host '[rollback-mod] 完成。游戏存档与游戏本体未被修改。'
