import { parse as parseYaml } from "yaml";
import { err, ok, TocParseError, type Result } from "../errors.js";
import type { EntryKind, Toc, TocEntry } from "../types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw YAML values are untyped by design
type Raw = any;

interface RawProject {
  /** Display metadata only — intentionally not carried into entries. */
  name?: unknown;
  dir?: unknown;
  docs?: Raw[] | null;
  conversations?: Raw[] | null;
}

/**
 * Resolve a TOC entry to its absolute file path. The filename in the TOC is
 * the identity — verbatim, no conventions. `kind` selects the subfolder:
 * docs live in <dir>/docs/, conversations in <dir>/summaries/.
 */
export function resolveEntryPath(
  baseDir: string,
  dir: string,
  kind: EntryKind,
  name: string,
): string {
  const sub = kind === "doc" ? "docs" : "summaries";
  return `${baseDir}/${dir}/${sub}/${name}`;
}

/**
 * Parse TOC.yaml text into entries. Pure — no fs, no ctx.
 * Unknown keys (e.g. legacy uuid/created_at) are ignored by design.
 */
export function parseToc(yamlText: string, baseDir: string): Result<Toc> {
  let data: unknown;
  try {
    data = parseYaml(yamlText);
  } catch (e) {
    return err(new TocParseError(`TOC is not valid YAML: ${String(e)}`));
  }

  if (typeof data !== "object" || data === null) {
    return err(new TocParseError("TOC root must be a mapping"));
  }
  const projects = (data as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) {
    return err(new TocParseError("TOC must have a 'projects' array"));
  }

  const entries: TocEntry[] = [];
  for (const [i, raw] of projects.entries()) {
    if (typeof raw !== "object" || raw === null) {
      return err(new TocParseError(`projects[${i}] must be a mapping`));
    }
    const p = raw as RawProject;
    // dir is the project's identity; name is display metadata we don't carry.
    if (typeof p.dir !== "string" || p.dir.length === 0) {
      return err(new TocParseError(`projects[${i}] requires string 'dir'`));
    }
    const projectDir: string = p.dir;

    const collect = (kind: EntryKind, items: Raw[] | null | undefined) => {
      for (const [j, item] of (items ?? []).entries()) {
        if (typeof item !== "object" || item === null) {
          return err(
            new TocParseError(`${projectDir} ${kind}[${j}] must be a mapping`),
          );
        }
        const name = item.name;
        if (typeof name !== "string" || name.length === 0) {
          return err(
            new TocParseError(
              `${projectDir} ${kind}[${j}] requires string 'name'`,
            ),
          );
        }
        const summary = Array.isArray(item.summary)
          ? item.summary.filter(
              (s: unknown): s is string => typeof s === "string",
            )
          : [];

        entries.push({
          kind,
          name,
          path: resolveEntryPath(baseDir, projectDir, kind, name),
          dir: projectDir,
          summary,
        });
      }
      return ok(entries);
    };

    const docsResult = collect("doc", p.docs);
    if (!docsResult.ok) return docsResult;
    const convosResult = collect("conversation", p.conversations);
    if (!convosResult.ok) return convosResult;
  }

  if (entries.length === 0) {
    return err(new TocParseError("TOC contains no entries"));
  }
  return ok({ entries });
}
