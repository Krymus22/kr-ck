import { describe, it, expect } from "vitest";
import { parseDiffBlocks, applyDiffs } from "../tools.js";

describe("parseDiffBlocks", () => {
  it("parses a single SEARCH/REPLACE block", () => {
    const diff = `<<<<<<< SEARCH
old code here
=======
new code here
>>>>>>> REPLACE`;

    const blocks = parseDiffBlocks(diff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("old code here");
    expect(blocks[0].replace).toBe("new code here");
  });

  it("parses multiple blocks", () => {
    const diff = `<<<<<<< SEARCH
first old
=======
first new
>>>>>>> REPLACE
<<<<<<< SEARCH
second old
=======
second new
>>>>>>> REPLACE`;

    const blocks = parseDiffBlocks(diff);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].search).toBe("first old");
    expect(blocks[0].replace).toBe("first new");
    expect(blocks[1].search).toBe("second old");
    expect(blocks[1].replace).toBe("second new");
  });

  it("returns empty array for invalid diff", () => {
    const blocks = parseDiffBlocks("no markers here");
    expect(blocks).toHaveLength(0);
  });

  it("handles empty search block (new file creation)", () => {
    const diff = `<<<<<<< SEARCH
=======
new file content
>>>>>>> REPLACE`;

    const blocks = parseDiffBlocks(diff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("");
    expect(blocks[0].replace).toBe("new file content");
  });

  it("handles multiline search and replace", () => {
    const diff = `<<<<<<< SEARCH
line 1
line 2
line 3
=======
replaced line 1
replaced line 2
>>>>>>> REPLACE`;

    const blocks = parseDiffBlocks(diff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("line 1\nline 2\nline 3");
    expect(blocks[0].replace).toBe("replaced line 1\nreplaced line 2");
  });
});

describe("applyDiffs", () => {
  it("replaces matching content", () => {
    const original = "function foo() {\n  return 1;\n}";
    const blocks = parseDiffBlocks(
      `<<<<<<< SEARCH
return 1;
=======
return 2;
>>>>>>> REPLACE`
    );

    const result = applyDiffs(original, blocks);
    expect(result.success).toBe(true);
    expect(result.content).toContain("return 2;");
    expect(result.content).not.toContain("return 1;");
  });

  it("returns failure when SEARCH block not found", () => {
    const original = "hello world";
    const blocks = parseDiffBlocks(
      `<<<<<<< SEARCH
nonexistent text
=======
replaced
>>>>>>> REPLACE`
    );

    const result = applyDiffs(original, blocks);
    expect(result.success).toBe(false);
    expect(result.errorBlock).toBe("nonexistent text");
  });

  it("prepends content for empty search block", () => {
    const original = "existing content";
    const blocks = parseDiffBlocks(
      `<<<<<<< SEARCH
=======
new prefix
>>>>>>> REPLACE`
    );

    const result = applyDiffs(original, blocks);
    expect(result.success).toBe(true);
    expect(result.content).toBe("new prefix\nexisting content");
  });

  it("replaces completely for empty search on empty file", () => {
    const original = "";
    const blocks = parseDiffBlocks(
      `<<<<<<< SEARCH
=======
brand new content
>>>>>>> REPLACE`
    );

    const result = applyDiffs(original, blocks);
    expect(result.success).toBe(true);
    expect(result.content).toBe("brand new content");
  });

  it("applies multiple blocks sequentially", () => {
    const original = "aaa\nbbb\nccc";
    const blocks = parseDiffBlocks(
      `<<<<<<< SEARCH
aaa
=======
aaa_first
>>>>>>> REPLACE
<<<<<<< SEARCH
ccc
=======
ccc_last
>>>>>>> REPLACE`
    );

    const result = applyDiffs(original, blocks);
    expect(result.success).toBe(true);
    expect(result.content).toContain("aaa_first");
    expect(result.content).toContain("ccc_last");
    expect(result.content).toContain("bbb");
  });
});
