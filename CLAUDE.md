# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WoW Agent is an AI assistant for World of Warcraft that provides boss strategies, class tips, and game advice with access to live game state. It consists of two components that communicate via SavedVariables files (WoW addons cannot do HTTP or direct file I/O).

## Architecture

```
WoW Addon (Lua)              Electron App (TypeScript, ESM)
┌──────────────────┐         ┌─────────────────────────────┐
│ StateCollector   │         │ Main Process                │
│ - Player/target  │ ──────► │ - file-watcher.ts watches   │
│ - Zone/party     │  Saved  │   SavedVariables file       │
│ - Gear state     │  Vars   │ - screenshot-watcher.ts     │
│                  │  File   │   watches Screenshots dir   │
│ Core.lua         │         │ - lua-reader.ts parses Lua  │
│ - /agent sync    │  Screen │ - agent.ts runs AI agent    │
│ - /agent ss      │  shots  │ - tools/ (game-state,       │
│ - Events         │ ──────► │   web-fetch for Wowhead)    │
└──────────────────┘         ├─────────────────────────────┤
                             │ Renderer Process            │
                             │ - Chat UI (HTML/JS/CSS)     │
                             │ - Settings (provider, auth, │
                             │   addon install)            │
                             │ - IPC to main process       │
                             └─────────────────────────────┘
```

**Sync mechanism**: `/agent sync` in WoW collects state and triggers ReloadUI to flush SavedVariables to disk. The Electron app watches this file and updates the AI's context. Zone changes trigger automatic Wowhead lookups.

**Screenshots**: `/agent ss` captures a screenshot. The app's `ScreenshotWatcher` detects new files in the WoW Screenshots directory and surfaces them in the UI as attachable images.

## Build Commands

From the `app/` directory:

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript + copy renderer files
npm run dev          # Build and launch Electron
npm run dist         # Package for distribution
```

No hot reload - requires manual rebuild after changes.

## Environment Variables

Loaded via `dotenv` from `app/.env`:

```bash
ANTHROPIC_API_KEY="sk-ant-..."           # Fallback if no provider configured in settings
WOW_WTF_PATH="/path/to/WTF"              # Optional: override SavedVariables path
WOW_AGENT_MODEL="claude-sonnet-4-5-..." # Optional: override AI model
```

Provider config (API keys, OAuth tokens, model selection) is managed in the settings UI and persisted in `~/.wow-agent/settings.json`.

## Key Files

**Addon** (`addon/WoWAgent/`):
- `Core.lua` - Slash commands (`/agent sync`, `/agent ss`, `status`, `help`), event handlers, addon lifecycle
- `StateCollector.lua` - WoW API calls to gather player/target/zone/party/gear data
- `WoWAgent.toc` - Multi-version manifest (Interface: 11508, 20505, 50503, 120000)

**App Main Process** (`app/src/main/`):
- `agent.ts` - AI agent setup with multi-provider support, version-specific system prompts, zone auto-lookup
- `file-watcher.ts` - EventEmitter that monitors SavedVariables file changes
- `screenshot-watcher.ts` - EventEmitter that watches WoW Screenshots directory for new images
- `lua-reader.ts` - Parses WoW SavedVariables Lua tables to JavaScript objects
- `config.ts` - WoW version registry, provider registry, path resolution, settings persistence
- `tools/game-state.ts` - Tool allowing AI to query current game state
- `tools/web-fetch.ts` - Tool allowing AI to fetch web pages (primarily Wowhead lookups)

**App Renderer** (`app/src/renderer/`):
- Plain HTML/JS/CSS (no framework), communicates via Electron IPC
- Settings panel: AI provider/model selection, API key/OAuth auth, WoW version, addon install
- Screenshot preview bar for attaching captured screenshots to messages

## Multi-Version Support

The addon works across all WoW versions via a single TOC file. The app's `config.ts` maps version keys to folder paths:

| Version | Interface | Folder |
|---------|-----------|--------|
| retail | 120000 | `_retail_` |
| tbc_anniversary | 20505 | `_anniversary_` |
| mop_classic | 50503 | `_classic_` |
| classic_era | 11508 | `_classic_era_` |

Each version has its own system prompt in `agent.ts` with expansion-specific context and a version-specific Wowhead base URL for lookups.

## Data Flow

1. Player runs `/agent sync` in WoW
2. Addon collects state via WoW APIs → saves to `WoWAgentDB` SavedVariable → ReloadUI flushes to disk
3. FileWatcher detects change → LuaReader parses file → Agent context updated
4. If zone changed, agent auto-prompts a Wowhead lookup via `web_fetch` tool
5. AI can query game state via `get_game_state` tool and look up game info via `web_fetch`

## Screenshots

1. Player runs `/agent ss` in WoW → WoW saves screenshot to `Screenshots/` directory
2. ScreenshotWatcher detects new image → sends to renderer via IPC
3. Preview appears in chat input area; user can attach it to their next message
4. Image is sent to AI as base64-encoded content alongside the text message

## Addon Installation

Via the app settings panel (recommended), or manually:

```bash
./install.sh              # Auto-detect and symlink to all WoW installs
./install.sh retail       # Specific version
./install.sh "/path/to/AddOns"  # Explicit path
```

## CI/CD

GitHub Actions workflow (`.github/workflows/build.yml`) builds and releases on tag push (`v*`). Builds for macOS (DMG/ZIP) and Windows (NSIS installer) using electron-builder.
