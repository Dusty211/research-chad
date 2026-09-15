import AjvDefault, { type ValidateFunction } from "ajv";
import { err, ok, ModelOutputError, type Result } from "../errors.js";
import {
  CHUNK_RESULT_SCHEMA,
  DRILL_PART_SCHEMA,
  DRILL_RESULT_SCHEMA,
  type Hit,
} from "../types.js";

// ajv's CJS/ESM interop double-wraps its default export; unwrap defensively so
// the import works under both Node and Bun.
type AjvCtor = new (opts?: { allErrors?: boolean; strict?: false }) => {
  compile(schema: unknown): ValidateFunction;
};
const Ajv = ((AjvDefault as unknown as { default?: AjvCtor }).default ??
  (AjvDefault as unknown as AjvCtor)) as AjvCtor;

const ajv = new Ajv({ allErrors: true, strict: false });

const chunkValidator: ValidateFunction = ajv.compile(CHUNK_RESULT_SCHEMA);
const drillPartValidator: ValidateFunction = ajv.compile(DRILL_PART_SCHEMA);
const drillResultValidator: ValidateFunction = ajv.compile(DRILL_RESULT_SCHEMA);

function parseJson(raw: string): Result<unknown> {
  try {
    return ok(JSON.parse(raw));
  } catch (e) {
    return err(
      new ModelOutputError(`model output is not valid JSON: ${String(e)}`, raw),
    );
  }
}

function describe(validator: ValidateFunction): string {
  const details = validator.errors
    ?.map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
  return `model output failed schema validation: ${details ?? "unknown"}`;
}

export interface ChunkHit {
  path: string;
  matchReason: string;
}

/** Model output for stage 1: JSON array of {path, matchReason}. Enforces the 3-sentence matchReason. */
export function parseChunkResult(raw: string): Result<ChunkHit[]> {
  const parsed = parseJson(raw);
  if (!parsed.ok) return parsed;
  if (!chunkValidator(parsed.value)) {
    return err(new ModelOutputError(describe(chunkValidator), raw));
  }
  for (const hit of parsed.value as ChunkHit[]) {
    const sentences = countSentences(hit.matchReason);
    if (sentences !== 3) {
      return err(
        new ModelOutputError(
          `matchReason must be exactly 3 sentences, got ${sentences}`,
          raw,
        ),
      );
    }
  }
  return ok(parsed.value as ChunkHit[]);
}

/** Model output for one drilldown part (overflow fold). */
export function parseDrillPartResult(
  raw: string,
): Result<{ relevant: boolean; evidence: string | null }> {
  const parsed = parseJson(raw);
  if (!parsed.ok) return parsed;
  if (!drillPartValidator(parsed.value)) {
    return err(new ModelOutputError(describe(drillPartValidator), raw));
  }
  return ok(parsed.value as { relevant: boolean; evidence: string | null });
}

export interface DrillResult {
  match: boolean;
  matchReason: string | null;
}

/** Model output for a completed drilldown. Enforces the 3-sentence matchReason when matching. */
export function parseDrillResult(raw: string): Result<DrillResult> {
  const parsed = parseJson(raw);
  if (!parsed.ok) return parsed;
  if (!drillResultValidator(parsed.value)) {
    return err(new ModelOutputError(describe(drillResultValidator), raw));
  }
  const value = parsed.value as DrillResult;
  if (value.match) {
    const sentences = countSentences(value.matchReason ?? "");
    if (sentences !== 3) {
      return err(
        new ModelOutputError(
          `matchReason must be exactly 3 sentences, got ${sentences}`,
          raw,
        ),
      );
    }
  }
  return ok(value);
}

/** Rough sentence count: split on terminal punctuation followed by whitespace or end. */
export function countSentences(text: string): number {
  const matches = text.trim().match(/[^.!?]+[.!?]+(\s|$)/g);
  return matches?.length ?? (text.trim().length > 0 ? 1 : 0);
}

/** A validated stage-2 result promoted to a Hit. */
export function toHit(
  entry: { dir: string; path: string; name: string; kind: Hit["kind"] },
  result: DrillResult,
): Hit {
  return {
    dir: entry.dir,
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
    depth: "drilldown",
    matchReason: result.matchReason ?? "",
  };
}
