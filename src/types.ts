import type { JSONSchema4 } from "json-schema";

/** Local alias: ajv validates against the JSON Schema draft-07 surface. */
export type JSONSchema = JSONSchema4;

export type EntryKind = "doc" | "conversation";

/** One addressable item in the TOC: a doc or a conversation summary. */
export interface TocEntry {
  kind: EntryKind;
  /** The filename, verbatim — it is the entry's identity. No conventions. */
  name: string;
  /** Absolute file path, resolved by code — never by the model. */
  path: string;
  /** Project dir (relative to baseDir) — the project's identity. */
  dir: string;
  /** Pre-done summarization bullets from TOC.yaml. */
  summary: string[];
}

export interface Toc {
  entries: TocEntry[];
}

/** A packed group of entry blocks that fits one model call. */
export interface Chunk {
  index: number;
  total: number;
  text: string;
  byteLength: number;
  /** Paths of the entries contained in this chunk, in order. */
  paths: string[];
}

/** A line-boundary slice of a file that fits one model call. */
export interface Part {
  index: number;
  total: number;
  text: string;
  byteLength: number;
}

/** Final unit of value for the plugin's consumer. Same shape at both stages. */
export interface Hit {
  dir: string;
  path: string;
  name: string;
  kind: EntryKind;
  /** Which stage produced this hit. */
  depth: "toc" | "drilldown";
  /** A short multi-sentence reason (3-sentence ideal) for what this entry contains that pertains to the query, citing specific details. Validated to a shape floor only — see hasSentenceShape in validate.ts. */
  matchReason: string;
}

/** Model output for stage 1 (chunk scan): relevant entries with model-written matchReasons. */
export const CHUNK_RESULT_SCHEMA: JSONSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      path: { type: "string" },
      matchReason: { type: "string" },
    },
    required: ["path", "matchReason"],
    additionalProperties: false,
  },
  additionalItems: false,
};

/** Model output for one drilldown part in the overflow fold. */
export const DRILL_PART_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    relevant: { type: "boolean" },
    evidence: { type: ["string", "null"] },
  },
  required: ["relevant", "evidence"],
  additionalProperties: false,
};

/** Model output for a completed drilldown (single-part file or final fold). */
export const DRILL_RESULT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    match: { type: "boolean" },
    matchReason: { type: ["string", "null"] },
  },
  required: ["match", "matchReason"],
  additionalProperties: false,
};

/** Structured failure surfaced by tools. */
export interface ToolError {
  code: string;
  message: string;
}
