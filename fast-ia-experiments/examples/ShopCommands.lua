local ShopCommands = {}
ShopCommands.__index = ShopCommands

local Players = game:GetService("Players")

function ShopCommands.new(shopService)
	local self = setmetatable({}, ShopCommands)
	self.shopService = shopService
	return self
end

local function ShopCommands:handleChatMessage(player, message)
	local args = string.split(message, "%s")
	local command = args[1]

	if command ~= "/buy" and command ~= "/sell" then
		return
	end

	if command == "/buy" then
		if #args ~= 3 then
			player:ChatMessage("Usage: /buy <itemId> <qty>")
			return
		end

		local itemId = args[2]
		local qty = tonumber(args[3])

		if qty == nil or qty <= 0 then
			player:ChatMessage("Quantity must be a positive number")
			return
		end

		local success = self.shopService:buyItem(player, itemId, qty)
		if success == true then
			player:ChatMessage("Successfully bought " .. qty .. " " .. itemId)
		else
			player:ChatMessage("Purchase failed. Check funds or item validity.")
		end
	elseif command == "/sell" then
		if #args ~= 3 then
			player:ChatMessage("Usage: /sell <itemId> <qty>")
			return
		end

		local itemId = args[2]
		local qty = tonumber(args[3])

		if qty == nil or qty <= 0 then
			player:ChatMessage("Quantity must be a positive number")
			return
		end

		local success = self.shopService:sellItem(player, itemId, qty)
		if success == true then
			player:ChatMessage("Successfully sold " .. qty .. " " .. itemId)
		else
			player:ChatMessage("Sale failed. You might not have enough items.")
		end
	end
end

function ShopCommands:registerCommands()
	Players.PlayerAdded:Connect(function(player)
		player.Chatted:Connect(function(message)
			self:handleChatMessage(player, message)
		end)
	end)
end

-- Helper to simulate ChatMessage as per logic flow requirements
function Player:ChatMessage(text)
	-- In a real Roblox environment, this would use TextChatService or a UI system
	-- The logic flow specifies "sending" the message.
	print(self.Name .. " chat: " .. text)
end

-- Note: Since ChatMessage is not a native Player method in modern Roblox,
-- it is treated here as a placeholder for the "send" action in the logic.
-- Re-defining it to ensure the code runs as described.
if not Player.ChatMessage then
	Player.ChatMessage = function(self, text)
		print(text)
	end
end

-- Overriding the method definition to match the logic's "send" requirement
-- Using a simple print for the purpose of the translation.
function Player:ChatMessage(self, text)
	print(text)
end

return ShopCommands