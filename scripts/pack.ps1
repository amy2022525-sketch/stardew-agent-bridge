<#
.SYNOPSIS
    打包发布目录（本地产物，不上传）。
.DESCRIPTION
    1) 类型检查/构建/测试；2) 构建 Mod；3) 打包 server（单文件）与 stdio 适配器；4) 收集 Web、文档、许可证；
    5) 生成 CHECKSUMS.txt 并做禁止文件审计。
    输出：release/StardewAgentBridge-<版本>/
#>
[CmdletBinding()]
param(
    [string]$GamePath,
    [switch]$SkipTests,
    [switch]$SkipMod
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$version = (node -p "require('./package.json').version" | Select-Object -Last 1).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+([+-][A-Za-z0-9.-]+)?$') { throw '无效的发布版本号。' }
$out = Join-Path $repo "release\StardewAgentBridge-$version"
. (Join-Path $PSScriptRoot 'mod-install-common.ps1')
$out = Assert-SabChild -Path $out -Root (Join-Path $repo 'release')
Write-Host "[pack] 目标目录：$out"

if (-not $SkipTests) {
    Write-Host '[pack] 构建与测试…'
    & node scripts/build.mjs | Out-Host
    if ($LASTEXITCODE -ne 0) { throw '构建失败。' }
    & node scripts/test.mjs | Out-Host
    if ($LASTEXITCODE -ne 0) { throw '测试失败：请修复后再打包。' }
}

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
foreach ($dir in @('server', 'web', 'mod', 'docs')) { New-Item -ItemType Directory -Force -Path (Join-Path $out $dir) | Out-Null }

Write-Host '[pack] 打包 server 与 stdio 适配器（单文件，无 node_modules）…'
$banner = "import { createRequire as __sabCreateRequire } from 'node:module'; const require = __sabCreateRequire(import.meta.url);"
$serverOut = Join-Path $out 'server\bridge.mjs'
$adapterOut = Join-Path $out 'server\stdio-adapter.mjs'
& node node_modules/esbuild/bin/esbuild apps/server/src/cli.ts --bundle --platform=node --format=esm --target=node22 "--outfile=$serverOut" "--banner:js=$banner" --log-level=warning | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'server 打包失败。' }
& node node_modules/esbuild/bin/esbuild adapters/stdio/src/index.ts --bundle --platform=node --format=esm --target=node22 "--outfile=$adapterOut" "--banner:js=$banner" --log-level=warning | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'stdio 适配器打包失败。' }

Write-Host '[pack] 复制 Web 产物…'
Copy-Item (Join-Path $repo 'apps\web\dist\*') (Join-Path $out 'web') -Recurse -Force
# 源码映射只服务于开发调试，不进发布包。
Get-ChildItem (Join-Path $out 'web') -Recurse -Include '*.map' -ErrorAction SilentlyContinue | Remove-Item -Force

if (-not $SkipMod) {
    Write-Host '[pack] 构建 Mod…'
    $modSplat = @{}
    if ($GamePath) { $modSplat['GamePath'] = $GamePath }
    & (Join-Path $PSScriptRoot 'build-mod.ps1') @modSplat | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Mod 构建失败。' }
    Copy-Item (Join-Path $repo 'artifacts\mod\StardewAgentBridge\*') (Join-Path $out 'mod') -Recurse -Force
}

foreach ($doc in @('README.md', 'README.en.md', 'LICENSE', 'NOTICE.md', 'CHANGELOG.md', 'FINAL_TEST_REPORT.md')) {
    $source = Join-Path $repo $doc
    if (Test-Path $source) { Copy-Item $source $out }
}
foreach ($doc in @('ACCEPTANCE.md', 'AGENT_GUIDE.md', 'CLIENTS.md', 'PROTOCOL.md', 'EVIDENCE.md', 'MIGRATION.md', 'TROUBLESHOOTING.md')) {
    $source = Join-Path $repo "docs\$doc"
    if (Test-Path $source) { Copy-Item $source (Join-Path $out 'docs') }
}

@'
启动（Windows，需 Node.js 22.5 或更高版本）：
  node server\bridge.mjs start
然后打开 http://127.0.0.1:17655/ 查看控制台，在“MCP 连接”里生成、复制或下载宿主配置，并检测 HTTP/stdio 通道。

诊断：
  node server\bridge.mjs doctor
安装/回滚 Mod：
  powershell -ExecutionPolicy Bypass -File .\install-mod.ps1 -GamePath "<游戏目录>"
  powershell -ExecutionPolicy Bypass -File .\rollback-mod.ps1 -GamePath "<游戏目录>"
'@ | Set-Content (Join-Path $out '启动说明.txt') -Encoding UTF8

Copy-Item (Join-Path $PSScriptRoot 'install-mod.ps1') $out -ErrorAction SilentlyContinue
Copy-Item (Join-Path $PSScriptRoot 'rollback-mod.ps1') $out -ErrorAction SilentlyContinue
Copy-Item (Join-Path $PSScriptRoot 'mod-install-common.ps1') $out

Write-Host '[pack] 审计：检查是否混入游戏资源、存档或凭据…'
$forbidden = Get-ChildItem $out -Recurse -File | Where-Object {
    $_.Name -in @('Stardew Valley.dll', 'StardewModdingAPI.dll', 'credentials.json', 'ledger.sqlite', 'endpoint.json') -or
    $_.Extension -in @('.save', '.zip', '.pdb') -or
    $_.FullName -match '\\Mods\\' -or
    $_.Name -match '\.bak-'
}
if ($forbidden) {
    $forbidden | Select-Object FullName | Format-Table -AutoSize | Out-Host
    throw '发布目录包含禁止分发的文件，已中止。'
}

Write-Host '[pack] 生成 CHECKSUMS.txt…'
$lines = Get-ChildItem $out -Recurse -File | Sort-Object FullName | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
    $relative = $_.FullName.Substring($out.Length + 1) -replace '\\', '/'
    "$hash  $relative"
}
$lines | Set-Content (Join-Path $out 'CHECKSUMS.txt') -Encoding UTF8

Write-Host '[pack] 仓库外独立启动与 MCP 回环验收…'
& node scripts/verify-package.mjs $out | Out-Host
if ($LASTEXITCODE -ne 0) { throw '发布包无法在仓库外独立运行。' }

Write-Host "[pack] 完成：$out"
$total = (Get-ChildItem $out -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("[pack] 文件数 {0}，合计 {1:N1} MB（压缩包由你手动生成，脚本不自动上传）" -f (Get-ChildItem $out -Recurse -File).Count, ($total / 1MB))
