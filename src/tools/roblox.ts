/**
 * roblox.ts - Roblox development tools
 * 
 * Tools for Rojo, Wally, Lune, Selene, Rokit
 */

import { Tool } from "../externalTools.js";

export const ROBLOX_TOOLS: Tool[] = [
  // --- Rojo --------------------------------------------------------------
  {
    name: "rojo_build",
    description: "Build .rbxl place file from Rojo project",
    category: "roblox",
    command: "rojo",
    args: ["build"],
    flags: [
      { name: "--output", type: "string", description: "Output file path" },
      { name: "--watch", type: "boolean", description: "Watch for changes" }
    ],
    detection: {
      method: "binary",
      check: "rojo --version"
    },
    context: {
      whenToUse: [
        "build roblox project",
        "generate rbxl",
        "create place file",
        "build game",
        "rojo build"
      ],
      requiresProject: [".project.json"],
      examples: ["rojo build default.project.json -o game.rbxl"]
    },
    outputParser: "raw"
  },
  
  {
    name: "rojo_serve",
    description: "Start Rojo live sync with Roblox Studio",
    category: "roblox",
    command: "rojo",
    args: ["serve"],
    flags: [
      { name: "--port", type: "number", description: "Port number" }
    ],
    detection: {
      method: "binary",
      check: "rojo --version"
    },
    context: {
      whenToUse: [
        "start live sync",
        "sync with studio",
        "rojo serve",
        "connect to studio"
      ],
      requiresProject: [".project.json"],
      examples: ["rojo serve"]
    },
    outputParser: "raw"
  },
  
  {
    name: "rojo_sourcemap",
    description: "Generate dependency graph/sourcemap",
    category: "roblox",
    command: "rojo",
    args: ["sourcemap"],
    flags: [
      { name: "--output", type: "string", description: "Output file path" },
      { name: "--watch", type: "boolean", description: "Watch for changes" }
    ],
    detection: {
      method: "binary",
      check: "rojo --version"
    },
    context: {
      whenToUse: [
        "generate sourcemap",
        "create dependency graph",
        "rojo sourcemap"
      ],
      requiresProject: [".project.json"],
      examples: ["rojo sourcemap default.project.json --output sourcemap.json"]
    },
    outputParser: "raw"
  },
  
  // --- Wally -------------------------------------------------------------
  {
    name: "wally_install",
    description: "Install Wally packages from wally.toml",
    category: "roblox",
    command: "wally",
    args: ["install"],
    flags: [],
    detection: {
      method: "config",
      check: "wally.toml"
    },
    context: {
      whenToUse: [
        "install roblox packages",
        "install dependencies",
        "wally install",
        "install packages"
      ],
      requiresProject: ["wally.toml"],
      examples: ["wally install"]
    },
    outputParser: "structured"
  },
  
  {
    name: "wally_search",
    description: "Search Wally registry for packages",
    category: "roblox",
    command: "wally",
    args: ["search"],
    flags: [
      { name: "query", type: "string", required: true, description: "Search query" }
    ],
    detection: {
      method: "config",
      check: "wally.toml"
    },
    context: {
      whenToUse: [
        "search wally packages",
        "find roblox packages",
        "wally search"
      ],
      examples: ["wally search profile"]
    },
    outputParser: "raw"
  },
  
  {
    name: "wally_publish",
    description: "Publish package to Wally registry",
    category: "roblox",
    command: "wally",
    args: ["publish"],
    flags: [],
    detection: {
      method: "config",
      check: "wally.toml"
    },
    context: {
      whenToUse: [
        "publish package",
        "wally publish",
        "release package"
      ],
      requiresProject: ["wally.toml"],
      examples: ["wally publish"]
    },
    outputParser: "raw"
  },
  
  // --- Lune --------------------------------------------------------------
  {
    name: "lune_run",
    description: "Run Luau script via Lune",
    category: "roblox",
    command: "lune",
    args: ["run"],
    flags: [
      { name: "script", type: "string", required: true, description: "Script path" },
      { name: "args", type: "string", description: "Script arguments" }
    ],
    detection: {
      method: "binary",
      check: "lune --version"
    },
    context: {
      whenToUse: [
        "run luau script",
        "execute luau",
        "lune run",
        "run script"
      ],
      examples: ["lune run build.luau", "lune run migrate.luau --version 2"]
    },
    outputParser: "raw"
  },
  
  // --- Selene ------------------------------------------------------------
  {
    name: "selene_lint",
    description: "Lint Luau code with Selene",
    category: "roblox",
    command: "selene",
    args: ["--color", "never"],
    flags: [
      { name: "--fix", type: "boolean", description: "Auto-fix issues" },
      { name: "path", type: "string", description: "File or directory to lint" }
    ],
    detection: {
      method: "binary",
      check: "selene --version"
    },
    context: {
      whenToUse: [
        "lint roblox code",
        "check code quality",
        "selene lint",
        "lint luau"
      ],
      requiresProject: ["selene.toml"],
      examples: ["selene src/", "selene --fix src/"]
    },
    outputParser: "structured",
    customParser: (output: string) => {
      const regex = /^(.+?):(\d+):(\d+): (error|warning|info): (.+)$/gm;
      const issues: any[] = [];
      let match;
      while ((match = regex.exec(output)) !== null) {
        issues.push({
          file: match[1],
          line: Number.parseInt(match[2], 10),
          column: Number.parseInt(match[3], 10),
          severity: match[4],
          message: match[5]
        });
      }
      return {
        success: issues.filter(i => i.severity === 'error').length === 0,
        output,
        metadata: { issues, errorCount: issues.filter(i => i.severity === 'error').length }
      };
    }
  },
  
  // --- Rokit -------------------------------------------------------------
  {
    name: "rokit_install",
    description: "Install tools via Rokit",
    category: "roblox",
    command: "rokit",
    args: ["install"],
    flags: [],
    detection: {
      method: "config",
      check: "rokit.toml"
    },
    context: {
      whenToUse: [
        "install roblox tools",
        "install rokit tools",
        "rokit install"
      ],
      requiresProject: ["rokit.toml"],
      examples: ["rokit install"]
    },
    outputParser: "raw"
  },
  
  {
    name: "rokit_add",
    description: "Add tool via Rokit",
    category: "roblox",
    command: "rokit",
    args: ["add"],
    flags: [
      { name: "tool", type: "string", required: true, description: "Tool name" }
    ],
    detection: {
      method: "config",
      check: "rokit.toml"
    },
    context: {
      whenToUse: [
        "add roblox tool",
        "rokit add"
      ],
      examples: ["rokit add rojo"]
    },
    outputParser: "raw"
  },
  
  // --- wally-package-types -----------------------------------------------
  {
    name: "generate_types",
    description: "Generate type definitions for Wally packages",
    category: "roblox",
    command: "wally-package-types",
    args: [],
    flags: [
      { name: "-s", type: "string", required: true, description: "Sourcemap path" },
      { name: "path", type: "string", required: true, description: "Packages directory" }
    ],
    detection: {
      method: "binary",
      check: "wally-package-types --version"
    },
    context: {
      whenToUse: [
        "generate types",
        "create type definitions",
        "wally-package-types"
      ],
      requiresProject: ["wally.toml"],
      examples: ["wally-package-types -s sourcemap.json Packages/"]
    },
    outputParser: "raw"
  },

  // --- Pseudotools: Luau Library Code Generation --------------------------

  {
    name: "profilestore_pattern",
    description: "Generate ProfileStore data persistence code pattern",
    category: "roblox",
    command: "echo",
    args: [],
    flags: [],
    detection: {
      method: "manual",
      check: "",
      installed: true
    },
    context: {
      whenToUse: [
        "use profilestore",
        "data persistence",
        "save player data",
        "profilestore",
        "data store"
      ],
      examples: []
    },
    outputParser: "custom",
    customParser: () => ({
      success: true,
      output: `-- ProfileStore Pattern
-- Wally: profilestore

local ProfileStore = require(ReplicatedStorage.Packages.ProfileStore)

local PLAYER_STORE = ProfileStore.New("PlayerData", {
    Coins = 0,
    Level = 1,
    Inventory = {},
})

local Profiles = {}

local function playerAdded(player)
    local profile = PLAYER_STORE:StartSessionAsync(function(self)
        if self.ServerState.IsMock then
            return true
        end
        return not player:IsDescendantOf(Players)
    end)
    
    if profile then
        profile:OnClose(function()
            Profiles[player] = nil
        end)
        Profiles[player] = profile
    end
end

local function playerRemoving(player)
    local profile = Profiles[player]
    if profile then
        profile:Release()
    end
end

Players.PlayerAdded:Connect(playerAdded)
Players.PlayerRemoving:Connect(playerRemoving)

-- Usage:
-- local profile = Profiles[player]
-- if profile then
--     profile.Data.Coins += 100
-- end`,
      metadata: {
        library: "ProfileStore",
        category: "data-persistence",
        wallyPackage: "profilestore"
      }
    })
  },

  {
    name: "bytenet_pattern",
    description: "Generate ByteNet networking code pattern",
    category: "roblox",
    command: "echo",
    args: [],
    flags: [],
    detection: {
      method: "manual",
      check: "",
      installed: true
    },
    context: {
      whenToUse: [
        "use bytenet",
        "networking",
        "remote events",
        "client server communication",
        "bytenet"
      ],
      examples: []
    },
    outputParser: "custom",
    customParser: () => ({
      success: true,
      output: `-- ByteNet Pattern
-- Wally: bytenet

local ByteNet = require(ReplicatedStorage.Packages.ByteNet)

-- Define network namespace
local Network = ByteNet.DefineNamespace("GameNetwork")

-- Define remotes
local Remotes = Network.DefineRemotes({
    PlayerAction = Network.ServerEvent({
        Action = "string",
        Data = "table",
    }),
    UpdateUI = Network.ClientEvent({
        Type = "string",
        Value = "any",
    }),
    GetPlayerData = Network.ServerFunction({
        Response = "table",
    }),
})

-- Server-side handler
Remotes.PlayerData.OnServerEvent:Connect(function(player, action, data)
    -- Handle player action
    Remotes.UpdateUI:FireClient(player, "coins", 100)
end)

-- Client-side usage
Remotes.PlayerAction:FireServer("buy", { itemId = 123 })

-- Function call
local result = Remotes.GetPlayerData:InvokeServer()`,
      metadata: {
        library: "ByteNet",
        category: "networking",
        wallyPackage: "bytenet"
      }
    })
  },

  {
    name: "replica_pattern",
    description: "Generate Replica data replication code pattern",
    category: "roblox",
    command: "echo",
    args: [],
    flags: [],
    detection: {
      method: "manual",
      check: "",
      installed: true
    },
    context: {
      whenToUse: [
        "use replica",
        "data replication",
        "server to client sync",
        "replica"
      ],
      examples: []
    },
    outputParser: "custom",
    customParser: () => ({
      success: true,
      output: `-- Replica Pattern
-- Wally: replica

local Replica = require(ReplicatedStorage.Packages.Replica)

-- Server-side: Create controller
local Controller = Replica.NewController("PlayerData")

-- Server-side: Set data
Controller:Replicate({
    Coins = 0,
    Level = 1,
    Inventory = {},
})

-- Server-side: Update data
Controller:Replicate({
    Coins = 100,
})

-- Client-side: Listen for changes
local Client = Replica.NewClient()

Client:OnReplicate("PlayerData", function(data)
    print("Player data updated:", data)
    -- Update UI here
end)

-- Client-side: Get current data
local data = Client:GetReplica("PlayerData")
print(data.Coins)`,
      metadata: {
        library: "Replica",
        category: "replication",
        wallyPackage: "replica"
      }
    })
  },

  {
    name: "react_roblox_pattern",
    description: "Generate React-Roblox UI code pattern",
    category: "roblox",
    command: "echo",
    args: [],
    flags: [],
    detection: {
      method: "manual",
      check: "",
      installed: true
    },
    context: {
      whenToUse: [
        "use react roblox",
        "react ui",
        "jsx roblox",
        "react-roblox"
      ],
      examples: []
    },
    outputParser: "custom",
    customParser: () => ({
      success: true,
      output: `-- React-Roblox Pattern
-- Wally: react-roblox

local React = require(ReplicatedStorage.Packages.React)
local ReactRoblox = require(ReplicatedStorage.Packages.ReactRoblox)

local e = React.createElement

-- Component
local function App(props)
    local count, setCount = React.useState(0)
    
    return e("ScreenGui", {}, {
        e("Frame", {
            Size = UDim2.new(0, 200, 0, 100),
            Position = UDim2.new(0.5, -100, 0.5, -50),
        }, {
            e("TextLabel", {
                Size = UDim2.new(1, 0, 0, 50),
                Text = "Count: " .. count,
            }),
            e("TextButton", {
                Size = UDim2.new(1, 0, 0, 50),
                Position = UDim2.new(0, 0, 0, 50),
                Text = "Click me",
                [ReactRoblox.Event.Activated] = function()
                    setCount(count + 1)
                end,
            }),
        }),
    })
end

-- Mount
local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")
ReactRoblox.createRoot(playerGui):render(e(App))`,
      metadata: {
        library: "React-Roblox",
        category: "ui",
        wallyPackage: "react-roblox"
      }
    })
  },

  {
    name: "trove_pattern",
    description: "Generate Trove cleanup/lifecycle code pattern",
    category: "roblox",
    command: "echo",
    args: [],
    flags: [],
    detection: {
      method: "manual",
      check: "",
      installed: true
    },
    context: {
      whenToUse: [
        "use trove",
        "cleanup",
        "lifecycle management",
        "trove"
      ],
      examples: []
    },
    outputParser: "custom",
    customParser: () => ({
      success: true,
      output: `-- Trove Pattern
-- Wally: trove

local Trove = require(ReplicatedStorage.Packages.Trove)

-- Create a trove
local trove = Trove.new()

-- Track connections
local connection = someEvent:Connect(function()
    print("Event fired")
end)
trove:Add(connection)

-- Track instances
local part = Instance.new("Part")
trove:Add(part)

-- Track with cleanup function
trove:Add(function()
    print("Cleaning up custom resource")
end)

-- Add with tag
trove:Add(someObject, "MyObject")

-- Cleanup everything
trove:Clean()

-- Or destroy when done
trove:Destroy()

-- Usage in lifecycle
local function onCharacterAdded(character)
    local charTrove = Trove.new()
    
    local humanoid = character:WaitForChild("Humanoid")
    charTrove:Add(humanoid.Died:Connect(function()
        print("Character died")
    end))
    
    charTrove:Add(character)
    
    return charTrove
end`,
      metadata: {
        library: "Trove",
        category: "lifecycle",
        wallyPackage: "trove"
      }
    })
  },

  {
    name: "signal_pattern",
    description: "Generate Signal event system code pattern",
    category: "roblox",
    command: "echo",
    args: [],
    flags: [],
    detection: {
      method: "manual",
      check: "",
      installed: true
    },
    context: {
      whenToUse: [
        "use signal",
        "custom events",
        "signal event",
        "signal"
      ],
      examples: []
    },
    outputParser: "custom",
    customParser: () => ({
      success: true,
      output: `-- Signal Pattern
-- Wally: signal (Sleitnick/RbxUtil)

local Signal = require(ReplicatedStorage.Packages.Signal)

-- Create signal
local onCoinsChanged = Signal.new()

-- Connect
local connection = onCoinsChanged:Connect(function(newAmount)
    print("Coins changed to:", newAmount)
end)

-- Fire
onCoinsChanged:Fire(100)

-- Once (auto-disconnect after first fire)
onCoinsChanged:Once(function(amount)
    print("First change:", amount)
end)

-- Wait (yield until fired)
task.spawn(function()
    local amount = onCoinsChanged:Wait()
    print("Waited for:", amount)
end)

-- Disconnect
connection:Disconnect()

-- Get all connections
local connections = onCoinsChanged:GetConnections()

-- Destroy signal
onCoinsChanged:Destroy()

-- Deferred fire (fires at end of frame)
onCoinsChanged:FireDeferred(200)`,
      metadata: {
        library: "Signal",
        category: "events",
        wallyPackage: "sleitnick/signal"
      }
    })
  },

  {
    name: "observers_pattern",
    description: "Generate Observers instance observation code pattern",
    category: "roblox",
    command: "echo",
    args: [],
    flags: [],
    detection: {
      method: "manual",
      check: "",
      installed: true
    },
    context: {
      whenToUse: [
        "use observers",
        "observe tags",
        "observe players",
        "observe instances",
        "observers"
      ],
      examples: []
    },
    outputParser: "custom",
    customParser: () => ({
      success: true,
      output: `-- Observers Pattern
-- Wally: observers (Sleitnick/RbxObservers)

local Observers = require(ReplicatedStorage.Packages.Observers)

-- Observe tagged instances
local stopObserver = Observers.observeTag("MyTag", function(instance)
    print("Tagged instance found:", instance)
    
    -- Return cleanup function
    return function()
        print("Instance lost tag or destroyed")
    end
end)

-- Stop observer
stopObserver()

-- Observe with ancestry filter
Observers.observeTag("Coin", function(coin)
    print("Coin spawned:", coin)
    return function()
        print("Coin removed")
    end
end, { workspace }) -- Only observe in Workspace

-- Observe players
Observers.observePlayer(function(player)
    print("Player joined:", player.Name)
    
    return function()
        print("Player left:", player.Name)
    end
end)

-- Observe characters
Observers.observeCharacter(function(player, character)
    print("Character spawned for:", player.Name)
    
    local humanoid = character:WaitForChild("Humanoid")
    
    return function()
        print("Character removed for:", player.Name)
    end
end)

-- Observe attributes
Observers.observeAttribute("Health", function(instance, value)
    print("Health changed to:", value)
    
    return function()
        print("Attribute removed")
    end
end)`,
      metadata: {
        library: "Observers",
        category: "observation",
        wallyPackage: "sleitnick/observers"
      }
    })
  },

  {
    name: "cmdr_pattern",
    description: "Generate Cmdr command system code pattern",
    category: "roblox",
    command: "echo",
    args: [],
    flags: [],
    detection: {
      method: "manual",
      check: "",
      installed: true
    },
    context: {
      whenToUse: [
        "use cmdr",
        "admin commands",
        "command system",
        "cmdr"
      ],
      examples: []
    },
    outputParser: "custom",
    customParser: () => ({
      success: true,
      output: `-- Cmdr Pattern
-- Wally: cmdr

local Cmdr = require(ReplicatedStorage.Packages.Cmdr)

-- Register default commands (optional)
Cmdr:RegisterDefaultCommands()

-- Custom command definition
-- File: ServerScriptService/CmdrCommands/GiveCoins.lua
return {
    Name = "givecoins",
    Aliases = { "gc", "coins" },
    Description = "Give coins to a player",
    Group = "Admin",
    Args = {
        {
            Type = "player",
            Name = "Player",
            Description = "Target player",
        },
        {
            Type = "number",
            Name = "Amount",
            Description = "Amount of coins",
            Default = 100,
        },
    },
    ClientRun = function(context, player, amount)
        -- Server-side execution
        local ProfileStore = require(script.Parent.ProfileStore)
        local profile = ProfileStore:GetProfile(player)
        if profile then
            profile.Data.Coins += amount
            return "Gave " .. amount .. " coins to " .. player.Name
        end
        return "Failed to give coins"
    end,
}

-- Custom argument type
-- File: ServerScriptService/CmdrArgTypes/Percentage.lua
return {
    Validate = function(value)
        local num = tonumber(value)
        return num and num >= 0 and num <= 100
    end,
    Transform = function(value)
        return tonumber(value) / 100
    end,
    Display = function(value)
        return value .. "%"
    end,
    Default = 100,
}

-- Client-side usage
Cmdr:RegisterHook("BeforeRun", function(context)
    print("Command running:", context.CommandName)
end)

-- Run command programmatically
Cmdr:Execute("givecoins Player1 500")`,
      metadata: {
        library: "Cmdr",
        category: "commands",
        wallyPackage: "cmdr"
      }
    })
  }
];