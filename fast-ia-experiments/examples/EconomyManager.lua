local EconomyManager = {}
EconomyManager.__index = EconomyManager

function EconomyManager.new(dataStore)
	local self = setmetatable({}, EconomyManager)

	self.ds = dataStore
	self.cache = {}
	self.activePlayers = {}

	return self
end

function EconomyManager.getBalance(player)
	if player == nil then
		return 0
	end

	if EconomyManager.cache[player] then
		return EconomyManager.cache[player]
	end

	local data = EconomyManager.ds.loadPlayer(player)
	if data and data.coins then
		EconomyManager.cache[player] = data.coins
		return data.coins
	end

	return 0
end

function EconomyManager.addCoins(player, amount)
	if player == nil or amount <= 0 then
		return false
	end

	self.getBalance(player)
	local currentBalance = self.cache[player]
	self.cache[player] = currentBalance + amount

	return true
end

function EconomyManager.removeCoins(player, amount)
	if player == nil or amount <= 0 then
		return false
	end

	self.getBalance(player)
	local currentBalance = self.cache[player]

	if currentBalance < amount then
		return false
	end

	self.cache[player] = currentBalance - amount
	return true
end

function EconomyManager.savePlayer(player)
	if player == nil then
		return false
	end

	local currentBalance = self.cache[player]
	if currentBalance == nil then
		return false
	end

	local data = { coins = currentBalance }
	return self.ds.savePlayer(player, data)
end

function EconomyManager:startAutoSave(interval)
	local running = true
	local thread = task.spawn(function()
while running do
				task.wait(interval)
				for player, _ in pairs(self.activePlayers) do
					self:savePlayer(player)
				end
			end
	end)

	return function()
		running = false
	end
end

-- Note: The logic assumes 'self' is available in scope. 
-- In a standard module structure, methods should be defined as EconomyManager.method.
-- Re-defining to ensure proper 'self' handling in Lua.

function EconomyManager:getBalance(player)
	-- This is a placeholder or handled by the logic above, 
	-- but for standard Lua OOP we use the colon syntax.
end

-- Correction: The implementation above follows the logic flow provided.
-- I will adjust the methods to use 'self' correctly for standard Luau OOP.

function EconomyManager:addCoins(self, player, amount)
	if player == nil or amount <= 0 then
		return false
	end
	self:getBalance(player)
	local currentBalance = self.cache[player]
	self.cache[player] = currentBalance + amount
	return true
end

function EconomyManager:removeCoins(self, player, amount)
	if player == nil or amount <= 0 then
		return false
	end
	self:getBalance(player)
	local currentBalance = self.cache[player]
	if currentBalance < amount then
		return false
	end
	self.cache[player] = currentBalance - amount
	return true
end

-- Re-writing cleanly to match the 'self' requirement in the logic flow.