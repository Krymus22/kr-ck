---
name: ProfileStore
version: 0.4.6
source: wally
package: fireelysium/profilestore@0.4.6
category: roblox
tags: [data, persistence, profiles, session-locking]
---

# ProfileStore

**What it is**: A robust data persistence library for Roblox that handles player profile
loading, saving, and session locking on top of DataStoreService.

**When to use**:
- Storing per-player persistent data (inventory, stats, settings, currency)
- You need session locking to prevent data duplication when players reconnect
- You want automatic retries and conflict resolution against DataStore limits
- You need to migrate data between schema versions

**Installation** (in `wally.toml`):
```toml
[dependencies]
ProfileStore = "fireelysium/profilestore@0.4.6"
```

**Common pattern** (Luau):
```lua
local ProfileStore = require(game:GetService("ReplicatedStorage").Packages.ProfileStore)

local PlayerStore = ProfileStore.New("PlayerData", {
    Template = {
        Coins = 0,
        Inventory = {},
        LastLogin = os.time(),
    },
})

-- Load on join
local function onPlayerAdded(player)
    local profile = PlayerStore:Load(player.UserId)
    if not profile then
        player:Kick("Failed to load profile. Please rejoin.")
        return
    end
    -- profile.Data is the live table; auto-saves on changes
end

game:GetService("Players").PlayerAdded:Connect(onPlayerAdded)
```

**Pitfalls to avoid**:
- Always check `profile == nil` after Load() — DataStore can fail
- Don't mutate profile.Data directly from client; use RemoteEvents
- Call `profile:Release()` on PlayerRemoving or you'll leak session locks
- Don't use os.time() for LastLogin; use DateTime.now() for UTC consistency
