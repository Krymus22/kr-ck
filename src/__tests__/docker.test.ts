import { describe, it, expect, vi } from "vitest";
import { DOCKER_TOOLS } from "../tools/docker.js";

vi.mock("../externalTools.js", () => ({}));
vi.mock("../logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../tools/index.js", () => ({}));
vi.mock("../guardrail.js", () => ({ checkGuardrails: vi.fn() }));
vi.mock("../diffPreview.js", () => ({ generateDiffPreview: vi.fn() }));
vi.mock("../hooks.js", () => ({ executeHooks: vi.fn() }));
vi.mock("child_process", () => ({ execSync: vi.fn() }));
vi.mock("./fileEdit.js", () => ({}));

describe("DOCKER_TOOLS", () => {
  it("should be an array", () => {
    expect(Array.isArray(DOCKER_TOOLS)).toBe(true);
  });

  it("should have 11 tools", () => {
    expect(DOCKER_TOOLS).toHaveLength(11);
  });

  it("should have unique tool names", () => {
    const names = DOCKER_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all tools should have category 'docker'", () => {
    DOCKER_TOOLS.forEach((t) => expect(t.category).toBe("docker"));
  });

  it("all tools should have detection.method 'binary'", () => {
    DOCKER_TOOLS.forEach((t) => expect(t.detection.method).toBe("binary"));
  });

  it("all tools should have detection.check 'docker --version'", () => {
    DOCKER_TOOLS.forEach((t) => expect(t.detection.check).toBe("docker --version"));
  });

  it("all tools should have command 'docker'", () => {
    DOCKER_TOOLS.forEach((t) => expect(t.command).toBe("docker"));
  });

  it("all tools should have context.whenToUse non-empty", () => {
    DOCKER_TOOLS.forEach((t) => {
      expect(Array.isArray(t.context.whenToUse)).toBe(true);
      expect(t.context.whenToUse.length).toBeGreaterThan(0);
    });
  });

  it("all tools should have context.examples non-empty", () => {
    DOCKER_TOOLS.forEach((t) => {
      expect(Array.isArray(t.context.examples)).toBe(true);
      expect(t.context.examples.length).toBeGreaterThan(0);
    });
  });

  it("all tools should have outputParser 'raw'", () => {
    DOCKER_TOOLS.forEach((t) => expect(t.outputParser).toBe("raw"));
  });

  describe("docker_build", () => {
    const t = DOCKER_TOOLS.find((t) => t.name === "docker_build")!;
    it("should exist", () => expect(t).toBeDefined());
    it("should have args ['build']", () => expect(t.args).toEqual(["build"]));
    it("should have required -t flag", () =>
      expect(t.flags.find((f) => f.name === "-t" && f.required)).toBeDefined());
    it("should have -f flag", () =>
      expect(t.flags.find((f) => f.name === "-f")).toBeDefined());
    it("should have --build-arg flag", () =>
      expect(t.flags.find((f) => f.name === "--build-arg")).toBeDefined());
    it("should have --no-cache boolean flag", () =>
      expect(t.flags.find((f) => f.name === "--no-cache" && f.type === "boolean")).toBeDefined());
    it("should require Dockerfile in project", () =>
      expect(t.context.requiresProject).toContain("Dockerfile"));
  });

  describe("docker_run", () => {
    const t = DOCKER_TOOLS.find((t) => t.name === "docker_run")!;
    it("should exist", () => expect(t).toBeDefined());
    it("should have args ['run']", () => expect(t.args).toEqual(["run"]));
    it("should have -d boolean flag", () =>
      expect(t.flags.find((f) => f.name === "-d" && f.type === "boolean")).toBeDefined());
    it("should have --name string flag", () =>
      expect(t.flags.find((f) => f.name === "--name" && f.type === "string")).toBeDefined());
    it("should have -p port flag", () =>
      expect(t.flags.find((f) => f.name === "-p")).toBeDefined());
    it("should have -v volume flag", () =>
      expect(t.flags.find((f) => f.name === "-v")).toBeDefined());
    it("should have --rm boolean flag", () =>
      expect(t.flags.find((f) => f.name === "--rm" && f.type === "boolean")).toBeDefined());
    it("should have -e env flag", () =>
      expect(t.flags.find((f) => f.name === "-e")).toBeDefined());
  });

  describe("docker_compose_up", () => {
    const t = DOCKER_TOOLS.find((t) => t.name === "docker_compose_up")!;
    it("should exist", () => expect(t).toBeDefined());
    it("should have args ['compose', 'up']", () => expect(t.args).toEqual(["compose", "up"]));
    it("should have -d boolean flag", () =>
      expect(t.flags.find((f) => f.name === "-d" && f.type === "boolean")).toBeDefined());
    it("should have --build boolean flag", () =>
      expect(t.flags.find((f) => f.name === "--build" && f.type === "boolean")).toBeDefined());
    it("should have --force-recreate flag", () =>
      expect(t.flags.find((f) => f.name === "--force-recreate")).toBeDefined());
    it("should require docker-compose.yml", () =>
      expect(t.context.requiresProject).toContain("docker-compose.yml"));
  });

  describe("docker_compose_down", () => {
    const t = DOCKER_TOOLS.find((t) => t.name === "docker_compose_down")!;
    it("should exist", () => expect(t).toBeDefined());
    it("should have args ['compose', 'down']", () => expect(t.args).toEqual(["compose", "down"]));
    it("should have --volumes flag", () =>
      expect(t.flags.find((f) => f.name === "--volumes")).toBeDefined());
    it("should have --rmi flag", () =>
      expect(t.flags.find((f) => f.name === "--rmi")).toBeDefined());
    it("should require docker-compose.yml", () =>
      expect(t.context.requiresProject).toContain("docker-compose.yml"));
  });

  describe("docker_ps", () => {
    const t = DOCKER_TOOLS.find((t) => t.name === "docker_ps")!;
    it("should exist", () => expect(t).toBeDefined());
    it("should have args ['ps']", () => expect(t.args).toEqual(["ps"]));
    it("should have -a flag", () =>
      expect(t.flags.find((f) => f.name === "-a" && f.type === "boolean")).toBeDefined());
    it("should have --format flag", () =>
      expect(t.flags.find((f) => f.name === "--format")).toBeDefined());
  });

  describe("docker_logs", () => {
    const t = DOCKER_TOOLS.find((t) => t.name === "docker_logs")!;
    it("should exist", () => expect(t).toBeDefined());
    it("should have args ['logs']", () => expect(t.args).toEqual(["logs"]));
    it("should have required container flag", () =>
      expect(t.flags.find((f) => f.name === "container" && f.required)).toBeDefined());
    it("should have -f follow flag", () =>
      expect(t.flags.find((f) => f.name === "-f" && f.type === "boolean")).toBeDefined());
    it("should have --tail flag", () =>
      expect(t.flags.find((f) => f.name === "--tail")).toBeDefined());
  });

  describe("docker_exec", () => {
    const t = DOCKER_TOOLS.find((t) => t.name === "docker_exec")!;
    it("should exist", () => expect(t).toBeDefined());
    it("should have args ['exec']", () => expect(t.args).toEqual(["exec"]));
    it("should have -it flag", () =>
      expect(t.flags.find((f) => f.name === "-it" && f.type === "boolean")).toBeDefined());
    it("should have required container flag", () =>
      expect(t.flags.find((f) => f.name === "container" && f.required)).toBeDefined());
    it("should have required command flag", () =>
      expect(t.flags.find((f) => f.name === "command" && f.required)).toBeDefined());
  });

  describe("docker_images", () => {
    const t = DOCKER_TOOLS.find((t) => t.name === "docker_images")!;
    it("should exist", () => expect(t).toBeDefined());
    it("should have args ['images']", () => expect(t.args).toEqual(["images"]));
    it("should have -a flag", () =>
      expect(t.flags.find((f) => f.name === "-a" && f.type === "boolean")).toBeDefined());
  });

  describe("docker_pull", () => {
    const t = DOCKER_TOOLS.find((t) => t.name === "docker_pull")!;
    it("should exist", () => expect(t).toBeDefined());
    it("should have args ['pull']", () => expect(t.args).toEqual(["pull"]));
    it("should have required image flag", () =>
      expect(t.flags.find((f) => f.name === "image" && f.required)).toBeDefined());
  });

  describe("docker_push", () => {
    const t = DOCKER_TOOLS.find((t) => t.name === "docker_push")!;
    it("should exist", () => expect(t).toBeDefined());
    it("should have args ['push']", () => expect(t.args).toEqual(["push"]));
    it("should have required image flag", () =>
      expect(t.flags.find((f) => f.name === "image" && f.required)).toBeDefined());
  });

  describe("docker_prune", () => {
    const t = DOCKER_TOOLS.find((t) => t.name === "docker_prune")!;
    it("should exist", () => expect(t).toBeDefined());
    it("should have args ['system', 'prune']", () => expect(t.args).toEqual(["system", "prune"]));
    it("should have -a flag", () =>
      expect(t.flags.find((f) => f.name === "-a" && f.type === "boolean")).toBeDefined());
    it("should have --volumes flag", () =>
      expect(t.flags.find((f) => f.name === "--volumes" && f.type === "boolean")).toBeDefined());
    it("should have -f force flag", () =>
      expect(t.flags.find((f) => f.name === "-f" && f.type === "boolean")).toBeDefined());
  });
});
