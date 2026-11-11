# WoW Agent

AI assistant for World of Warcraft that provides boss strategies, class tips, group composition advice, and more - with access to your live game state.

> **This is a hardened fork** of [Oighty/wow-agent](https://github.com/Oighty/wow-agent). It adds WoW Forever support, a quest-log export, richer game state, refresh/sync buttons, and the security changes listed under [Security](#security). The upstream project has no license file, so no redistribution rights are granted beyond GitHub's fork terms.

## Supported Versions

| Version | Interface | WoW Folder |
|---------|-----------|------------|
| WoW Forever | 16001 | `_forever_` (falls back to `forever`, `_classic_beta_`) |
| Retail | 120000 | `_retail_` |
| TBC Classic Anniversary | 20505 | `_anniversary_` |
| Mists of Pandaria Classic | 50503 | `_classic_` |
| Classic Era | 11508 | `_classic_era_` |

Switch versions in the app via the settings gear icon in the header. The addon Lua code is identical across all versions - only the TOC interface line differs (it lists all supported versions).

## Architecture

Two components work together:

1. **WoW Addon** (`addon/WoWAgent/`) - Minimal Lua addon that exports game state (player, target, zone, party, gear) to SavedVariables and captures screenshots
2. **Electron App** (`app/`) - Desktop chat UI powered by AI via [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core). Reads game state from SavedVariables, watches for screenshots, provides an always-on-top chat window. Supports multiple AI providers (Anthropic, OpenAI, GitHub Copilot) with API key or OAuth authentication.

**How sync works**: WoW addons can't do HTTP or file I/O. The only way to get data out is SavedVariables, written to disk on ReloadUI/logout. Run `/agent sync` in-game to flush state, then chat freely in the desktop app (zero reloads for conversation).

**Screenshots**: Run `/agent ss` in-game to capture a screenshot. The app watches the Screenshots directory and lets you attach the image to your next message for visual context.

## Setup

### Prerequisites

- World of Warcraft (any supported version)
- Node.js 22+
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
WOW_AGENT_MODEL="claude-sonnet-5-5"     # Optional: override AI model
```

The settings panel supports API key entry and OAuth login for supported providers. Provider and model selection persist in `~/.wow-agent/settings.json`; keys and tokens go to the encrypted `~/.wow-agent/credentials.enc`. If WoW is not in a standard location, pick its folder in the settings panel (WoW Folder > Browse).

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

### Buttons

- **In-game "Agent Sync" button**: left-click syncs (same as `/agent sync`, reloads the UI), right-click takes a screenshot for the app, drag to move it. `/agent button` hides or shows it.
- **Refresh button in the app header**: re-reads the game state from disk on demand, for example after the app was started later than WoW or after you changed the WoW folder.

### What the AI can see

Character (class, race, spec, talent points per tree, XP, money, hearthstone), target, zone and map coordinates, party, gear in every slot (item, item level, quality, durability), professions and skills, free bag slots, and the quest log (title, level, status, objectives and progress). Quests under a collapsed category in the in-game quest log are not exported.

### Addon Commands

| Command | Description |
|---------|-------------|
| `/agent sync` | Export game state + reload UI to flush to disk |
| `/agent ss` | Take a screenshot and send it to the app |
| `/agent button` | Show or hide the on-screen sync button (`/agent button reset` restores its position) |
| `/agent status` | Show when you last synced, and any section the addon failed to collect |
| `/agent help` | Show available commands |

## Security

- **Sandboxed window.** The chat window runs with `contextIsolation`, `sandbox` and no Node integration. It can only call a fixed list of IPC channels through `src/main/preload.cts`, the page's Content-Security-Policy allows no inline scripts and no network access, navigation and new windows are blocked, and the main process ignores IPC that does not come from its own page.
- **Encrypted credentials.** API keys and login tokens are stored in `~/.wow-agent/credentials.enc`, encrypted with the operating system's user-bound encryption (DPAPI on Windows, Keychain on macOS, the desktop keyring on Linux). If that is unavailable, credentials are kept in memory for the session and never written in plain text. Keys left in `settings.json` by older versions are moved on first start.
- **Restricted `web_fetch`.** The AI can only fetch `https` pages on `wowhead.com`, `warcraft.wiki.gg`, `icy-veins.com` and `worldofwarcraft.blizzard.com` (and their subdomains). Every redirect hop is re-checked, hosts must resolve to public addresses (no localhost, LAN or tailnet), and responses are size-capped. To allow another site, add it to `extraAllowedHosts` in `~/.wow-agent/settings.json`.
- **Wowhead pages are read as data.** Wowhead builds its search results, zone tables and guide bodies in the browser from JSON inside the page. `tools/wowhead.ts` parses that JSON (it is never executed) into plain text so the AI sees the results, levels, links and guide text. Wowhead refuses its individual WoW Forever database pages (`zone=`, `quest=`, `item=`, `npc=`) to automated readers with HTTP 403; the app does not try to get around that, and the AI is told to use search tables, guides, or the Classic Era page as a labelled approximation.
- **Screenshots only.** The window refers to screenshots by an opaque id; the main process only reads image files that its own watcher found in the WoW `Screenshots` folder.
- **Build it yourself.** Releases are not code-signed. `npm run pack:win` builds an unpacked Windows app into `app/release/win-unpacked` (this also works from WSL or Linux).
- **Subscription logins.** The app still offers OAuth logins for some providers. Check the provider's terms before using a consumer subscription in a third-party app; an API key is the safe choice.

Known limits: a page on an allowed site can still contain text that tries to steer the AI (the system prompt tells it to treat pages as reference only), and the DNS check runs just before the request rather than being pinned to the connection.

## Development

```bash
cd app

# Build and run
npm run dev

# Build only
npm run build

# Run the tests (URL allowlist, Wowhead extraction, SavedVariables parser, game-state output)
npm test

# Unpacked Windows build (works from WSL/Linux too)
npm run pack:win

# Package installers for distribution
npm run dist
```

Manual smoke tests that start the real app: `npx electron test/smoke-main.mjs` (isolation checks) and `test/smoke-full.mjs` with a fixture from `test/make-fixture.mjs` (fake WoW folder, end to end).

### Project Structure

```
addon/WoWAgent/          # WoW Addon (Lua)
  WoWAgent.toc           # Manifest (multi-version: 11508, 16001, 20505, 50503, 120000)
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
    secure-store.ts      # Encrypted credential store (safeStorage)
    preload.cts          # The only bridge between the sandboxed window and the main process
    tools/               # Agent tools
      game-state.ts      # Read game state from SavedVariables
      web-fetch.ts       # Fetch web pages (Wowhead lookups), allowlist and redirect checks
      wowhead.ts         # Turn Wowhead's embedded tables and guide markup into text
      index.ts           # Tool registry
  src/renderer/          # Renderer (browser context)
    index.html           # Chat UI with settings (provider, auth, addon install)
    app.js               # UI logic, IPC, provider/OAuth/screenshot handling
    styles.css           # WoW-themed styling

.github/workflows/       # CI/CD
  build.yml              # Build & release on tag push (macOS + Windows)
```
