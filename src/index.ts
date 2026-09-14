import { readFile } from "node:fs/promises";
import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "chad",
  setup(ctx) {
    ctx.tool.transform((editor) => {
      editor.add({
        name: "read_verbatim",
        description:
          "Read a local file and return its full content with no truncation.",
        input: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        async execute(input) {
          // 1. Narrow unknown -> our shape (the API types input as unknown on purpose;
          //    it does NOT infer from the JSON Schema, so we cast/validate by hand).
          const { path } = input as { path: string };

          // 2. Read the whole file with no truncation. node:fs/promises is
          //    portable across Node and Bun (Bun.file would not run in a plain
          //    Node test environment).
          const text = await readFile(path, "utf8");

          // 3. Return a Tool.Result — `content` is what the model receives.
          return { content: text };
        },
      });
    });
  },
});
