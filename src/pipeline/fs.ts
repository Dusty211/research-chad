import { readFile } from "node:fs/promises";
import { FsError } from "../errors.js";

/**
 * Read a UTF-8 file, converting any fs failure into an FsError that names the
 * path. Every corpus read in the pipeline goes through this so filesystem
 * failures carry a stable code instead of leaking as raw Node errors.
 */
export async function readFileChecked(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new FsError(`failed to read '${path}': ${String(error)}`);
  }
}
