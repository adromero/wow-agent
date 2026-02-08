# WoW Agent

AI assistant for World of Warcraft that provides boss strategies, class tips, group composition advice, and more - with access to your live game state.

## Supported Versions

| Version | Interface | WoW Folder |
|---------|-----------|------------|
| Retail | 120000 | `_retail_` |
| TBC Classic Anniversary | 20505 | `_classic_` |
| Mists of Pandaria Classic | 50503 | `_classic_` |
| Classic Era | 11508 | `_classic_era_` |

Switch versions in the app via the settings gear icon in the header. The addon Lua code is identical across all versions - only the TOC interface line differs (it lists all supported versions).

## Architecture

Two components work together:

1. **WoW Addon** (`addon/WoWAgent/`) - Minimal Lua addon that exports game state (player, target, zone, party, gear) to SavedVariables
2. **Electron App** (`app/`) - Desktop chat UI powered by Claude AI via [pi-agent-core](https://github.com/badlogic/pi-mono). Reads game state from SavedVariables, provides an always-on-top chat window

**How sync works**: WoW addons can't do HTTP or file I/O. The only way to get data out is SavedVariables, written to disk on ReloadUI/logout. Run `/agent sync` in-game to flush state, then chat freely in the desktop app (zero reloads for conversation).

## Setup

### Prerequisites

- World of Warcraft (any supported version)
- Node.js 18+
- An Anthropic API key

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

Set your Anthropic API key:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

If WoW isn't installed in a standard location, also set:

```bash
export WOW_WTF_PATH="/path/to/World of Warcraft/_classic_/WTF"
```

### 4. Run

```bash
cd app
npm start
```

## Usage

1. **In WoW**: The addon loads automatically. Use `/agent sync` to export your current game state (this reloads your UI)
2. **In the desktop app**: Ask questions about boss strategies, your class, gear, group composition, etc.
3. **Switch versions**: Click the gear icon in the header to open settings. Select your WoW version from the dropdown. The AI's system prompt and WTF path update automatically.
4. **The AI sees**: Your character (name, class, level, spec), current target, zone/instance, party members, and average item level

Your selected version persists across app restarts (stored in `~/.wow-agent/settings.json`).

### Addon Commands

| Command | Description |
|---------|-------------|
| `/agent sync` | Export game state + reload UI to flush to disk |
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
  Core.lua               # Init, events, slash commands

app/                     # Electron Desktop App
  src/main/              # Main process (Node.js)
    index.ts             # App entry, window creation, IPC, version switching
    agent.ts             # pi-agent setup, version-keyed system prompts
    lua-reader.ts        # SavedVariables Lua parser
    file-watcher.ts      # Watch for SavedVariables changes
    config.ts            # App configuration, WoW version registry
    tools/               # Agent tools
      game-state.ts      # Read game state from SavedVariables
      index.ts           # Tool registry
  src/renderer/          # Renderer (browser context)
    index.html           # Chat UI with settings modal
    app.js               # UI logic, IPC, version selection
    styles.css           # WoW-themed styling
```
