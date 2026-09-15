/**
 * Canonical error model for research-chad.
 *
 * - lib/ pure functions never throw for expected conditions; they return a
 *   Result<T> whose failure side carries an AppError.
 * - pipeline/ wraps failures and propagates the first one up; tools surface
 *   it as a structured error result. v1 always fails hard, never silently.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T>(error: AppError): Result<T> {
  return { ok: false, error };
}

/** Base class for all expected application errors. `code` is stable and safe to branch on. */
export abstract class AppError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** TOC.yaml failed to parse or has an unexpected shape. */
export class TocParseError extends AppError {
  readonly code = "toc_parse";
}

/** An entry block or file part exceeds the chunk byte budget. */
export class ChunkBudgetError extends AppError {
  readonly code = "chunk_budget";
}

/** Model output was invalid after the single identical-prompt retry. Carries the raw output. */
export class ModelOutputError extends AppError {
  readonly code = "model_output";
  readonly raw: string;

  constructor(message: string, raw: string) {
    super(message);
    this.raw = raw;
  }
}
