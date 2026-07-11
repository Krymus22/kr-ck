local DataStoreService = game:GetService("DataStoreService")

local DataStoreManager = {}

function DataStoreManager.new(dataStoreName: string)
	local SessionCache = {}
	local dataStore = DataStoreService:GetDataStore(dataStoreName)
	local DefaultTemplate = {
		coins = 0,
		items = {},
		version = 1
	}

	local function loadPlayer(player)
		if not player then
			return nil
		end

		if SessionCache[player] then
			return SessionCache[player]
		end

		local playerKey = "Player_" .. player.UserId
		local success, result = pcall(function()
			return dataStore:UpdateAsync(playerKey, function(oldData)
				if oldData == nil then
					return DefaultTemplate
				else
					return oldData
				end
			end)
		end)

		if success then
			SessionCache[player] = result
			return result
		else
			warn("Failed to load data for player " .. player.Name .. ": " .. tostring(result))
			return nil
		end
	end

	local function savePlayer(player, data)
		if not SessionCache[player] then
			return false
		end

		local playerKey = "Player_" .. player.UserId
		local success, result = pcall(function()
			return dataStore:UpdateAsync(playerKey, function(oldData)
				if type(data) == "table" then
					return data
				end
				return oldData
			end)
		end)

		if success then
			SessionCache[player] = data
			return true
		else
			warn("Failed to save data for player " .. player.Name .. ": " .. tostring(result))
			return false
		end
	end

	local function unloadPlayer(player)
		if SessionCache[player] then
			savePlayer(player, SessionCache[player])
			SessionCache[player] = nil
		end
	end

	local function saveAll()
		local allSuccess = true
		for player, data in pairs(SessionCache) do
			local success = savePlayer(player, data)
			if not success then
				allSuccess = false
			end
		end
		return allSuccess
	end

	local function startAutoSave(interval)
		task.spawn(function()
			while true do
				task.wait(interval)
				saveAll()
			end
		end)
	end

	return {
		loadPlayer = loadPlayer,
		savePlayer = savePlayer,
		unloadPlayer = unloadPlayer,
		saveAll = saveAll,
		startAutoSave = startAutoSave
	}
end

return DataStoreManager