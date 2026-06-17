---
name: ByteNet
version: 0.2.0
source: wally
package: ffrostflame/bytenet@0.2.0
category: roblox
tags: [networking, remote, serialization, typesafe]
---

# ByteNet

**What it is**: A type-safe networking library for Roblox that replaces manual
RemoteEvent/RemoteFunction boilerplate with declared request/response contracts.

**When to use**:
- You need client↔server RPCs with TypeScript-like type safety in Luau
- You want to avoid RemoteEvent name typos and mismatched argument shapes
- You need bidirectional streams (server → client push or client → server pull)
- You want automatic serialization of complex tables (vectors, instances, etc.)

**Installation** (in `wally.toml`):
```toml
[dependencies]
ByteNet = "ffrostflame/bytenet@0.2.0"
```

**Common pattern** (Luau):
```lua
local ByteNet = require(game:GetService("ReplicatedStorage").Packages.ByteNet)

local Protocol = ByteNet.defineProtocol({
    name = "GameProtocol",
    types = {
        Vector3 = ByteNet.serialized.struct({
            x = ByteNet.serialized.f32,
            y = ByteNet.serialized.f32,
            z = ByteNet.serialized.f32,
        }),
    },
    packets = {
        MovePlayer = ByteNet.packet({
            type = "reliable",
            data = function(t)
                return {
                    position = t.Vector3,
                }
            end,
        }),
    },
})

-- Server
Protocol.packets.MovePlayer:onReceive(function(player, data)
    -- data.position is typed
    player.Character:SetPrimaryPartCFrame(CFrame.new(data.position))
end)

-- Client
Protocol.packets.MovePlayer:send({
    position = Vector3.new(10, 0, 5),
})
```

**Pitfalls to avoid**:
- Don't share the protocol module as a normal ModuleScript — must be required via ByteNet
- Always declare packets as "reliable" or "unreliable" explicitly; defaults differ per version
- Send rate limit: don't fire reliable packets every frame; batch them
- ByteNet version 0.2.0 has breaking API changes from 0.1.x — read migration notes
