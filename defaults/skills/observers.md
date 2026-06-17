---
name: Observers
version: 1.12.0
source: wally
package: fireelysium/observers@1.12.0
category: roblox
tags: [observation, instances, tags, collectionservice]
---

# Observers

**What it is**: A library that lets you write reactive code based on instances
matching a Tag (CollectionService) or being added/removed from the DataModel.
Combines the "spawn + cleanup" pattern into a single declaration.

**When to use**:
- You want to react when Instances with a specific Tag appear/disappear
- You're building systems that need setup/teardown per Instance (e.g. enemy AI)
- You want to avoid manual `CollectionService:GetInstanceAddedSignal` boilerplate
- You need deterministic cleanup when an Instance is destroyed

**Installation** (in `wally.toml`):
```toml
[dependencies]
Observers = "fireelysium/observers@1.12.0"
```

**Common pattern** (Luau):
```lua
local Observers = require(game:GetService("ReplicatedStorage").Packages.Observers)
local Trove = require(game:GetService("ReplicatedStorage").Packages.Trove)

-- React to all "Enemy" tagged instances
Observers.observeTag("Enemy", function(enemy)
    local trove = Trove.new()

    -- Setup
    local hum = enemy:WaitForChild("Humanoid")
    local conn = hum.Died:Connect(function()
        print("Enemy defeated:", enemy.Name)
    end)
    trove:Add(conn)

    -- Cleanup runs automatically when the enemy is untagged or destroyed
    return function()
        trove:Clean()
    end
end)
```

**Other observation modes**:
```lua
-- Watch a specific instance for any descendant being added
Observers.observeDescendantsAdded(model, function(child) ... end)

-- Watch the DataModel for new services
Observers.observeAdded(game, function(inst) ... end)

-- Combine with Replica for cross-player state observation
Observers.observeReplica("Inventory", function(replica, player) ... end)
```

**API summary**:
- `Observers.observeTag(tagName, setupFn)` — setupFn returns cleanupFn
- `Observers.observeAdded(parent, fn)` — fires when child added to parent
- `Observers.observeRemoved(parent, fn)` — fires when child removed
- `Observers.observeProperty(inst, prop, fn)` — fires on prop change

**Pitfalls to avoid**:
- The setup function MUST return a cleanup function or you'll leak on teardown
- Don't yield in the setup function (no `task.wait()`) — observeTag is synchronous
- If you tag/untag rapidly, you'll get setup/cleanup spam; debounce at call site
- Tags must be registered with CollectionService first (or via Studio Tag editor)
