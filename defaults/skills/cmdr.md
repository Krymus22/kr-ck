---
name: Cmdr
version: 1.12.0
source: wally
package: evaera/cmdr@1.12.0
category: roblox
tags: [admin, commands, console, debugging]
---

# Cmdr

**What it is**: An in-game admin command bar and console for Roblox. Provides
a built-in command palette, a permission system, and a registration API for
custom commands. Used heavily in development to debug live games.

**When to use**:
- You need an in-game console for admins to run commands (teleport, give items, ban)
- You want to expose debug commands to testers without giving them Studio access
- You want a typed, argument-parsed command system (no manual string parsing)
- You want built-in autocomplete and history

**Installation** (in `wally.toml`):
```toml
[dependencies]
Cmdr = "evaera/cmdr@1.12.0"
```

**Common pattern** (Luau — server init):
```lua
local Cmdr = require(game:GetService("ServerScriptService").Packages.Cmdr)

local cmdr = Cmdr:RegisterDefaultHooks()  -- registers :kick, :ban, :tp, etc.
cmdr:RegisterHook("beforeRun", function(context)
    -- context.Executor is the player running the command
    if not context.Executor:GetAttribute("IsAdmin") then
        return "You do not have permission to run commands."
    end
end)

cmdr:RegisterCommandsIn(game:GetService("ServerScriptService").CmdrCommands)
```

**Custom command** (Luau, in `CmdrCommands/GiveCoins.lua`):
```lua
return {
    Name = "give-coins",
    Aliases = { "gc" },
    Description = "Give coins to a player",
    Group = "Admin",
    Args = {
        {
            Type = "player",
            Name = "target",
            Description = "Who to give coins to",
        },
        {
            Type = "integer",
            Name = "amount",
            Description = "How many coins",
        },
    },
    Run = function(context, target, amount)
        target:SetAttribute("Coins", (target:GetAttribute("Coins") or 0) + amount)
        return "Gave " .. amount .. " coins to " .. target.Name
    end,
}
```

**Client console**: Cmdr automatically injects a `CmdrClient` in StarterPlayerScripts.
Players press `:` (default) to open the console, type a command, and Enter to run.

**Pitfalls to avoid**:
- Always hook `beforeRun` for permission checks — don't trust client-side validation
- Custom command files must be in a Folder, not a ModuleScript directly
- Don't yield in `Run` without returning a Promise — Cmdr treats returns as output
- For client-only commands, mark `Group = "Default"` and register client-side
