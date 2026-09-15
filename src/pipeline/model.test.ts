import { describe, it, expect, vi } from "vitest";
import { generateChecked } from "./model.js";
import { ModelOutputError } from "../errors.js";
import type { GenerateCtx } from "./model.js";

function makeCtx(responses: string[]): GenerateCtx & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    generate: {
      text: vi.fn(async ({ prompt }: { prompt: string }) => {
        calls.push(prompt.length); // record identity of the prompt sent
        return { text: responses[calls.length - 1] };
      }),
    },
  };
}

const MODEL = { providerID: "p", id: "m" };
const check = (raw: string) =>
  raw === "good"
    ? ({ ok: true, value: 42 } as const)
    : ({ ok: false, error: new ModelOutputError("bad", raw) } as const);

describe("generateChecked", () => {
  it("returns the checked value on first success", async () => {
    const ctx = makeCtx(["good"]);
    const value = await generateChecked(ctx, MODEL, "prompt", check);
    expect(value).toBe(42);
    expect(ctx.calls).toHaveLength(1);
  });

  it("retries once with the identical prompt and succeeds", async () => {
    const ctx = makeCtx(["bad", "good"]);
    const value = await generateChecked(ctx, MODEL, "prompt", check);
    expect(value).toBe(42);
    // Both calls sent the same prompt (same length recorded).
    expect(ctx.calls).toEqual([6, 6]);
  });

  it("hard-fails after one retry with the second failure's error", async () => {
    const ctx = makeCtx(["bad1", "bad2"]);
    await expect(
      generateChecked(ctx, MODEL, "prompt", check),
    ).rejects.toMatchObject({
      code: "model_output",
      raw: "bad2",
    });
    expect(ctx.calls).toHaveLength(2);
  });
});
