---
name: TestEZ
version: "0.4.6"
source: github
repo: Roblox/testez
url: https://github.com/Roblox/testez
homepage: https://roblox.github.io/testez
category: roblox
tags: [testing, bdd, luau, framework, ci]
---

> **Source:** This skill is the official README from [Roblox/testez](https://github.com/Roblox/testez) on GitHub.
> All credit goes to the Roblox authors. Licensed under Apache 2.0.
> Fetched on 2026-06-18.

> **⚠️ Archived note:** Roblox/testez is archived (frozen March 2024) but still the canonical reference for BDD-style Luau testing. Active forks exist (e.g. `1Ax2/testez`, `vocksel/matter-testez`). API is stable; no breaking changes since 2021.

---

<h1 align="center">TestEZ</h1>
<div align="center">
	<a href="https://github.com/Roblox/testez/actions?query=workflow%3ACI">
		<img src="https://github.com/Roblox/testez/workflows/CI/badge.svg" alt="GitHub Actions Build Status" />
	</a>
	<a href="https://roblox.github.io/testez">
		<img src="https://img.shields.io/badge/docs-website-green.svg" alt="Documentation" />
	</a>
</div>

<div align="center">
	BDD-style Roblox Lua testing framework
</div>

<div>&nbsp;</div>

TestEZ can run within Roblox itself, as well as inside [Lemur](https://github.com/LPGhatguy/Lemur) for testing on CI systems.

We use TestEZ at Roblox for testing our apps, in-game core scripts, built-in Roblox Studio plugins, as well as libraries like [Roact](https://github.com/Roblox/roact) and [Rodux](https://github.com/Roblox/rodux).

It provides an API that can run all of your tests with a single method call as well as a more granular API that exposes each step of the pipeline.

## Inspiration and Prior Work
The `describe` and `it` syntax in TestEZ is based on the [Behavior-Driven Development](https://en.wikipedia.org/wiki/Behavior-driven_development) methodology, notably as implemented in RSpec (Ruby), busted (Lua), Mocha (JavaScript), and Ginkgo (Go).

The `expect` syntax is based on Chai, a JavaScript assertion library commonly used with Mocha. Similar expectation systems are also used in RSpec and Ginkgo, with slightly different syntax.

## Contributing
Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for information.

## License
TestEZ is available under the Apache 2.0 license. See [LICENSE](LICENSE) for details.
