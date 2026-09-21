/**
 * Derive the per-chunk byte budget from the model's available context.
 *
 * Calibrated so a 262144-token (256K) context yields ~200KB of chunk content,
 * the ratio validated in testing. The constant encodes: chars-per-token
 * for this corpus (~3.5) and the fraction of the window that is payload
 * (the rest is reserved for prompt scaffolding, system text, and output).
 */
const CHARS_PER_TOKEN = 3.5;
const CONTENT_FRACTION = 0.218;

/** The 256K-token context the calibration above was validated against. Tests use this as their reference availableContext. */
export const REFERENCE_AVAILABLE_CONTEXT = 262_144;

export function chunkBudgetBytes(availableContextTokens: number): number {
  return Math.floor(
    availableContextTokens * CHARS_PER_TOKEN * CONTENT_FRACTION,
  );
}
