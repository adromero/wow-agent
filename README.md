# WoW Agent

AI assistant for World of Warcraft that provides boss strategies, class tips, group composition advice, and more - with access to your live game state.

## Supported Versions

| Version | Interface | WoW Folder |
|---------|-----------|------------|
| Retail | 120000 | `_retail_` |
| TBC Classic Anniversary | 20505 | `_anniversary_` |
| Mists of Pandaria Classic | 50503 | `_classic_` |
| Classic Era | 11508 | `_classic_era_` |

Switch versions in the app via the settings gear icon in the header. The addon Lua code is identical across all versions - only the TOC interface line differs (it lists all supported versions).

## Architecture

Two components work together:

1. **WoW Addon** (`addon/WoWAgent/`) - Minimal Lua addon that exports game state (player, target, zone, party, gear) to SavedVariables and captures screenshots
2. **Electron App** (`app/`) - Desktop chat UI powered by AI via [pi-agent-core](https://github.com/badlogic/pi-mono). Reads game state from SavedVariables, watches for screenshots, provides an always-on-top chat window. Supports multiple AI providers (Anthropic, OpenAI, GitHub Copilot) with API key or OAuth authentication.

**How sync works**: WoW addons can't do HTTP or file I/O. The only way to get data out is SavedVariables, written to disk on ReloadUI/logout. Run `/agent sync` in-game to flush state, then chat freely in the desktop app (zero reloads for conversation).

**Screenshots**: Run `/agent ss` in-game to capture a screenshot. The app watches the Screenshots directory and lets you attach the image to your next message for visual context.

## Setup

### Prerequisites

- World of Warcraft (any supported version)
- Node.js 18+
- An AI provider API key or OAuth login (Anthropic, OpenAI, GitHub Copilot)

### 1. Install the WoW Addon

```bash
# Auto-detect all WoW installs and symlink to each
./install.sh

# Install to a specific version only
./install.sh retail
./install.sh tbc
./install.sh mop
./install.sh classic

# Or specify an explicit AddOns path
./install.sh "/path/to/World of Warcraft/_retail_/Interface/AddOns"
```

The addon's TOC file lists all supported interface versions, so the same addon folder works in any WoW version.

### 2. Set up the Electron App

```bash
cd app
npm install
```

### 3. Configure

Configure your AI provider in the app's settings panel (gear icon), or set environment variables in a `.env` file in the `app/` directory:

```bash
ANTHROPIC_API_KEY="sk-ant-..."           # For Anthropic provider
WOW_WTF_PATH="/path/to/WTF"              # Optional: override SavedVariables path
WOW_AGENT_MODEL="claude-sonnet-4-5-..." # Optional: override AI model
```

The settings panel supports API key entry and OAuth login for supported providers. Provider and auth settings persist in `~/.wow-agent/settings.json`.

### 4. Run

```bash
cd app
npm start
```

## Usage

1. **In WoW**: The addon loads automatically. Use `/agent sync` to export your current game state (this reloads your UI)
2. **Screenshots**: Use `/agent ss` to take a screenshot. It appears in the app as a preview you can attach to your next message
3. **In the desktop app**: Ask questions about boss strategies, your class, gear, group composition, etc. The AI can look up zones, bosses, items, and quests on Wowhead automatically
4. **Zone auto-lookup**: When you sync after changing zones, the AI automatically looks up the new zone on Wowhead and provides a summary
5. **Switch versions**: Click the gear icon in the header to open settings. Select your WoW version from the dropdown
6. **Install addon**: The settings panel can detect and install the WoW addon directly (no need to run `install.sh` manually)
7. **The AI sees**: Your character (name, class, level, spec), current target, zone/instance, party members, and average item level

Settings (version, provider, auth) persist across app restarts in `~/.wow-agent/settings.json`.

### Addon Commands

| Command | Description |
|---------|-------------|
| `/agent sync` | Export game state + reload UI to flush to disk |
| `/agent ss` | Take a screenshot and send it to the app |
| `/agent status` | Show when you last synced |
| `/agent help` | Show available commands |

## Development

```bash
cd app

# Build and run
npm run dev

# Build only
npm run build

# Package for distribution
npm run dist
```

### Project Structure

```
addon/WoWAgent/          # WoW Addon (Lua)
  WoWAgent.toc           # Manifest (multi-version: 11508, 20505, 50503, 120000)
  Utils.lua              # DeepCopy, MergeDefaults helpers
  StateCollector.lua     # Game state collection via WoW APIs
  Core.lua               # Init, events, slash commands (/agent sync, ss, status, help)

app/                     # Electron Desktop App (ESM)
  src/main/              # Main process (Node.js)
    index.ts             # App entry, window creation, IPC, provider/addon management
    agent.ts             # AI agent setup, multi-provider support, zone auto-lookup
    lua-reader.ts        # SavedVariables Lua parser
    file-watcher.ts      # Watch for SavedVariables changes
    screenshot-watcher.ts # Watch for new screenshots in WoW Screenshots dir
    config.ts            # App configuration, WoW version registry, provider registry
    tools/               # Agent tools
      game-state.ts      # Read game state from SavedVariables
      web-fetch.ts       # Fetch web pages (Wowhead lookups)
      index.ts           # Tool registry
  src/renderer/          # Renderer (browser context)
    index.html           # Chat UI with settings (provider, auth, addon install)
    app.js               # UI logic, IPC, provider/OAuth/screenshot handling
    styles.css           # WoW-themed styling

.github/workflows/       # CI/CD
  build.yml              # Build & release on tag push (macOS + Windows)
```
