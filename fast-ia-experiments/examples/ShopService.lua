local ShopService = {}
ShopService.__index = ShopService

function ShopService.new(economy, inventory)
	local self = setmetatable({}, ShopService)
	self.economy = economy
	self.inventory = inventory
	self.itemRegistry = {
		-- mapping itemId to price
	}
	return self
end

function ShopService:getItemPrice(itemId)
	local price = self.itemRegistry[itemId]
	if not price then
		return 0
	end
	return price
end

function ShopService:buyItem(player, itemId, qty)
	if not qty > 0 then
		return false
	end

	local price = self:getItemPrice(itemId)
	if price == 0 then
		return false
	end

	local totalPrice = price * qty
	local removed = self.economy.removeCoins(player, totalPrice)
	if not removed then
		return false
	end

	local added = self.inventory.addItem(player, itemId, qty)
	if not added then
		-- ROLLBACK
		self.economy.addCoins(player, totalPrice)
		return false
	end

	return true
end

function ShopService:sellItem(player, itemId, qty)
	if not qty > 0 then
		return false
	end

	local has = self.inventory.hasItem(player, itemId, qty)
	if not has then
		return false
	end

	local price = self:getItemPrice(itemId)
	local totalGain = price * qty

	local removed = self.inventory.removeItem(player, itemId, qty)
	if not removed then
		return false
	end

	local added = self.economy.addCoins(player, totalGain)
	if not added then
		-- ROLLBACK
		self.inventory.addItem(player, itemId, qty)
		return false
	end

	return true
end

return ShopService