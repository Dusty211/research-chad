import { describe, it, expect, vi } from "vitest";
import { generateChecked } from "./model.js";
import { ModelOutputError } from "../errors.js";
import type { GenerateCtx } from "./model.js";

interface RecordedCall {
  model: { providerID: string; id: string };
  prompt: string;
}

function makeCtx(responses: string[]): GenerateCtx & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    generate: {
      text: vi.fn(async ({ model, prompt }) => {
        calls.push({ model, prompt });
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
    expect(ctx.calls[0].model).toEqual(MODEL);
  });

  it("retries once with the identical prompt and succeeds", async () => {
    const ctx = makeCtx(["bad", "good"]);
    const value = await generateChecked(ctx, MODEL, "prompt", check);
    expect(value).toBe(42);
    // Both calls sent the same model and the exact same prompt.
    expect(ctx.calls.map((c) => c.model)).toEqual([MODEL, MODEL]);
    expect(ctx.calls.map((c) => c.prompt)).toEqual(["prompt", "prompt"]);
  });

  it("retries a schema-violation failure once with the identical prompt", async () => {
    // A schema violation is a model-output failure like any other: the same
    // re-roll policy applies. First output fails, second passes.
    const ctx = makeCtx(["{ not valid json", "good"]);
    const value = await generateChecked(ctx, MODEL, "prompt", check);
    expect(value).toBe(42);
    expect(ctx.calls).toHaveLength(2);
    expect(ctx.calls.map((c) => c.prompt)).toEqual(["prompt", "prompt"]);
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
