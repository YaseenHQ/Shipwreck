import { structuredPatch } from "diff";

export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

export function diffHunks(
  oldText: string | null | undefined,
  newText: string,
): DiffHunk[] {
  try {
    const patch = structuredPatch("a", "b", oldText ?? "", newText, "", "", {
      context: 3,
    });
    return patch.hunks.map((h) => ({
      ...h,
      lines: h.lines.filter((l) => !l.startsWith("\\")),
    }));
  } catch {
    return [];
  }
}

export function diffStats(hunks: DiffHunk[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.startsWith("+")) add++;
      else if (l.startsWith("-")) del++;
    }
  return { add, del };
}
