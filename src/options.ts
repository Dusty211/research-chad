import { AppError } from "./errors.js";

export interface ModelRef {
  providerID: string;
  id: string;
}

/** Plugin options, read from the object form in opencode.jsonc. */
export interface ChadOptions {
  /** Absolute path to TOC.yaml. */
  tocPath: string;
  /** Base directory that TOC project dirs are relative to. */
  baseDir: string;
  /** Model context window in tokens; drives the chunk byte budget. */
  availableContext: number;
  /** Model used for all generate calls. */
  model: ModelRef;
}

export class OptionsError extends AppError {
  readonly code = "options";
}

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

  return { tocPath, baseDir, availableContext, model };
}
