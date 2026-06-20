---
name: Replica
version: "0.2.0"
source: github
repo: MadStudioRoblox/Replica
url: https://github.com/MadStudioRoblox/Replica
homepage: https://madstudioroblox.github.io/Replica/
category: roblox
package: stargamesstudio/replica@0.2.0
tags: [replication, state, server-authoritative]
---

> **Source:** This skill is the official README from [MadStudioRoblox/Replica](https://github.com/MadStudioRoblox/Replica) on GitHub.
> All credit goes to the original authors. Licensed under their respective licenses.
> Fetched on 2026-06-17.

> **⚠️ Wally distribution note:**
> The official `MadStudioRoblox/Replica` repo does NOT publish to Wally directly
> (no `wally.toml` in the repo). The Wally package `stargamesstudio/replica@0.2.0`
> is a **third-party fork** that re-publishes loleris' Replica module. The author
> attribution in the Wally metadata correctly lists "Loleris". If you want the
> canonical source, clone directly from the GitHub repo above and copy the
> ModuleScripts into your project manually.

---

# MAD STUDIO - Replica

Replica is a Roblox server to client state replication solution which lets the developer subscribe certain players to certain states.

Individual states in the Replica module are called "replicas". Replicas can only be created and changed server-side, both server
and client can connect cleanup tasks for the moment of replica destruction, state changes can trigger listeners on the client-side.

