/**
 * Structural call-site reach for Engineering Brain critic (ruling **727** slice).
 *
 * BEST-EFFORT parenthesis-aware occurrence scan (string/comment/template aware).
 * Counts optional `symbol?.()`, a newline between the name and `(`, and calls
 * inside `${...}` interpolations. Not tree-sitter / not a full AST call-graph.
 */

const IDENT_TAIL = /[\w$]/;

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && IDENT_TAIL.test(ch);
}

/** Skip `<...>` generic actuals; returns index after `>` or original if unbalanced. */
function skipGenericArgs(text: string, start: number): number {
  if (text[start] !== "<") return start;
  let depth = 0;
  let state: "code" | "single" | "double" | "template" = "code";
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (state === "code") {
      if (ch === "<") depth++;
      else if (ch === ">") {
        depth--;
        if (depth === 0) return i + 1;
      } else if (ch === "'") state = "single";
      else if (ch === '"') state = "double";
      else if (ch === "`") state = "template";
    } else if (state === "single") {
      if (!escaped && ch === "'") state = "code";
      escaped = !escaped && ch === "\\";
    } else if (state === "double") {
      if (!escaped && ch === '"') state = "code";
      escaped = !escaped && ch === "\\";
    } else if (state === "template") {
      if (!escaped && ch === "`") state = "code";
      escaped = !escaped && ch === "\\";
    }
  }
  return start;
}

/** Line text strictly before an identifier (keeps trailing whitespace on decl keywords). */
const DECL_BEFORE_IDENT =
  /\b(?:export\s+(?:default\s+)?(?:async\s+)?)?(?:function|class|interface|type|enum)\s+$|\b(?:export\s+)?(?:const|let|var)\s+$|\bimport\s+$|\bfrom\s+$/;

function linePrefixBefore(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  return text.slice(lineStart, index);
}

/** Skip whitespace, one optional `?.`, and a `<...>` generic list before `(`. */
function skipCallGap(text: string, start: number): number {
  const gap = (index: number): number => {
    let j = index;
    while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\n" || text[j] === "\r")) j++;
    return j;
  };
  let j = gap(start);
  if (text.startsWith("?.", j)) j = gap(j + 2);
  j = skipGenericArgs(text, j);
  return gap(j);
}

/** Count `symbol(` call sites in source text (not comments/strings; not declarations). */
export function countStructuralCallSites(text: string, symbol: string): number {
  if (symbol.length === 0) return 0;
  let count = 0;
  let state: "code" | "lineComment" | "blockComment" | "single" | "double" | "template" = "code";
  let escaped = false;
  let interp = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (state === "lineComment") {
      if (ch === "\n") state = "code";
      continue;
    }
    if (state === "blockComment") {
      if (ch === "*" && text[i + 1] === "/") {
        state = "code";
        i++;
      }
      continue;
    }
    if (state === "single") {
      if (!escaped && ch === "'") state = "code";
      escaped = !escaped && ch === "\\";
      continue;
    }
    if (state === "double") {
      if (!escaped && ch === '"') state = "code";
      escaped = !escaped && ch === "\\";
      continue;
    }
    if (state === "template") {
      if (!escaped && ch === "`") state = "code";
      else if (!escaped && ch === "$" && text[i + 1] === "{") {
        state = "code";
        interp = 1;
        i++;
      }
      escaped = !escaped && ch === "\\";
      continue;
    }
    if (interp > 0) {
      if (ch === "{") interp++;
      else if (ch === "}") {
        interp--;
        if (interp === 0) {
          state = "template";
          continue;
        }
      }
    }
    if (ch === "/" && text[i + 1] === "/") {
      state = "lineComment";
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      state = "blockComment";
      i++;
      continue;
    }
    if (ch === "'") {
      state = "single";
      continue;
    }
    if (ch === '"') {
      state = "double";
      continue;
    }
    if (ch === "`") {
      state = "template";
      continue;
    }
    if (!text.startsWith(symbol, i)) continue;
    const before = i === 0 ? undefined : text[i - 1];
    const after = text[i + symbol.length];
    if (isIdentChar(before) || isIdentChar(after)) continue;
    const j = skipCallGap(text, i + symbol.length);
    if (text[j] !== "(") continue;
    const prefix = linePrefixBefore(text, i);
    if (DECL_BEFORE_IDENT.test(prefix)) continue;
    count++;
  }
  return count;
}

/** True when other files contain structural call sites to an exported symbol. */
export function fileHasStructuralCall(text: string, symbol: string): boolean {
  return countStructuralCallSites(text, symbol) > 0;
}