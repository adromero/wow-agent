local ADDON_NAME, WoWAgent = ...

local SC = WoWAgent.StateCollector
local Utils = WoWAgent.Utils

-- Default SavedVariables structure
local DB_DEFAULTS = {
    version = 1,
    last_sync = 0,
    game_state = {},
}

-- Main event frame
local frame = CreateFrame("Frame")

-- Update in-memory game state (does NOT flush to disk)
local function UpdateState()
    if not WoWAgentDB then return end
    WoWAgentDB.game_state = SC.CollectAll()
end

-- Full sync: collect state + ReloadUI to flush SavedVariables to disk
local function DoSync()
    UpdateState()
    WoWAgentDB.last_sync = time()
    print("|cff00ff00[WoW Agent]|r Syncing game state... UI will reload.")
    ReloadUI()
end

-- Slash command handler
local function HandleSlashCommand(msg)
    msg = (msg or ""):lower():trim()

    if msg == "sync" then
        DoSync()
    elseif msg == "ss" then
        Screenshot()
        print("|cff00ff00[WoW Agent]|r Screenshot captured. It will appear in the WoW Agent app.")
    elseif msg == "status" then
        if WoWAgentDB and WoWAgentDB.last_sync > 0 then
            local ago = time() - WoWAgentDB.last_sync
            local minutes = math.floor(ago / 60)
            local seconds = ago % 60
            if minutes > 0 then
                print("|cff00ff00[WoW Agent]|r Last sync: " .. minutes .. "m " .. seconds .. "s ago")
            else
                print("|cff00ff00[WoW Agent]|r Last sync: " .. seconds .. "s ago")
            end
        else
            print("|cff00ff00[WoW Agent]|r No sync recorded yet. Use |cffffff00/agent sync|r to sync.")
        end
    elseif msg == "help" or msg == "" then
        print("|cff00ff00[WoW Agent]|r Commands:")
        print("  |cffffff00/agent sync|r - Collect game state and reload UI to flush to disk")
        print("  |cffffff00/agent ss|r - Take a screenshot and send it to the app")
        print("  |cffffff00/agent status|r - Show last sync time")
        print("  |cffffff00/agent help|r - Show this help message")
    else
        print("|cff00ff00[WoW Agent]|r Unknown command: " .. msg .. ". Try |cffffff00/agent help|r")
    end
end

-- Event handler
frame:SetScript("OnEvent", function(self, event, ...)
    if event == "ADDON_LOADED" then
        local addonName = ...
        if addonName == ADDON_NAME then
            -- Initialize SavedVariables
            WoWAgentDB = WoWAgentDB or {}
            Utils.MergeDefaults(WoWAgentDB, DB_DEFAULTS)

            -- Collect initial state
            UpdateState()

            -- Register gameplay events for in-memory updates
            self:RegisterEvent("PLAYER_TARGET_CHANGED")
            self:RegisterEvent("ZONE_CHANGED_NEW_AREA")
            self:RegisterEvent("GROUP_ROSTER_UPDATE")
            self:RegisterEvent("PLAYER_EQUIPMENT_CHANGED")
            self:RegisterEvent("PLAYER_LOGOUT")

            self:UnregisterEvent("ADDON_LOADED")
            print("|cff00ff00[WoW Agent]|r Loaded. Use |cffffff00/agent sync|r to export game state.")
        end

    elseif event == "PLAYER_LOGOUT" then
        -- Final state update before SavedVariables are written to disk
        UpdateState()
        WoWAgentDB.last_sync = time()

    elseif event == "PLAYER_TARGET_CHANGED"
        or event == "ZONE_CHANGED_NEW_AREA"
        or event == "GROUP_ROSTER_UPDATE"
        or event == "PLAYER_EQUIPMENT_CHANGED"
    then
        UpdateState()
    end
end)

frame:RegisterEvent("ADDON_LOADED")

-- Register slash commands
SLASH_WOWAGENT1 = "/agent"
SLASH_WOWAGENT2 = "/wowagent"
SlashCmdList["WOWAGENT"] = HandleSlashCommand
