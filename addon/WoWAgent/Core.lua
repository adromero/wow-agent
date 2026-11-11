local ADDON_NAME, WoWAgent = ...

local SC = WoWAgent.StateCollector
local Utils = WoWAgent.Utils

local PREFIX = "|cff00ff00[WoW Agent]|r "

-- Default SavedVariables structure
local DB_DEFAULTS = {
    version = 2,
    last_sync = 0,
    game_state = {},
    button = { shown = true },
}

-- Main event frame
local frame = CreateFrame("Frame")
local syncButton

-- Update in-memory game state (does NOT flush to disk)
local function UpdateState()
    if not WoWAgentDB then return end
    local ok, state = pcall(SC.CollectAll)
    if ok then
        WoWAgentDB.game_state = state
    end
end

-- Full sync: collect state + ReloadUI to flush SavedVariables to disk
local function DoSync()
    if not WoWAgentDB then return end
    UpdateState()
    WoWAgentDB.last_sync = time()
    print(PREFIX .. "Syncing game state... UI will reload.")
    ReloadUI()
end

local function TakeScreenshot()
    Screenshot()
    print(PREFIX .. "Screenshot captured. It will appear in the WoW Agent app.")
end

-- Small movable on-screen button: left-click syncs, right-click screenshots, drag moves.
local function CreateSyncButton()
    if syncButton then return syncButton end

    local b = CreateFrame("Button", "WoWAgentSyncButton", UIParent, "UIPanelButtonTemplate")
    b:SetSize(96, 24)
    b:SetText("Agent Sync")
    b:SetMovable(true)
    b:SetClampedToScreen(true)
    b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
    b:RegisterForDrag("LeftButton")

    local saved = WoWAgentDB.button
    if saved and saved.point and saved.x and saved.y then
        b:SetPoint(saved.point, UIParent, saved.point, saved.x, saved.y)
    else
        b:SetPoint("TOP", UIParent, "TOP", 0, -120)
    end

    b:SetScript("OnDragStart", function(self) self:StartMoving() end)
    b:SetScript("OnDragStop", function(self)
        self:StopMovingOrSizing()
        local point, _, _, x, y = self:GetPoint(1)
        WoWAgentDB.button.point = point
        WoWAgentDB.button.x = x
        WoWAgentDB.button.y = y
    end)
    b:SetScript("OnClick", function(_, mouseButton)
        if mouseButton == "RightButton" then
            TakeScreenshot()
        else
            DoSync()
        end
    end)
    b:SetScript("OnEnter", function(self)
        GameTooltip:SetOwner(self, "ANCHOR_BOTTOM")
        GameTooltip:AddLine("WoW Agent")
        GameTooltip:AddLine("Left-click: sync game state (reloads UI)", 1, 1, 1)
        GameTooltip:AddLine("Right-click: screenshot for the app", 1, 1, 1)
        GameTooltip:AddLine("Drag to move. /agent button hides it.", 0.7, 0.7, 0.7)
        GameTooltip:Show()
    end)
    b:SetScript("OnLeave", function() GameTooltip:Hide() end)

    syncButton = b
    return b
end

local function ApplyButtonVisibility()
    if WoWAgentDB.button.shown then
        CreateSyncButton():Show()
    elseif syncButton then
        syncButton:Hide()
    end
end

-- Slash command handler
local function HandleSlashCommand(msg)
    msg = strtrim((msg or ""):lower())

    if msg == "sync" then
        DoSync()
    elseif msg == "ss" then
        TakeScreenshot()
    elseif msg == "button" then
        WoWAgentDB.button.shown = not WoWAgentDB.button.shown
        ApplyButtonVisibility()
        print(PREFIX .. "Sync button " .. (WoWAgentDB.button.shown and "shown" or "hidden") .. ".")
    elseif msg == "button reset" then
        WoWAgentDB.button = { shown = true }
        if syncButton then
            syncButton:ClearAllPoints()
            syncButton:SetPoint("TOP", UIParent, "TOP", 0, -120)
        end
        ApplyButtonVisibility()
        print(PREFIX .. "Sync button position reset.")
    elseif msg == "status" then
        if WoWAgentDB and WoWAgentDB.last_sync > 0 then
            local ago = time() - WoWAgentDB.last_sync
            local minutes = math.floor(ago / 60)
            local seconds = ago % 60
            if minutes > 0 then
                print(PREFIX .. "Last sync: " .. minutes .. "m " .. seconds .. "s ago")
            else
                print(PREFIX .. "Last sync: " .. seconds .. "s ago")
            end
        else
            print(PREFIX .. "No sync recorded yet. Use |cffffff00/agent sync|r to sync.")
        end
        local errors = WoWAgentDB and WoWAgentDB.game_state and WoWAgentDB.game_state.errors
        if errors then
            for section, err in pairs(errors) do
                print(PREFIX .. "Could not collect " .. section .. ": " .. tostring(err))
            end
        end
    elseif msg == "help" or msg == "" then
        print(PREFIX .. "Commands:")
        print("  |cffffff00/agent sync|r - Collect game state and reload UI to flush to disk")
        print("  |cffffff00/agent ss|r - Take a screenshot and send it to the app")
        print("  |cffffff00/agent button|r - Show or hide the on-screen sync button")
        print("  |cffffff00/agent button reset|r - Put the sync button back at its default position")
        print("  |cffffff00/agent status|r - Show last sync time and any collection errors")
        print("  |cffffff00/agent help|r - Show this help message")
    else
        print(PREFIX .. "Unknown command: " .. msg .. ". Try |cffffff00/agent help|r")
    end
end

local UPDATE_EVENTS = {
    "PLAYER_TARGET_CHANGED",
    "ZONE_CHANGED_NEW_AREA",
    "GROUP_ROSTER_UPDATE",
    "PLAYER_EQUIPMENT_CHANGED",
    "QUEST_LOG_UPDATE",
}

local pendingUpdate = false

-- Coalesce bursts of events (QUEST_LOG_UPDATE fires often) into one collection.
local function ScheduleUpdate()
    if pendingUpdate then return end
    if C_Timer and C_Timer.After then
        pendingUpdate = true
        C_Timer.After(2, function()
            pendingUpdate = false
            UpdateState()
        end)
    else
        UpdateState()
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
            WoWAgentDB.version = DB_DEFAULTS.version

            -- Register gameplay events for in-memory updates. Some events do
            -- not exist on every client, so register each one defensively.
            for _, name in ipairs(UPDATE_EVENTS) do
                pcall(self.RegisterEvent, self, name)
            end
            self:RegisterEvent("PLAYER_LOGIN")
            self:RegisterEvent("PLAYER_LOGOUT")

            self:UnregisterEvent("ADDON_LOADED")
        end

    elseif event == "PLAYER_LOGIN" then
        -- Unit and quest data are only reliable from PLAYER_LOGIN onwards
        UpdateState()
        pcall(ApplyButtonVisibility)
        print(PREFIX .. "Loaded. Click the Agent Sync button or use |cffffff00/agent sync|r to export game state.")

    elseif event == "PLAYER_LOGOUT" then
        -- Final state update before SavedVariables are written to disk
        UpdateState()
        WoWAgentDB.last_sync = time()

    else
        ScheduleUpdate()
    end
end)

frame:RegisterEvent("ADDON_LOADED")

-- Register slash commands
SLASH_WOWAGENT1 = "/agent"
SLASH_WOWAGENT2 = "/wowagent"
SlashCmdList["WOWAGENT"] = HandleSlashCommand
