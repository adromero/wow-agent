local _, WoWAgent = ...
WoWAgent.StateCollector = {}

local SC = WoWAgent.StateCollector

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

-- Equipment slot IDs for gear inspection (skip shirt=4, tabard=19)
local GEAR_SLOTS = { 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18 }

function SC.CollectPlayer()
    local name, realm = UnitName("player")
    local _, classFilename = UnitClass("player")
    local level = UnitLevel("player")
    local specIndex = GetActiveTalentGroup()
    local powerType, powerToken = UnitPowerType("player")

    return {
        name = name,
        realm = realm,
        level = level,
        class = classFilename,
        spec_index = specIndex,
        health = UnitHealth("player"),
        max_health = UnitHealthMax("player"),
        power = UnitPower("player"),
        max_power = UnitPowerMax("player"),
        power_type = POWER_TYPE_NAMES[powerType] or powerToken or "Unknown",
    }
end

function SC.CollectTarget()
    if not UnitExists("target") then
        return nil
    end

    local name, realm = UnitName("target")
    local level = UnitLevel("target")
    local maxHealth = UnitHealthMax("target")
    local healthPct = 0
    if maxHealth > 0 then
        healthPct = math.floor((UnitHealth("target") / maxHealth) * 100 + 0.5)
    end

    return {
        name = name,
        realm = realm,
        level = level,
        classification = UnitClassification("target"),
        creature_type = UnitCreatureType("target"),
        health_pct = healthPct,
        is_player = UnitIsPlayer("target"),
        is_dead = UnitIsDead("target"),
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

function SC.CollectParty()
    local numMembers = GetNumGroupMembers()
    if numMembers == 0 then
        return {}
    end

    local members = {}
    local isRaid = IsInRaid()
    local prefix = isRaid and "raid" or "party"
    local count = isRaid and numMembers or (numMembers - 1)

    -- Add self
    local _, playerClass = UnitClass("player")
    local playerMaxHP = UnitHealthMax("player")
    local playerHPPct = 0
    if playerMaxHP > 0 then
        playerHPPct = math.floor((UnitHealth("player") / playerMaxHP) * 100 + 0.5)
    end
    table.insert(members, {
        name = UnitName("player"),
        class = playerClass,
        level = UnitLevel("player"),
        role = UnitGroupRolesAssigned("player"),
        health_pct = playerHPPct,
    })

    -- Add group members
    for i = 1, count do
        local unit = prefix .. i
        if UnitExists(unit) then
            local memberName = UnitName(unit)
            local _, memberClass = UnitClass(unit)
            local memberMaxHP = UnitHealthMax(unit)
            local memberHPPct = 0
            if memberMaxHP > 0 then
                memberHPPct = math.floor((UnitHealth(unit) / memberMaxHP) * 100 + 0.5)
            end
            table.insert(members, {
                name = memberName,
                class = memberClass,
                level = UnitLevel(unit),
                role = UnitGroupRolesAssigned(unit),
                health_pct = memberHPPct,
            })
        end
    end

    return members
end

function SC.CollectGear()
    local totalIlvl = 0
    local slotCount = 0

    for _, slot in ipairs(GEAR_SLOTS) do
        local itemLink = GetInventoryItemLink("player", slot)
        if itemLink then
            local effectiveIlvl = GetDetailedItemLevelInfo(itemLink)
            if effectiveIlvl then
                totalIlvl = totalIlvl + effectiveIlvl
                slotCount = slotCount + 1
            end
        end
    end

    local avgIlvl = 0
    if slotCount > 0 then
        avgIlvl = math.floor(totalIlvl / slotCount + 0.5)
    end

    return {
        avg_ilvl = avgIlvl,
        slot_count = slotCount,
    }
end

function SC.CollectAll()
    return {
        player = SC.CollectPlayer(),
        target = SC.CollectTarget(),
        zone = SC.CollectZone(),
        party = SC.CollectParty(),
        gear = SC.CollectGear(),
    }
end
