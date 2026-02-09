local _, WoWAgent = ...
WoWAgent.Utils = {}

-- Deep copy a table
function WoWAgent.Utils.DeepCopy(orig)
    if type(orig) ~= "table" then
        return orig
    end
    local copy = {}
    for k, v in pairs(orig) do
        copy[WoWAgent.Utils.DeepCopy(k)] = WoWAgent.Utils.DeepCopy(v)
    end
    return copy
end

-- Merge defaults into a target table (non-destructive)
-- Only sets keys that don't already exist in target
function WoWAgent.Utils.MergeDefaults(target, defaults)
    if type(target) ~= "table" or type(defaults) ~= "table" then
        return target
    end
    for k, v in pairs(defaults) do
        if target[k] == nil then
            target[k] = WoWAgent.Utils.DeepCopy(v)
        elseif type(v) == "table" and type(target[k]) == "table" then
            WoWAgent.Utils.MergeDefaults(target[k], v)
        end
    end
    return target
end
