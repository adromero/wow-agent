local _, WoWAgent = ...
WoWAgent.StateCollector = {}

local SC = WoWAgent.StateCollector

-- The addon runs on several client generations (Classic-style and modern
-- APIs), so every API is looked up defensively and every section is collected
-- inside pcall: one missing function must never break the whole export.

local MAX_QUESTS = 60
local MAX_OBJECTIVES = 12

-- Power type names for readability
local POWER_TYPE_NAMES = {
    [0] = "Mana",
    [1] = "Rage",
    [2] = "Focus",
    [3] = "Energy",
    [4] = "ComboPoints",
    [5] = "Runes",
    [6] = "RunicPower",
    [7] = "SoulShards",
    [8] = "LunarPower",
    [9] = "HolyPower",
}

-- Equipment slots for gear inspection (skip shirt=4, tabard=19)
local GEAR_SLOTS = {
    { 1, "Head" }, { 2, "Neck" }, { 3, "Shoulder" }, { 15, "Back" },
    { 5, "Chest" }, { 9, "Wrist" }, { 10, "Hands" }, { 6, "Waist" },
    { 7, "Legs" }, { 8, "Feet" }, { 11, "Finger1" }, { 12, "Finger2" },
    { 13, "Trinket1" }, { 14, "Trinket2" }, { 16, "MainHand" },
    { 17, "OffHand" }, { 18, "Ranged" },
}

-- Newer clients can return "secret" values that cannot be compared, used in
-- arithmetic or saved. Treat them as missing.
local function IsSecret(v)
    if type(issecretvalue) == "function" then
        local ok, secret = pcall(issecretvalue, v)
        return ok and secret
    end
    return false
end

-- Daily flag: modern clients use Enum.QuestFrequency (1 = daily), older ones use 2.
local function IsDaily(frequency, modern)
    if modern then return frequency == 1 end
    return frequency == 2
end

-- Call fn(...) and return up to 8 results, or nothing if it is missing or errors.
local function Try(fn, ...)
    if type(fn) ~= "function" then return nil end
    local ok, a, b, c, d, e, f, g, h = pcall(fn, ...)
    if ok then return a, b, c, d, e, f, g, h end
    return nil
end

-- Remove secret values and unsupported types from a table before it is saved.
local function Scrub(value, depth)
    depth = depth or 0
    if IsSecret(value) then return nil end
    local t = type(value)
    if t == "table" then
        if depth > 8 then return nil end
        local out = {}
        for k, v in pairs(value) do
            if not IsSecret(k) and (type(k) == "string" or type(k) == "number") then
                out[k] = Scrub(v, depth + 1)
            end
        end
        return out
    elseif t == "string" or t == "number" or t == "boolean" then
        return value
    end
    return nil
end

local function HealthPct(unit)
    local ok, pct = pcall(function()
        local maxHealth = UnitHealthMax(unit)
        if not maxHealth or maxHealth <= 0 then return 0 end
        return math.floor((UnitHealth(unit) / maxHealth) * 100 + 0.5)
    end)
    if ok then return pct end
    return nil
end

local function CollectSpec()
    local spec = {}

    -- Modern specialization API
    if type(GetSpecialization) == "function" and type(GetSpecializationInfo) == "function" then
        local index = Try(GetSpecialization)
        if index then
            local _, name, _, _, role = Try(GetSpecializationInfo, index)
            spec.index = index
            spec.name = name
            spec.role = role
        end
    end

    -- Classic-style talent tabs: report points per tree
    if type(GetNumTalentTabs) == "function" and type(GetTalentTabInfo) == "function" then
        local trees = {}
        local best, bestPoints = nil, -1
        for i = 1, (Try(GetNumTalentTabs) or 0) do
            -- Return order differs between client generations; pick by type.
            local r = { Try(GetTalentTabInfo, i) }
            local name = (type(r[1]) == "string" and r[1]) or (type(r[2]) == "string" and r[2]) or nil
            local points = (type(r[3]) == "number" and r[3]) or (type(r[5]) == "number" and r[5]) or 0
            if name then
                table.insert(trees, { name = name, points = points })
                if points > bestPoints then
                    best, bestPoints = name, points
                end
            end
        end
        if #trees > 0 then
            spec.trees = trees
            if not spec.name and bestPoints > 0 then spec.name = best end
        end
    end

    if type(GetActiveTalentGroup) == "function" then
        spec.active_group = Try(GetActiveTalentGroup)
    end

    return spec
end

