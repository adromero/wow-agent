# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WoW Agent is an AI assistant for World of Warcraft that provides boss strategies, class tips, and game advice with access to live game state. It consists of two components that communicate via SavedVariables files (WoW addons cannot do HTTP or direct file I/O).

## Architecture

```
WoW Addon (Lua)              Electron App (TypeScript)
┌──────────────────┐         ┌─────────────────────────────┐
│ StateCollector   │         │ Main Process                │
│ - Player/target  │ ──────► │ - file-watcher.ts watches   │
│ - Zone/party     │  Saved  │   SavedVariables file       │
│ - Gear state     │  Vars   │ - lua-reader.ts parses Lua  │
│                  │  File   │ - agent.ts runs Claude AI   │
│ Core.lua         │         │ - tools/ for AI game access │
│ - /agent sync    │         ├─────────────────────────────┤
│ - Events         │         │ Renderer Process            │
└──────────────────┘         │ - Chat UI (HTML/JS/CSS)     │
                             │ - IPC to main process       │
                             └─────────────────────────────┘
```

**Sync mechanism**: `/agent sync` in WoW collects state and triggers ReloadUI to flush SavedVariables to disk. The Electron app watches this file and updates the AI's context.

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

```bash
ANTHROPIC_API_KEY="sk-ant-..."           # Required
WOW_WTF_PATH="/path/to/WTF"              # Optional: override SavedVariables path
WOW_AGENT_MODEL="claude-sonnet-4-5-..." # Optional: override AI model
```

## Key Files

**Addon** (`addon/WoWAgent/`):
- `Core.lua` - Slash commands, event handlers, addon lifecycle
- `StateCollector.lua` - WoW API calls to gather player/target/zone/party/gear data
- `WoWAgent.toc` - Multi-version manifest (Interface: 11508, 20505, 50503, 120000)

**App Main Process** (`app/src/main/`):
- `agent.ts` - Claude agent setup with version-specific system prompts
- `file-watcher.ts` - EventEmitter that monitors SavedVariables file changes
- `lua-reader.ts` - Parses WoW SavedVariables Lua tables to JavaScript objects
- `config.ts` - WoW version registry, path resolution for macOS/Windows
- `tools/game-state.ts` - Tool allowing AI to query current game state

**App Renderer** (`app/src/renderer/`):
- Plain HTML/JS/CSS (no framework), communicates via Electron IPC

## Multi-Version Support

The addon works across all WoW versions via a single TOC file. The app's `config.ts` maps version keys to folder paths:

| Version | Interface | Folder |
|---------|-----------|--------|
| retail | 120000 | `_retail_` |
| tbc_anniversary | 20505 | `_classic_` |
| mop_classic | 50503 | `_classic_` |
| classic_era | 11508 | `_classic_era_` |

Each version has its own system prompt in `agent.ts` with expansion-specific context.

## Data Flow

1. Player runs `/agent sync` in WoW
2. Addon collects state via WoW APIs → saves to `WoWAgentDB` SavedVariable → ReloadUI flushes to disk
3. FileWatcher detects change → LuaReader parses file → Agent context updated
4. AI can query game state via `get_game_state` tool

## Addon Installation

```bash
./install.sh              # Auto-detect and symlink to all WoW installs
./install.sh retail       # Specific version
./install.sh "/path/to/AddOns"  # Explicit path
```
