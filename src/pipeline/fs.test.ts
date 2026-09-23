import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileChecked } from "./fs.js";

describe("readFileChecked", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "research-chad-fs-"));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns the file content on success", async () => {
    const path = join(tmp, "ok.txt");
    await writeFile(path, "hello world", "utf8");
    expect(await readFileChecked(path)).toBe("hello world");
  });

  it("wraps a missing file in an FsError naming the path", async () => {
    const path = join(tmp, "missing.txt");
    await expect(readFileChecked(path)).rejects.toMatchObject({ code: "fs" });
    await expect(readFileChecked(path)).rejects.toThrow(/missing\.txt/);
  });
});
