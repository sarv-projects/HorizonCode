/**
 * markdown-tail-heal.ts — Group F streaming markdown tail-healing
 * (opencode patchmark `healStreamingInline` / `computeTailHeal` ADAPT).
 *
 * Pure prose-only helper: given an incomplete streaming markdown tail, report
 * the unclosed inline markers and append their closers so a partially-rendered
 * line does not flicker between raw markers and rendered text. No ANSI, no I/O,
 * no state. Escaped markers (`\*`) are ignored. Fenced code must be excluded by
 * the caller before calling this.
 */

type Marker = "**" | "*" | "~~" | "`";

/** Compute the unclosed inline markers, outermost first (LIFO closers). */
export function computeTailHeal(text: string): string[] {
  const stack: Marker[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 2; // escaped marker: skip the next char
      continue;
    }
    if (ch === "`") {
      // A backtick run is a single code span opener.
      let run = 1;
      while (text[i + run] === "`") run += 1;
      const tok = "`".repeat(Math.min(run, 3));
      const top = stack[stack.length - 1];
      if (top === tok) stack.pop();
      else stack.push(tok as Marker);
      i += run;
      continue;
    }
    if (ch === "*") {
      let run = 1;
      while (text[i + run] === "*") run += 1;
      const tok: Marker = run >= 2 ? "**" : "*";
      const top = stack[stack.length - 1];
      if (top === tok) stack.pop();
      else stack.push(tok);
      i += run;
      continue;
    }
    if (ch === "~" && text[i + 1] === "~") {
      const top = stack[stack.length - 1];
      if (top === "~~") stack.pop();
      else stack.push("~~");
      i += 2;
      continue;
    }
    i += 1;
  }
  // Closers are the reverse of the open stack (innermost closes first).
  return stack.slice().reverse() as string[];
}

/** Append closing markers for unclosed inline spans; complete text is unchanged. */
export function healStreamingInline(text: string): string {
  const closers = computeTailHeal(text);
  if (closers.length === 0) return text;
  return text + closers.join("");
}
