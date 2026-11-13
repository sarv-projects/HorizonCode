/**
 * Reduced kernel `fs.edit` repair (ruling **287**).
 *
 * Bun `edit.ts` runs NF-069/A-1…A-5 (relative indent, unicode fold, 3-way, line-patch).
 * Kernel + LocalKernel opt-in (`HZ_EFFECT_HOST_EDIT_REPAIR=1`) allow at most one extra
 * rung: trim `oldString`, then newline-normalised unique match — still fail-closed when
 * ambiguous or absent.
 */

export function effectHostEditRepairEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.HZ_EFFECT_HOST_EDIT_REPAIR?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let from = 0;
  let count = 0;
  while (from <= haystack.length) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    count += 1;
    from = i + needle.length;
  }
  return count;
}

export type KernelFsEditResolve =
  | { ok: true; oldString: string; start: number; end: number }
  | { ok: false; reason: "not_found" | "ambiguous" };

function uniqueSpan(haystack: string, needle: string): { start: number; end: number } | undefined {
  const n = countOccurrences(haystack, needle);
  if (n !== 1) return undefined;
  const start = haystack.indexOf(needle);
  return { start, end: start + needle.length };
}

/**
 * Map a span in newline-normalised text back to byte indices in the original string.
 */
function spanInOriginalFromNormalized(
  original: string,
  normStart: number,
  normLen: number,
): { start: number; end: number } | undefined {
  let normIdx = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (let i = 0; i <= original.length; ) {
    if (normIdx === normStart && start === undefined) start = i;
    if (normIdx === normStart + normLen) {
      end = i;
      break;
    }
    if (i < original.length && original.startsWith("\r\n", i)) {
      normIdx += 1;
      i += 2;
      continue;
    }
    if (i < original.length) {
      normIdx += 1;
      i += 1;
      continue;
    }
    if (normIdx === normStart + normLen) end = i;
    break;
  }
  if (start === undefined || end === undefined) return undefined;
  return { start, end };
}

function resolveNormalizedUnique(original: string, oldString: string): KernelFsEditResolve | undefined {
  const normContent = original.replace(/\r\n/g, "\n");
  const normOld = oldString.replace(/\r\n/g, "\n");
  if (normOld === "") return undefined;
  const span = uniqueSpan(normContent, normOld);
  if (!span) {
    const n = countOccurrences(normContent, normOld);
    if (n > 1) return { ok: false, reason: "ambiguous" };
    return undefined;
  }
  const mapped = spanInOriginalFromNormalized(original, span.start, normOld.length);
  if (!mapped) return undefined;
  return { ok: true, oldString: original.slice(mapped.start, mapped.end), start: mapped.start, end: mapped.end };
}

export function resolveKernelFsEditOldString(
  content: string,
  oldString: string,
  env: Record<string, string | undefined> = process.env,
): KernelFsEditResolve {
  const exact = uniqueSpan(content, oldString);
  if (exact) {
    return { ok: true, oldString, start: exact.start, end: exact.end };
  }
  const exactCount = countOccurrences(content, oldString);
  if (exactCount > 1) return { ok: false, reason: "ambiguous" };

  if (!effectHostEditRepairEnabled(env)) {
    return { ok: false, reason: "not_found" };
  }

  const trimmed = oldString.trim();
  if (trimmed !== oldString && trimmed !== "") {
    const trimSpan = uniqueSpan(content, trimmed);
    if (trimSpan) {
      return { ok: true, oldString: trimmed, start: trimSpan.start, end: trimSpan.end };
    }
    if (countOccurrences(content, trimmed) > 1) return { ok: false, reason: "ambiguous" };
  }

  const norm = resolveNormalizedUnique(content, oldString);
  if (norm) return norm;
  const normOld = oldString.replace(/\r\n/g, "\n");
  if (countOccurrences(content.replace(/\r\n/g, "\n"), normOld) > 1) {
    return { ok: false, reason: "ambiguous" };
  }
  return { ok: false, reason: "not_found" };
}
