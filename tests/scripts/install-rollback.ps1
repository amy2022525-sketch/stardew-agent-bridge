# 此测试只操作随机创建的临时假游戏目录，不需要游戏或真实 DLL。
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('sab-install-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$passed = 0
function Check([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:passed++
    Write-Host "PASS $Message"
}
try {
    foreach ($mode in @('source', 'portable')) {
        $root = Join-Path $fixture ($mode + ' 中文 空格')
        $scriptDir = if ($mode -eq 'source') { Join-Path $root 'scripts' } else { $root }
        $modArtifact = if ($mode -eq 'source') { Join-Path $root 'artifacts\mod\StardewAgentBridge' } else { Join-Path $root 'mod' }
        $game = Join-Path $root 'fake-game'
        $mods = Join-Path $game 'Mods'
        foreach ($dir in @($scriptDir, $modArtifact, (Join-Path $mods 'AgentStardew'), (Join-Path $mods 'OtherMod'))) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        foreach ($file in @('install-mod.ps1', 'rollback-mod.ps1', 'mod-install-common.ps1')) {
            Copy-Item -LiteralPath (Join-Path $repo ('scripts\' + $file)) -Destination (Join-Path $scriptDir $file)
        }
        [IO.File]::WriteAllText((Join-Path $modArtifact 'manifest.json'), '{"UniqueID":"StardewAgentBridge.Bridge","Version":"0.1.0","Description":"通过本机协议提供游戏观察与正常操作能力。"}', (New-Object Text.UTF8Encoding $false))
        'test fixture, not a real assembly' | Set-Content -LiteralPath (Join-Path $modArtifact 'StardewAgentBridge.dll')
        '{"UniqueID":"AgentStardew.Bridge"}' | Set-Content -LiteralPath (Join-Path $mods 'AgentStardew\manifest.json')
        'original-old-mod' | Set-Content -LiteralPath (Join-Path $mods 'AgentStardew\marker.txt')
        '{"UniqueID":"Other.Mod"}' | Set-Content -LiteralPath (Join-Path $mods 'OtherMod\manifest.json')
        'other-mod-must-stay' | Set-Content -LiteralPath (Join-Path $mods 'OtherMod\marker.txt')
        & (Join-Path $scriptDir 'install-mod.ps1') -GamePath $game
        Check (Test-Path -LiteralPath (Join-Path $mods 'StardewAgentBridge\StardewAgentBridge.dll')) "$mode 安装找到正确的产物目录"
        Check (-not (Test-Path -LiteralPath (Join-Path $mods 'AgentStardew'))) "$mode 旧桥接停用，避免双 Mod 端口冲突"
        $state = Get-Content -LiteralPath (Join-Path $game '.stardew-agent-bridge-backups\latest.json') -Raw | ConvertFrom-Json
        Check ($state.Snapshot.StartsWith((Join-Path $game '.stardew-agent-bridge-backups')) -and -not $state.Snapshot.StartsWith($mods)) "$mode 备份在 Mods 外"
        & (Join-Path $scriptDir 'rollback-mod.ps1') -GamePath $game
        Check ((Get-Content -LiteralPath (Join-Path $mods 'AgentStardew\marker.txt') -Raw).Trim() -eq 'original-old-mod') "$mode 默认回退恢复旧桥接"
        Check ((Get-Content -LiteralPath (Join-Path $mods 'OtherMod\marker.txt') -Raw).Trim() -eq 'other-mod-must-stay') "$mode 不改变其他 Mod"
        Check (-not (Test-Path -LiteralPath (Join-Path $mods 'StardewAgentBridge'))) "$mode 回退后新桥接只保留在备份中"
        & (Join-Path $scriptDir 'install-mod.ps1') -GamePath $game
        '{"Port":17699}' | Set-Content -LiteralPath (Join-Path $mods 'StardewAgentBridge\config.json')
        & (Join-Path $scriptDir 'install-mod.ps1') -GamePath $game
        $config = Get-Content -LiteralPath (Join-Path $mods 'StardewAgentBridge\config.json') -Raw | ConvertFrom-Json
        Check ($config.Port -eq 17699) "$mode 升级保留已有配置"
        & (Join-Path $scriptDir 'rollback-mod.ps1') -GamePath $game
        $config = Get-Content -LiteralPath (Join-Path $mods 'StardewAgentBridge\config.json') -Raw | ConvertFrom-Json
        Check ($config.Port -eq 17699) "$mode 回退恢复升级前配置"
    }
    . (Join-Path $repo 'scripts\mod-install-common.ps1')
    $rejected = $false
    try { Assert-SabChild -Path (Join-Path $fixture '..\outside') -Root $fixture | Out-Null } catch { $rejected = $true }
    Check $rejected '路径逃逸在文件移动前被拒绝'
    Write-Host "$passed installer checks passed (temporary fixtures only)."
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^sab-install-test-[0-9a-f]{32}$') {
        throw '临时目录未通过清理核对。'
    }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
