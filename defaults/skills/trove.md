---
name: Trove
version: 2.0.3
source: wally
package: sleitnick/trove@2.0.3
category: roblox
tags: [cleanup, lifecycle, memory-management, connections]
---

# Trove

**What it is**: A cleanup/lifecycle utility that batches together connections,
instances, threads, and functions so they can all be cleaned up with a single
`trove:Clean()` or `trove:Destroy()` call.

**When to use**:
- You're wiring up multiple `:Connect()` calls and want to disconnect all at once
- You're creating Instances procedurally and need to guarantee cleanup
- You're spawning threads (`task.spawn`) that should be cancelled on teardown
- You want RAII-style lifecycle management in Luau

**Installation** (in `wally.toml`):
```toml
[dependencies]
Trove = "sleitnick/trove@2.0.3"
```

**Common pattern** (Luau):
```lua
local Trove = require(game:GetService("ReplicatedStorage").Packages.Trove)

local function setupPlayerUI(player)
    local self = Trove.new()

    local gui = self:Construct("ScreenGui")
    gui.Parent = player:WaitForChild("PlayerGui")

    self:Add(gui:GetPropertyChangedSignal("AbsoluteSize"):Connect(function()
        -- handle resize
    end))

    self:Add(function()
        print("Cleaning up UI for", player.Name)
    end)

    -- Later, on teardown
    player.AncestryChanged:Once(function()
        self:Clean()  -- disconnects, destroys, calls all added fns
    end)

    return self
end
```

**API summary**:
- `trove:Add(item)` — adds an RBXScriptConnection, Instance, thread, or function
- `trove:Construct(className)` — creates an Instance and tracks it
- `trove:Extend()` — returns a sub-trove that cleans up with the parent
- `trove:Clean()` — runs all cleanups but keeps the trove usable
- `trove:Destroy()` — cleans up AND marks the trove itself as dead

**Pitfalls to avoid**:
- Don't double-clean; `:Clean()` is idempotent but `:Destroy()` is final
- Don't add raw Instances you don't own — `:Clean()` will `:Destroy()` them
- For long-lived objects, prefer `:Extend()` over nested Troves for clarity
- Trove 2.x has breaking API changes from 1.x (no more `:AddToClean`)