function SC.CollectPlayer()
    local name = UnitName("player")
    local _, classFilename = UnitClass("player")
    local powerType, powerToken = UnitPowerType("player")
    local raceName = Try(UnitRace, "player")
    local faction = Try(UnitFactionGroup, "player")
    local spec = CollectSpec()

    local player = {
        name = name,
        realm = Try(GetRealmName),
        level = UnitLevel("player"),
        class = classFilename,
        race = raceName,
        faction = faction,
        spec_index = spec.index or spec.active_group,
        spec_name = spec.name,
        spec_role = spec.role,
        talent_trees = spec.trees,
        health = UnitHealth("player"),
        max_health = UnitHealthMax("player"),
        power = UnitPower("player"),
        max_power = UnitPowerMax("player"),
        power_type = POWER_TYPE_NAMES[powerType] or powerToken or "Unknown",
        xp = Try(UnitXP, "player"),
        xp_max = Try(UnitXPMax, "player"),
        xp_rested = Try(GetXPExhaustion),
        money_copper = Try(GetMoney),
        hearthstone = Try(GetBindLocation),
        is_dead_or_ghost = Try(UnitIsDeadOrGhost, "player") and true or false,
    }

    -- Map position (not available inside instances)
    if C_Map and C_Map.GetBestMapForUnit and C_Map.GetPlayerMapPosition then
        local mapID = Try(C_Map.GetBestMapForUnit, "player")
        if mapID then
            local pos = Try(C_Map.GetPlayerMapPosition, mapID, "player")
            if pos and pos.GetXY then
                local x, y = Try(pos.GetXY, pos)
                if type(x) == "number" and type(y) == "number" and not IsSecret(x) then
                    player.map_id = mapID
                    player.map_x = math.floor(x * 1000 + 0.5) / 10
                    player.map_y = math.floor(y * 1000 + 0.5) / 10
                end
            end
        end
    end

    return player
end

function SC.CollectTarget()
    if not UnitExists("target") then
        return nil
    end

    local name = UnitName("target")
    local _, classFilename = UnitClass("target")
    local isPlayer = UnitIsPlayer("target") and true or false

    return {
        name = name,
        level = UnitLevel("target"),
        classification = UnitClassification("target"),
        creature_type = Try(UnitCreatureType, "target"),
        class = isPlayer and classFilename or nil,
        reaction = Try(UnitReaction, "target", "player"),
        health_pct = HealthPct("target"),
        is_player = isPlayer,
        is_dead = UnitIsDead("target") and true or false,
    }
end

function SC.CollectZone()
    local name, instanceType, difficultyID, difficultyName, maxPlayers = GetInstanceInfo()

    return {
        name = GetZoneText(),
        subzone = GetSubZoneText(),
        instance_name = name,
        instance_type = instanceType,
        difficulty_id = difficultyID,
        difficulty_name = difficultyName,
        max_players = maxPlayers,
    }
end

local function Member(unit)
    local _, class = UnitClass(unit)
    return {
        name = UnitName(unit),
        class = class,
        level = UnitLevel(unit),
        role = Try(UnitGroupRolesAssigned, unit),
        health_pct = HealthPct(unit),
    }
end

function SC.CollectParty()
    local numMembers = GetNumGroupMembers()
    if not numMembers or numMembers == 0 then
        return {}
    end

    local members = {}
    if IsInRaid() then
        -- raid1..raidN already includes the player
        for i = 1, numMembers do
            local unit = "raid" .. i
            if UnitExists(unit) then
                table.insert(members, Member(unit))
            end
        end
    else
        table.insert(members, Member("player"))
        for i = 1, numMembers - 1 do
            local unit = "party" .. i
            if UnitExists(unit) then
                table.insert(members, Member(unit))
            end
        end
    end

    return members
end

local function ItemInfo(link)
    local getInfo = (C_Item and C_Item.GetItemInfo) or GetItemInfo
    local getDetailed = (C_Item and C_Item.GetDetailedItemLevelInfo) or GetDetailedItemLevelInfo
    local name, _, quality, baseIlvl = Try(getInfo, link)
    local effectiveIlvl = Try(getDetailed, link)
    return name, quality, effectiveIlvl or baseIlvl
end

function SC.CollectGear()
    local totalIlvl = 0
    local slotCount = 0
    local items = {}

    for _, slotInfo in ipairs(GEAR_SLOTS) do
        local slot, slotName = slotInfo[1], slotInfo[2]
        local itemLink = Try(GetInventoryItemLink, "player", slot)
        if itemLink then
            local name, quality, ilvl = ItemInfo(itemLink)
            local durability, maxDurability = Try(GetInventoryItemDurability, slot)
            if type(ilvl) == "number" then
                totalIlvl = totalIlvl + ilvl
                slotCount = slotCount + 1
            end
            table.insert(items, {
                slot = slotName,
                name = name or itemLink:match("%[(.-)%]"),
                item_id = tonumber(itemLink:match("item:(%d+)")),
                ilvl = ilvl,
                quality = quality,
                durability = durability,
                max_durability = maxDurability,
            })
        end
    end

    local avgIlvl = 0
    if slotCount > 0 then
        avgIlvl = math.floor(totalIlvl / slotCount + 0.5)
    end

    return {
        avg_ilvl = avgIlvl,
        slot_count = slotCount,
        items = items,
    }
end

