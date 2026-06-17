---
name: React
version: 17.2.1
source: wally
package: jsdotlua/react@17.2.1
category: roblox
tags: [ui, react, declarative, components]
---

# React (for Roblox)

**What it is**: A port of React 17 to Luau, maintained by the jsdotlua project.
Lets you build Roblox UIs with JSX-like syntax (Roact JSX) and hooks.

**When to use**:
- Building complex, stateful UI (menus, HUDs, inventory grids, modals)
- You want component composition and reusable UI primitives
- You prefer React's mental model (props, hooks, re-renders) over imperative GUI code
- You need derived state with useMemo/useMemo

**Installation** (in `wally.toml`):
```toml
[dependencies]
React = "jsdotlua/react@17.2.1"
```

Note: To actually render React components into Roblox instances, you also need
**React-Roblox** (the renderer) — see `react-roblox.md`.

**Common pattern** (Luau with Roact JSX):
```lua
local React = require(game:GetService("ReplicatedStorage").Packages.React)
local e = React.createElement

local function Counter(props)
    local count, setCount = React.useState(0)
    return e("TextLabel", {
        Text = "Count: " .. count,
        Size = UDim2.fromOffset(200, 50),
        [React.Event.Activated] = function()
            setCount(count + 1)
        end,
    })
end
```

**Hooks available**:
- `useState`, `useReducer` — state
- `useEffect`, `useLayoutEffect` — side effects
- `useMemo`, `useCallback` — memoization
- `useRef` — mutable refs (e.g. for Instance references)
- `useContext` — context API

**Pitfalls to avoid**:
- Don't mutate state directly — always use the setter, or React won't re-render
- Effects run after render; if you need synchronous setup, use useLayoutEffect
- Don't call hooks conditionally (inside `if` or loops) — Rules of Hooks apply
- For Roblox-specific rendering (creating ScreenGui, etc.) you MUST use React-Roblox
