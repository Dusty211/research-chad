/**
 * Canonical error model for research-chad.
 *
 * - lib/ pure functions never throw for expected conditions; they return a
 *   Result<T> whose failure side carries an AppError.
 * - pipeline/ runs independent items through a bounded-concurrency pool and
 *   applies an all-or-nothing policy: any item failure raises a PipelineError
 *   carrying every failed item. Tools surface it as a structured error result.
 *   v1 always fails hard, never silently.
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

/** One failed item in a pipeline run: its input position and the error it threw. */
export interface PipelineFailure {
  /** Zero-based input index of the failed item. */
  index: number;
  /** Always an Error — non-Error rejections are normalized at the pool boundary. */
  error: Error;
}

/**
 * A pipeline run failed under the all-or-nothing policy. Carries every failed
 * item (input order) plus how many items were attempted before dispatch
 * stopped, so the message distinguishes one bad item from a systemic failure.
 */
export class PipelineError extends AppError {
  readonly code = "pipeline";
  readonly failures: PipelineFailure[];
  /** Total items in the batch. */
  readonly total: number;
  /** Items dispatched before the first failure stopped new dispatches. */
  readonly attempted: number;

  constructor(failures: PipelineFailure[], total: number, attempted: number) {
    super(formatPipelineError(failures, total, attempted));
    this.failures = failures;
    this.total = total;
    this.attempted = attempted;
  }
}

function formatPipelineError(
  failures: PipelineFailure[],
  total: number,
  attempted: number,
): string {
  const lines = failures.map(
    (f) => `  [${f.index + 1}/${total}] ${f.error.message}`,
  );
  return [
    `Pipeline failed: ${failures.length} of ${total} items errored (${attempted} attempted).`,
    ...lines,
  ].join("\n");
}
