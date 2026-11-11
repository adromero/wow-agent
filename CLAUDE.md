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
npm test             # Unit tests (node:test) against the compiled output
npm run pack:win     # Unpacked Windows build into release/win-unpacked (works from WSL)
npm run dist         # Package for distribution
```

No hot reload - requires manual rebuild after changes.

## Environment Variables

Loaded via `dotenv` from `app/.env`:

```bash
ANTHROPIC_API_KEY="sk-ant-..."           # Fallback if no provider configured in settings
WOW_WTF_PATH="/path/to/WTF"              # Optional: override SavedVariables path
WOW_AGENT_MODEL="claude-sonnet-5-5"     # Optional: override AI model
```

Provider and model selection are managed in the settings UI and persisted in `~/.wow-agent/settings.json`. API keys and OAuth tokens are stored encrypted in `~/.wow-agent/credentials.enc`.

## Key Files

**Addon** (`addon/WoWAgent/`):
- `Core.lua` - Slash commands (`/agent sync`, `/agent ss`, `status`, `help`), event handlers, addon lifecycle
- `StateCollector.lua` - WoW API calls to gather player/target/zone/party/gear data
- `WoWAgent.toc` - Multi-version manifest (Interface: 11508, 16001, 20505, 50503, 120000)

**App Main Process** (`app/src/main/`):
- `agent.ts` - AI agent setup with multi-provider support, version-specific system prompts, zone auto-lookup
- `file-watcher.ts` - EventEmitter that monitors SavedVariables file changes
- `screenshot-watcher.ts` - EventEmitter that watches WoW Screenshots directory for new images
- `lua-reader.ts` - Parses WoW SavedVariables Lua tables to JavaScript objects
- `config.ts` - WoW version registry, provider registry, path resolution, settings persistence
- `tools/game-state.ts` - Tool allowing AI to query current game state
- `tools/web-fetch.ts` - Tool allowing AI to fetch web pages (primarily Wowhead lookups)
- `tools/wowhead.ts` - Parses the JSON tables and guide markup embedded in Wowhead pages into text (data only, never executed)

**App Renderer** (`app/src/renderer/`):
- Plain HTML/JS/CSS (no framework), communicates via Electron IPC
- Settings panel: AI provider/model selection, API key/OAuth auth, WoW version, addon install
- Screenshot preview bar for attaching captured screenshots to messages

## Security Model (keep it intact)

- The renderer is sandboxed (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`). It has no `require`; it talks to the main process only through `window.wowAgent` from `src/main/preload.cts`. A new IPC channel must be added to the allowlist in the preload and registered with the `handle`/`on` helpers in `index.ts`, which verify the sender.
- The CSP in `index.html` forbids inline scripts and all network access. Do not loosen it; do not add `innerHTML` with unescaped content.
- Secrets never go to the renderer or to `settings.json`. They live in `secure-store.ts` (Electron `safeStorage`, async API).
- `tools/web-fetch.ts` enforces an https-only host allowlist, re-validated on every redirect, plus a private-address check. Tests in `test/web-fetch.test.mjs`.
- File paths never cross IPC: screenshots are referred to by opaque ids resolved in the main process.
- AI access uses `@earendil-works/pi-ai` (`builtinModels()` with our `CredentialStore`); the agent gets `streamFn: models.streamSimple`.

## Dependency notes

- `overrides` in `app/package.json` pins `minimatch` to a patched release for `app-builder-lib` and `@electron/universal` (build tools only), while their older sub-dependencies keep the v3/v5 API they were written for. Re-check with `npm audit` and `npm ls minimatch` when upgrading electron-builder; remove the override once it is no longer needed.

## Multi-Version Support

The addon works across all WoW versions via a single TOC file. The app's `config.ts` maps version keys to folder paths:

| Version | Interface | Folder |
|---------|-----------|--------|
| forever | 16001 | `_forever_` (falls back to `forever`, `_classic_beta_`) |
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
