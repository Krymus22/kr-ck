---
name: wally-package-types CLI
version: "1.0.3"
source: github
repo: JohnnyMorganz/wally-package-types
url: https://github.com/JohnnyMorganz/wally-package-types
category: roblox
tags: [types, lsp, cli]
---

> **Source:** This skill is the official README from [JohnnyMorganz/wally-package-types](https://github.com/JohnnyMorganz/wally-package-types) on GitHub.
> All credit goes to the original authors. Licensed under their respective licenses.
> Fetched on 2026-06-17.

---

# Wally Package Types Fixer

A small tool which fixes the issue of [wally](https://github.com/UpliftGames/wally) thunks not including exported types, necessary for proper Luau type checking support.

The tool takes in a path to a Packages folder, as well as a path to a generated sourcemap, and attempts to retrieve the relevant types and append them to the top of the package thunk

Install your wally packages

```sh
wally install
```

Generate a sourcemap (Rojo 7.1.0+) using

```sh
rojo sourcemap default.project.json --output sourcemap.json
```

then run

```sh
wally-package-types --sourcemap sourcemap.json Packages/
```

