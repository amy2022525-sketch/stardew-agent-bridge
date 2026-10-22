# 安装、回退共用的路径核对；备份位于游戏根目录下，始终在 Mods 之外。
function Assert-SabChild {
    param([string]$Path, [string]$Root)
    $absolute = [IO.Path]::GetFullPath($Path)
    $boundary = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $absolute.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) { throw "目标不在允许目录内：$absolute" }
    if ((Test-Path -LiteralPath $absolute) -and ((Get-Item -LiteralPath $absolute -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "不操作符号链接或目录联接：$absolute"
    }
    return $absolute
}

function Write-SabInstallState {
    param($State, [string]$BackupRoot)
    $statePath = Join-Path $BackupRoot 'latest.json'
    $State | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Get-SabBackupRoot {
    param([string]$GameRoot)
    return Assert-SabChild -Path (Join-Path $GameRoot '.stardew-agent-bridge-backups') -Root $GameRoot
}
