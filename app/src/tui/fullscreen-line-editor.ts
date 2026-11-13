/**
 * fullscreen-line-editor.ts — minimal raw-key line editor (docs/33 §5.17).
 *
 * Printable ASCII, backspace, enter, and Ctrl+C only.
 */

export interface LineEditorState {
  text: string;
}

export type LineEditorAction =
  | { kind: "noop" }
  | { kind: "insert"; ch: string }
  | { kind: "backspace" }
  | { kind: "submit" }
  | { kind: "interrupt" };

export function lineEditorStep(state: LineEditorState, key: number): { state: LineEditorState; action: LineEditorAction } {
  if (key === 3) return { state, action: { kind: "interrupt" } };
  if (key === 13 || key === 10) return { state, action: { kind: "submit" } };
  if (key === 127 || key === 8) {
    if (state.text.length === 0) return { state, action: { kind: "noop" } };
    return { state: { text: state.text.slice(0, -1) }, action: { kind: "backspace" } };
  }
  if (key >= 0x20 && key <= 0x7e) {
    const ch = String.fromCharCode(key);
    return { state: { text: state.text + ch }, action: { kind: "insert", ch } };
  }
  return { state, action: { kind: "noop" } };
}

/** Apply one byte; convenience for tests and the event loop. */
export function applyEditorKey(text: string, key: number): { text: string; action: LineEditorAction } {
  const next = lineEditorStep({ text }, key);
  return { text: next.state.text, action: next.action };
}
