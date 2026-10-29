# Stardew Agent Bridge

**0.2.0-preview.1** includes Windows and Linux x64 packages, a standalone SMAPI Mod, and Docker amd64 images plus the source/Compose toolkit. Download the matching files and checksums from [GitHub Releases](https://github.com/amy2022525-sketch/stardew-agent-bridge/releases).

Docker game mode and MP1 are previews. Native Linux gameplay and two real multiplayer clients still require acceptance; automated/mock checks do not certify those. See [current validation](docs/RELEASE_VALIDATION_20261029.md), [Docker installation](docs/DOCKER_INSTALL.md), [Linux installation](docs/LINUX_INSTALL.md), and [MP1 setup](docs/MULTIPLAYER_INSTALL.md). Windows packages require Node >=22.13; Linux packages bundle Node. Images never include proprietary game files or saves.

Earlier single-player checks are recorded in [FINAL_TEST_REPORT.md](FINAL_TEST_REPORT.md). Those historical checks do not certify the new Linux, Docker or multiplayer paths. Fishing/combat, the full transaction/day-transition matrix, and complete tasks through DSH/Codex/Claude Code remain incomplete. No stable release has been published.

Let any local MCP-capable agent (DSH, Codex CLI, Claude Code, …) observe and play Stardew Valley through a SMAPI mod, a resident local bridge and a web console — one shared game capability set, one shared action ledger.

- MCP is only the transport. No agent-specific plugin, no model-vendor coupling.
- Every write goes through **normal game flow**: there is no teleport, resource-edit or skip-event command anywhere in the code.
- Many clients may read at once; exactly one client may write. The human player can take over at any time (hotkey or web button).

English is a summary; the authoritative documents are Chinese (see [README.md](README.md)).

## Architecture

```
Agent host (DSH / Codex / Claude Code)
   │  standard MCP (Streamable HTTP, or the bundled stdio adapter)
   ▼
Bridge (127.0.0.1:17655)  ← the single business core
   ├── MCP surface: 29 `stardew_*` tools
   ├── Web console: status, timeline, host-config wizard, human takeover
   ├── Action ledger (SQLite): actionId dedup, terminal replay, unresolved actions
   └── Control: control session + lease + single writer
   │  loopback WebSocket (127.0.0.1:17654, Bearer token, protocol `stardew-agent-bridge/1`)
   ▼
SMAPI mod (game main thread)  ← the only executor
```

## Quick start (Windows, single-player)

Prerequisites: Stardew Valley 1.6.15 with SMAPI 4.5.2, Node.js ≥ 22.13.0, .NET SDK 10 (source build and isolated checks; the mod targets net6.0).

```powershell
npm ci
npm run build
$env:STARDEW_GAME_PATH = 'F:\SteamLibrary\steamapps\common\Stardew Valley'
npm run build:mod

npm start                # keeps running; generates local credentials; open http://127.0.0.1:17655/
npm run install:mod      # game must be closed; backs up the previous mod folder
# start the game through SMAPI and load a (test) save
npm run doctor           # expect "Mod 连接=是"
node scripts/smoke.mjs   # real MCP round-trip: tools/list + status + snapshot

node apps/server/dist/cli.js hosts --host codex --transport stdio   # host config snippet
```

In the Web console, select **MCP 连接** (MCP connection), choose DSH, Codex, Claude Code or a generic MCP client, and generate a configuration. Copy or download it, then import it into your agent. Each agent should use a distinct connection name. The panel can test HTTP and stdio by performing a real MCP handshake, discovering 29 tools and calling the read-only `stardew_status` tool. This local check is separate from agent activity: ask your agent to call a tool to see its actual call record in the panel.

### Linux source preview (initial no-game verification completed)

Linux reuses the same business core; only the host integration differs: the package ships its own Node runtime, the data root follows the XDG spec, mod install/rollback are transactional MJS scripts, and the menu entry is a `.desktop` file.

```bash
npm ci && npm run build
GAME="/home/$USER/.local/share/Steam/steamapps/common/Stardew Valley"
npm run build:mod -- --game-path "$GAME"
node apps/server/dist/cli.js start &      # packaged binary: bin/stardew-agent-bridge start
npm run install:mod -- --game-path "$GAME"
npm run doctor
```

See [docs/LINUX_INSTALL.md](docs/LINUX_INSTALL.md), [docs/LINUX_DEVELOPMENT.md](docs/LINUX_DEVELOPMENT.md) and [docs/PLATFORM_MATRIX.md](docs/PLATFORM_MATRIX.md). Initial Ubuntu 24.04 / WSL2 verification passed: 136 Node tests, 20 installer/recovery cases and 19 portable no-game checks. Native Linux gameplay, graphical-browser interaction, real agent tasks and the final full package remain unverified. See [LINUX_VALIDATION_REPORT.md](LINUX_VALIDATION_REPORT.md); this source update is not a stable Linux binary release.

Per-host instructions: [docs/CLIENTS.md](docs/CLIENTS.md). Protocol and error model: [docs/PROTOCOL.md](docs/PROTOCOL.md). Troubleshooting: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Guarantees

| Requirement | Implementation |
| --- | --- |
| All clients read the same world | Reads always come from a live mod snapshot; the bridge never fabricates state |
| One writer at a time | Control session + lease (3 min default) + mod-side control epoch |
| Late requests cannot reclaim control | Every write carries the current epoch; takeover, disconnects and save changes rotate it |
| Consumption actions never double-spend | `actionId` dedup, terminal replay, `unknown` when the result is uncertain (query/observe, never replay) |
| The game can protect itself | 5 s bridge-link loss ⇒ stop action, drop control, try to pause normally; `F9` = emergency stop |
| The human is never fought | Every step *tries* to pause normally; player-opened menus are never closed, events are never skipped |

## Verification status

| Scope | Status |
| --- | --- |
| Contracts, control, ledger dedup, MCP HTTP+stdio, Web MCP, fault injection against a mock mod | **passing**, 51/51 |
| Web MCP panel: configuration, copy/download, real channel checks, client records, responsive layout | **passing**, 11 browser checks; no page errors |
| Portable package outside the repository, including Web HTTP/stdio MCP checks | **passing**, 13 checks |
| Isolated C# source checks / Windows installer checks | **passing**, 17 / 17 respectively |
| Mod compiles against real game DLLs | **passing**, 0 warnings / 0 errors |
| Linux source preview | WSL2 build, 136 Node tests, 20 installer cases and 19 no-game package checks passed; native gameplay and the final full package remain pending |
| Live bridge + web + real MCP self-check | **passing** (including the no-game degradation path) |
| Real-game movement, container transfers and duplicate replay, crafting, placement | **passing for the tested cases**; see [FINAL_TEST_REPORT.md](FINAL_TEST_REPORT.md) |
| Bridge crash while waiting / Web console | Self-release observed / 9 browser checks passed |
| Fishing, combat, remaining transactions, day transition, three real agent hosts | **pending** |

## License

MIT. Migration provenance: [NOTICE.md](NOTICE.md) and [docs/MIGRATION.md](docs/MIGRATION.md). No game assets, saves or credentials are included.
