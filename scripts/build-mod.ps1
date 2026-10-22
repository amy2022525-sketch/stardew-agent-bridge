<#
.SYNOPSIS
    构建 SMAPI Mod（Stardew Agent Bridge）。
.DESCRIPTION
    优先使用 -GamePath，其次环境变量 STARDEW_GAME_PATH，最后尝试从 Steam 库配置探测。
    只编译，不安装、不复制游戏 DLL。
#>
[CmdletBinding()]
param(
    [string]$GamePath,
    [ValidateSet('Release', 'Debug')][string]$Configuration = 'Release',
    [switch]$SkipRestore
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repo 'mods\StardewAgentBridge\StardewAgentBridge.csproj'

function Resolve-GamePath {
    param([string]$Explicit)
    if ($Explicit) { return (Resolve-Path $Explicit).Path }
    if ($env:STARDEW_GAME_PATH) { return (Resolve-Path $env:STARDEW_GAME_PATH).Path }
    $candidates = @(
        'C:\Program Files (x86)\Steam\steamapps\common\Stardew Valley',
        'C:\Program Files\Steam\steamapps\common\Stardew Valley'
    )
    $libraryRoots = @()
    $steam = (Get-ItemProperty -Path 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath
    if ($steam) {
        $libraryFile = Join-Path $steam 'steamapps\libraryfolders.vdf'
        if (Test-Path $libraryFile) {
            $libraryRoots = Select-String -Path $libraryFile -Pattern '"path"\s+"(.+?)"' | ForEach-Object {
                $_.Matches[0].Groups[1].Value -replace '\\\\', '\'
            }
        }
    }
    foreach ($root in $libraryRoots) { $candidates += (Join-Path $root 'steamapps\common\Stardew Valley') }
    foreach ($candidate in $candidates) {
        if (Test-Path (Join-Path $candidate 'Stardew Valley.dll')) { return (Resolve-Path $candidate).Path }
    }
    throw '未找到星露谷安装目录。请用 -GamePath 或设置环境变量 STARDEW_GAME_PATH。'
}

$resolved = Resolve-GamePath -Explicit $GamePath
Write-Host "[build-mod] 游戏目录：$resolved"

$gameDll = Join-Path $resolved 'Stardew Valley.dll'
if (-not (Test-Path $gameDll)) { throw "缺少 Stardew Valley.dll：$gameDll" }
$gameVersion = (Get-Item $gameDll).VersionInfo.FileVersion
Write-Host "[build-mod] 游戏 DLL 版本：$gameVersion"

if (-not $SkipRestore) {
    Write-Host '[build-mod] 还原依赖（含 net6.0 目标包）…'
    & dotnet restore $project -s https://api.nuget.org/v3/index.json | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'dotnet restore 失败。' }
}

Write-Host "[build-mod] 编译（$Configuration）…"
& dotnet build $project -c $Configuration -p:GamePath="$resolved" --no-restore | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'dotnet build 失败。' }

$outDir = Join-Path $repo "mods\StardewAgentBridge\bin\$Configuration\net6.0"
$artifact = Join-Path $repo 'artifacts\mod\StardewAgentBridge'
if (Test-Path $artifact) { Remove-Item $artifact -Recurse -Force }
New-Item -ItemType Directory -Force -Path $artifact | Out-Null
Copy-Item (Join-Path $outDir 'StardewAgentBridge.dll') $artifact
Copy-Item (Join-Path $repo 'mods\StardewAgentBridge\manifest.json') $artifact

# 审计：产物里不允许出现游戏 DLL 或存档。
$forbidden = Get-ChildItem $artifact -Recurse -Include 'Stardew Valley.dll', 'StardewModdingAPI.dll', '*.pdb', '*.save' -ErrorAction SilentlyContinue
if ($forbidden) { throw "产物包含禁止分发的文件：$($forbidden.Name -join ', ')" }

Write-Host "[build-mod] 完成：$artifact"
Get-ChildItem $artifact | Select-Object Name, Length | Format-Table -AutoSize | Out-Host
