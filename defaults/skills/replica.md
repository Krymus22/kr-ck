---
name: Replica
version: 0.4.6
source: wally
package: fireelysium/replica@0.4.6
category: roblox
tags: [replication, state, server-authoritative]
---

# Replica

**What it is**: A server-authoritative state replication library that broadcasts
server-side data changes to specific clients (or all) with type-safe callbacks.

**When to use**:
- You need fine-grained state replication without writing manual RemoteEvents
- You want only specific players to receive specific data (e.g. their inventory)
- You need dirty-flag tracking so clients can react to changes efficiently
- You want replication to be server-only (client can't spoof writes)

**Installation** (in `wally.toml`):
```toml
[dependencies]
Replica = "fireelysium/replica@0.4.6"
```

**Common pattern** (Luau):
```lua
local Replica = require(game:GetService("ReplicatedStorage").Packages.Replica)

-- Server creates a replica tied to a player
local function createInventoryReplica(player, inventoryData)
    local replica = Replica.New({
        Class = "Inventory",
        Data = inventoryData,
        Tags = { Player = player },
    })
    return replica
end

-- Server mutates → all subscribers receive delta
replica:SetValue({ Coins = 100 })

-- Client listens
Replica.OnSetup:Connect(function(replica)
    if replica.Class ~= "Inventory" then return end
    replica:OnSet({"Coins"}, function(newCoins)
        -- update UI
    end)
end)
```

**Pitfalls to avoid**:
- Replicas are one-way (server → client). For client→server use RemoteEvent/ByteNet
- Don't create a Replica per item; batch them under one Inventory replica
- Always clean up replicas on PlayerRemoving or you'll leak memory
- Use `replica:SetValue({...})` for deep paths, not `replica.Data.x = y` (won't replicate)
