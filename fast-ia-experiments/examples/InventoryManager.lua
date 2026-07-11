local InventoryManager = {}
InventoryManager.__index = InventoryManager

function InventoryManager.new(dataStore)
	local self = setmetatable({}, InventoryManager)
	self.dataStore = dataStore
	self.cache = {}
	return self
end

function InventoryManager:addItem(player, itemId, qty)
	if qty <= 0 then
		return false
	end

	if not self.cache[player.UserId] then
		local data = self.dataStore.loadPlayer(player)
		if not data then
			print("Failed to load player data for", player.Name)
			return false
		end
		self.cache[player.UserId] = data
	end

	local inventory = self.cache[player.UserId]
	local oldInventory = {}
	for k, v in pairs(inventory) do
		oldInventory[k] = v
	end

	if inventory[itemId] then
		inventory[itemId] = inventory[itemId] + qty
	else
		inventory[itemId] = qty
	end

	local success = self.dataStore.savePlayer(player, inventory)
	if success then
		return true
	else
		self.cache[player.UserId] = oldInventory
		return false
	end
end

function InventoryManager:removeItem(player, itemId, qty)
	if qty <= 0 then
		return false
	end

	if not self.cache[player.UserId] then
		local data = self.dataStore.loadPlayer(player)
		if not data then
			return false
		end
		self.cache[player.UserId] = data
	end

	local inventory = self.cache[player.UserId]
	if not inventory[itemId] or inventory[itemId] < qty then
		return false
	end

	local oldInventory = {}
	for k, v in pairs(inventory) do
		oldInventory[k] = v
	end

	inventory[itemId] = inventory[itemId] - qty
	if inventory[itemId] == 0 then
		inventory[itemId] = nil
	end

	local success = self.dataStore.savePlayer(player, inventory)
	if success then
		return true
	else
		self.cache[player.UserId] = oldInventory
		return false
	end
end

function InventoryManager:getItems(player)
	if not self.cache[player.UserId] then
		local data = self.dataStore.loadPlayer(player)
		if not data then
			return {}
		end
		self.cache[player.UserId] = data
	end

	local inventory = self.cache[player.UserId]
	local copy = {}
	for k, v in pairs(inventory) do
		copy[k] = v
	end
	return copy
end

function InventoryManager:hasItem(player, itemId, qty)
	if not self.cache[player.UserId] then
		local data = self.dataStore.loadPlayer(player)
		if not data then
			return false
		end
		self.cache[player.UserId] = data
	end

	local inventory = self.cache[player.UserId]
	local item = inventory[itemId]
	if item and item >= qty then
		return true
	end
	return false
end

function InventoryManager:savePlayer(player)
	if not self.cache[player.UserId] then
		return false
	end
	local success = self.dataStore.savePlayer(player, self.cache[player.UserId])
	return success
end

function InventoryManager:startAutoSave(interval)
	task.spawn(function()
		while true do
			task.wait(interval)
			for userId, inventory in pairs(self.cache) do
				local player = game("Players"):GetPlayerByUserId(userId)
				if player then
					pcall(function()
						self.dataStore.savePlayer(player, inventory)
					end)
				end
			end
		end
	end)
end

return InventoryManager