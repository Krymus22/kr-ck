---
name: React-Roblox
version: 1.8.0
source: wally
package: jsdotlua/react-roblox@1.8.0
category: roblox
tags: [ui, react, renderer, roblox-instances]
---

# React-Roblox

**What it is**: The Roblox renderer for React (jsdotlua). Takes React elements
produced by `React.createElement` and materializes them into real Roblox
Instances (TextLabel, Frame, ScreenGui, etc.) under a target container.

**When to use**:
- You're already using `jsdotlua/react` and need to actually render it
- You want React's declarative model to manage Roblox GUI instances
- You need a virtual DOM diff against a Roblox instance tree

**Installation** (in `wally.toml`):
```toml
[dependencies]
React = "jsdotlua/react@17.2.1"
ReactRoblox = "jsdotlua/react-roblox@1.8.0"
```

**Common pattern** (Luau):
```lua
local React = require(game:GetService("ReplicatedStorage").Packages.React)
local ReactRoblox = require(game:GetService("ReplicatedStorage").Packages.ReactRoblox)

local function App(props)
    return React.createElement("ScreenGui", {}, {
        Hello = React.createElement("TextLabel", {
            Text = "Hello, " .. props.name,
            Size = UDim2.fromOffset(200, 50),
            TextScaled = true,
        }),
    })
end

local tree = React.createElement(App, { name = "Roblox" })

-- Create a root and render into PlayerGui
local playerGui = game:GetService("Players").LocalPlayer:WaitForChild("PlayerGui")
local root = ReactRoblox.createRoot(playerGui)
root:render(tree)
```

**Common Roblox instance props**:
- `Size`, `Position`, `AnchorPoint`, `BackgroundColor3`, `Transparency`
- `[React.Event.Activated]`, `[React.Event.MouseEnter]` — events
- `[React.Ref]` — get the underlying Instance reference
- `Children` table — pass as the 3rd arg of `createElement`

**Pitfalls to avoid**:
- Don't `createRoot` more than once for the same parent — leads to double rendering
- Don't forget to call `root:unmount()` on cleanup or you'll leak GUI instances
- React-Roblox 1.8.0 requires React 17.2.x from jsdotlua (not Roblox's older Roact)
- For Server-side UI (rare), don't use React-Roblox — it's client-only
