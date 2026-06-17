---
name: Signal
version: 0.4.0
source: wally
package: sleitnick/signal@0.4.0
category: roblox
tags: [events, signal, callback, rbxscriptsignal]
---

# Signal

**What it is**: A simple, leak-resistant signal implementation for Luau —
a replacement for `Instance.new("BindableEvent")` with cleaner semantics and
no memory leaks across multiple `:Connect()` calls.

**When to use**:
- You need a custom event for module-to-module communication
- You want `:Wait()` support (yielding until the signal fires)
- You want connections to be cleaned up automatically when the signal is destroyed
- You're replacing RBXScriptSignal boilerplate

**Installation** (in `wally.toml`):
```toml
[dependencies]
Signal = "sleitnick/signal@0.4.0"
```

**Common pattern** (Luau):
```lua
local Signal = require(game:GetService("ReplicatedStorage").Packages.Signal)

-- Create
local onCoinChanged = Signal.new()

-- Connect (returns a connection object)
local conn = onCoinChanged:Connect(function(newAmount, oldAmount)
    print("Coins changed:", oldAmount, "->", newAmount)
end)

-- Fire
onCoinChanged:Fire(100, 50)

-- Disconnect
conn:Disconnect()

-- Or yield until next fire (in a coroutine)
task.spawn(function()
    local newAmount = onCoinChanged:Wait()
    print("Got:", newAmount)
end)
```

**API summary**:
- `Signal.new()` — create a new signal
- `signal:Connect(fn)` — returns a connection
- `signal:Fire(...)` — invoke all connected handlers (sync, in order)
- `signal:Wait()` — yields current thread until next fire; returns args
- `signal:DisconnectAll()` — disconnect everything
- `signal:Destroy()` — disconnect all + mark signal as dead

**Pitfalls to avoid**:
- Handlers fire synchronously — don't do heavy work in `:Fire()` or you'll stall
- `:Wait()` only catches the NEXT fire; if you need every fire, use `:Connect()`
- Don't connect the same fn twice expecting dedup — both will fire
- For per-frame events (RenderStepped), prefer the native RBXScriptSignal instead
