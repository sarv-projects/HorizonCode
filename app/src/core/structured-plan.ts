/**
 * structured-plan.ts — port of plandex ParseSubtasks (Tier 1 #14).
 *
 * Source: repo_take/plandex/app/server/model/parse/subtasks.go:10-89
 * Adapted to TS. Parses a model reply's `### Tasks` section into numbered
 * subtasks with `Uses:` file lists, then builds STEP-SCOPED context: only the
 * files a given subtask declares, never the whole tree. No embeddings, no
 * authority, no network. Advisory prompt material only.
 */

export interface Subtask {
  title: string;
  description: string;
  usesFiles: string[];
}

/** Parse `### Tasks` (or `### Task`) into numbered subtasks with Uses: files. */
export function parseSubtasks(replyContent: string): Subtask[] {
  if (typeof replyContent !== "string") return [];
  const parts = replyContent.split("### Tasks");
  const section = parts.length >= 2 ? parts[1]! : replyContent.split("### Task")[1];
  if (section === undefined) return [];

  const subtasks: Subtask[] = [];
  let current: Subtask | undefined;
  let descLines: string[] = [];

  const flush = (): void => {
    if (current === undefined) return;
    current.description = descLines.join("\n");
    subtasks.push(current);
    current = undefined;
    descLines = [];
  };

  for (const raw of section.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (/^\d+\.\s/.test(line)) {
      flush();
      const dot = line.indexOf(". ");
      if (dot >= 0) {
        current = { title: line.slice(dot + 2), description: "", usesFiles: [] };
      }
      continue;
    }
    if (line.startsWith("Uses:")) {
      if (current !== undefined) {
        const uses = line.slice("Uses:".length);
        for (let use of uses.split(",")) {
          use = use.trim().replace(/^`+|`+$/g, "");
          if (use !== "") current.usesFiles.push(use);
        }
      }
      continue;
    }
    if (current !== undefined) {
      const text = line.replace(/^-/, "").trim();
      if (text !== "") descLines.push(text);
    }
  }
  flush();
  return subtasks;
}

/**
 * Build step-scoped context for one subtask: only its declared Uses files,
 * with missing files named explicitly (never silently dropped).
 */
export function stepScopedContext(
  subtask: Subtask,
  fileContents: ReadonlyMap<string, string>,
): string {
  const blocks: string[] = [`Step: ${subtask.title}`, subtask.description, "Uses (step-scoped):"];
  if (subtask.usesFiles.length === 0) {
    blocks.push("(none declared — no file context scoped for this step)");
  }
  for (const file of subtask.usesFiles) {
    const body = fileContents.get(file);
    if (body === undefined) {
      blocks.push(`--- ${file} (missing) ---\nFile not present in the provided context.`);
    } else {
      blocks.push(`--- ${file} ---\n${body}`);
    }
  }
  return blocks.filter((b) => b !== "").join("\n\n");
}

export function renderPlanSummary(subtasks: readonly Subtask[]): string {
  const lines = [`Plan: ${subtasks.length} subtask(s)`];
  subtasks.forEach((task, i) => {
    lines.push(`${i + 1}. ${task.title}${task.usesFiles.length > 0 ? ` [Uses: ${task.usesFiles.join(", ")}]` : ""}`);
  });
  return lines.join("\n");
}
