# Architecture Spec

DAG: DataStoreManager → EconomyManager → InventoryManager → ShopService → ShopCommands

MODULE: DataStoreManager
FILE: DataStoreManager.lua
DEPENDS_ON: none
DESCRIPTION: Low-level persistence layer using UpdateAsync and session locking to prevent data corruption.
PUBLIC API:
- function new(dataStoreName: string): DataStoreManager
- function loadPlayer(player: Player): (table|nil)
- function savePlayer(player: Player, data: table): boolean
- function unloadPlayer(player: Player): ()
- function saveAll(): boolean

MODULE: EconomyManager
FILE: EconomyManager.lua
DEPENDS_ON: DataStoreManager
DESCRIPTION: Manages player currency balances with transactional logic and auto-save.
PUBLIC API:
- function new(dataStore: DataStoreManager): EconomyManager
- function getBalance(player: Player): number
- function addCoins(player: Player, amount: number): boolean
- function removeCoins(player: Player, amount: number): boolean
- function savePlayer(player: Player): boolean
- function startAutoSave(interval: number): ()

MODULE: InventoryManager
FILE: InventoryManager.lua
DEPENDS_ON: DataStoreManager
DESCRIPTION: Manages player item collections with quantity-based validation.
PUBLIC API:
- function new(dataStore: DataStoreManager): InventoryManager
- function addItem(player: Player, itemId: string, qty: number): boolean
- function removeItem(player: Player, itemId: string, qty: number): boolean
- function getItems(player: Player): table (copy)
- function hasItem(player: Player, itemId: string, qty: number): boolean
- function savePlayer(player: Player): boolean
- function startAutoSave(interval: number): ()

MODULE: ShopService
FILE: ShopService.lua
DEPENDS_ON: EconomyManager, InventoryManager
DESCRIPTION: Orchestrates atomic transactions between economy and inventory with rollback capabilities.
PUBLIC API:
- function new(economy: EconomyManager, inventory: InventoryManager): ShopService
- function buyItem(player: Player, itemId: string, qty: number): boolean
- function sellItem(player: Player, itemId: string, qty: number): boolean
- function getItemPrice(itemId: string): number

MODULE: ShopCommands
FILE: ShopCommands.lua
DEPENDS_ON: ShopService
DESCRIPTION: Interface layer for mapping chat commands to ShopService actions.
PUBLIC API:
- function new(shop: ShopService): ShopCommands
- function registerCommands(): ()

