import { AppError } from "./errors.js";

export interface ModelRef {
  providerID: string;
  id: string;
}

/**
 * Validated plugin options — the output of validateOptions, not the raw
 * opencode.jsonc config: the two inference knobs are optional in raw config
 * and always present here (defaults applied).
 */
export interface ChadOptions {
  /** Absolute path to TOC.yaml. */
  tocPath: string;
  /** Base directory that TOC project dirs are relative to. */
  baseDir: string;
  /** Model context window in tokens; drives the chunk byte budget. */
  availableContext: number;
  /** Model used for all generate calls. */
  model: ModelRef;
  /** Max concurrent model calls. Default 1 (sequential). */
  inferenceConcurrency: number;
  /** Min ms between dispatching new model calls. Default 0 (no throttle). */
  inferenceRateLimitMs: number;
}

export class OptionsError extends AppError {
  readonly code = "options";
}

/** Hard ceiling on inferenceConcurrency (see validateOptions). */
export const MAX_INFERENCE_CONCURRENCY = 10;

/** Validate raw ctx.options (typed unknown by the plugin API) into ChadOptions. */
export function validateOptions(raw: unknown): ChadOptions {
  if (typeof raw !== "object" || raw === null) {
    throw new OptionsError("plugin options must be an object");
  }
  const o = raw as Record<string, unknown>;

  const tocPath = o.tocPath;
  if (typeof tocPath !== "string" || tocPath.length === 0) {
    throw new OptionsError(
      "options.tocPath is required (absolute path to TOC.yaml)",
    );
  }
  const baseDir = o.baseDir;
  if (typeof baseDir !== "string" || baseDir.length === 0) {
    throw new OptionsError(
      "options.baseDir is required (base directory for TOC project dirs)",
    );
  }
  const availableContext = o.availableContext;
  if (
    typeof availableContext !== "number" ||
    !Number.isInteger(availableContext) ||
    availableContext <= 0
  ) {
    throw new OptionsError(
      "options.availableContext is required (positive integer, tokens)",
    );
  }
  const model = o.model as ModelRef | undefined;
  if (
    typeof model !== "object" ||
    model === null ||
    typeof model.providerID !== "string" ||
    typeof model.id !== "string"
  ) {
    throw new OptionsError("options.model is required ({ providerID, id })");
  }
  // Hard cap: in-flight calls are bounded by batch size anyway, so values far
  // above it only decide how fast an entire batch can fire at once — a cost and
  // rate-limit amplifier with no throughput benefit.
  const inferenceConcurrency = o.inferenceConcurrency;
  if (
    inferenceConcurrency !== undefined &&
    (typeof inferenceConcurrency !== "number" ||
      !Number.isInteger(inferenceConcurrency) ||
      inferenceConcurrency < 1 ||
      inferenceConcurrency > MAX_INFERENCE_CONCURRENCY)
  ) {
    throw new OptionsError(
      `options.inferenceConcurrency must be an integer between 1 and ${MAX_INFERENCE_CONCURRENCY} (default: 1)`,
    );
  }
  const inferenceRateLimitMs = o.inferenceRateLimitMs;
  if (
    inferenceRateLimitMs !== undefined &&
    (typeof inferenceRateLimitMs !== "number" ||
      !Number.isInteger(inferenceRateLimitMs) ||
      inferenceRateLimitMs < 0)
  ) {
    throw new OptionsError(
      "options.inferenceRateLimitMs must be a non-negative integer (default: 0)",
    );
  }

  return {
    tocPath,
    baseDir,
    availableContext,
    model,
    inferenceConcurrency: inferenceConcurrency ?? 1,
    inferenceRateLimitMs: inferenceRateLimitMs ?? 0,
  };
}