function SC.CollectProfessions()
    local list = {}

    -- Modern API
    if type(GetProfessions) == "function" and type(GetProfessionInfo) == "function" then
        local indexes = { Try(GetProfessions) }
        for i = 1, 5 do
            local index = indexes[i]
            if index then
                local name, _, rank, maxRank = Try(GetProfessionInfo, index)
                if name then
                    table.insert(list, { name = name, rank = rank, max_rank = maxRank })
                end
            end
        end
        if #list > 0 then return list end
    end

    -- Classic-style skill lines (headers give the category)
    if type(GetNumSkillLines) == "function" and type(GetSkillLineInfo) == "function" then
        local category = nil
        for i = 1, (Try(GetNumSkillLines) or 0) do
            local name, isHeader, _, rank, _, _, maxRank = Try(GetSkillLineInfo, i)
            if name then
                if isHeader then
                    category = name
                else
                    table.insert(list, {
                        name = name,
                        rank = rank,
                        max_rank = maxRank,
                        category = category,
                    })
                end
            end
        end
    end

    return list
end

function SC.CollectBags()
    local numFree = (C_Container and C_Container.GetContainerNumFreeSlots) or GetContainerNumFreeSlots
    local numSlots = (C_Container and C_Container.GetContainerNumSlots) or GetContainerNumSlots
    local free, total = 0, 0
    for bag = 0, 4 do
        free = free + (Try(numFree, bag) or 0)
        total = total + (Try(numSlots, bag) or 0)
    end
    return { free_slots = free, total_slots = total }
end

local function QuestObjectives(questID, logIndex)
    local objectives = {}

    if questID and C_QuestLog and C_QuestLog.GetQuestObjectives then
        local list = Try(C_QuestLog.GetQuestObjectives, questID)
        if type(list) == "table" then
            for i, o in ipairs(list) do
                if i > MAX_OBJECTIVES then break end
                table.insert(objectives, {
                    text = o.text,
                    done = o.finished and true or false,
                    have = o.numFulfilled,
                    need = o.numRequired,
                })
            end
            return objectives
        end
    end

    if type(GetNumQuestLeaderBoards) == "function" and type(GetQuestLogLeaderBoard) == "function" then
        local count = Try(GetNumQuestLeaderBoards, logIndex) or 0
        for i = 1, math.min(count, MAX_OBJECTIVES) do
            local text, _, finished = Try(GetQuestLogLeaderBoard, i, logIndex)
            if text then
                table.insert(objectives, { text = text, done = finished and true or false })
            end
        end
    end

    return objectives
end

-- Quest log export. Quests under a collapsed header are not reported by the
-- game API; the log is not expanded here to avoid changing the player's UI.
function SC.CollectQuests()
    local quests = {}
    local header = nil

    local modern = C_QuestLog and C_QuestLog.GetInfo and C_QuestLog.GetNumQuestLogEntries
    local numEntries
    if modern then
        numEntries = Try(C_QuestLog.GetNumQuestLogEntries) or 0
    else
        numEntries = Try(GetNumQuestLogEntries) or 0
    end

    for i = 1, numEntries do
        if #quests >= MAX_QUESTS then break end

        local title, level, group, isHeader, isComplete, frequency, questID, hidden

        if modern then
            local info = Try(C_QuestLog.GetInfo, i)
            if type(info) == "table" then
                title = info.title
                level = info.level
                group = info.suggestedGroup
                isHeader = info.isHeader
                frequency = info.frequency
                questID = info.questID
                hidden = info.isHidden
                if questID and not isHeader then
                    if C_QuestLog.IsComplete and Try(C_QuestLog.IsComplete, questID) then
                        isComplete = 1
                    elseif C_QuestLog.IsFailed and Try(C_QuestLog.IsFailed, questID) then
                        isComplete = -1
                    end
                end
            end
        else
            local _
            title, level, group, isHeader, _, isComplete, frequency, questID = Try(GetQuestLogTitle, i)
        end

        if title then
            if isHeader then
                header = title
            elseif not hidden then
                local status = "in_progress"
                if isComplete == 1 or isComplete == true then
                    status = "complete"
                elseif isComplete == -1 then
                    status = "failed"
                end
                table.insert(quests, {
                    id = questID,
                    title = title,
                    level = level,
                    category = header,
                    status = status,
                    suggested_group = (type(group) == "number" and group > 1) and group or nil,
                    is_daily = IsDaily(frequency, modern) or nil,
                    objectives = QuestObjectives(questID, i),
                })
            end
        end
    end

    return quests
end

function SC.CollectClient()
    local version, build, _, interface = Try(GetBuildInfo)
    return {
        version = version,
        build = build,
        interface = interface,
        locale = Try(GetLocale),
    }
end

local SECTIONS = {
    player = SC.CollectPlayer,
    target = SC.CollectTarget,
    zone = SC.CollectZone,
    party = SC.CollectParty,
    gear = SC.CollectGear,
    professions = SC.CollectProfessions,
    bags = SC.CollectBags,
    quests = SC.CollectQuests,
    client = SC.CollectClient,
}

function SC.CollectAll()
    local state = {}
    local errors = {}
    for name, collect in pairs(SECTIONS) do
        local ok, result = pcall(collect)
        if ok then
            state[name] = Scrub(result)
        else
            errors[name] = tostring(result)
        end
    end
    if next(errors) then
        state.errors = errors
    end
    return state
end
