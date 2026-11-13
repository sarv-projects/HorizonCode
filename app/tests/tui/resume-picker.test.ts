import { describe, expect, test } from "bun:test";
import { encodeDiffRuns, diffBuffers } from "../../src/tui/cellbuffer";
import {
  applyResumePickerKey,
  buildResumePickerFrame,
  formatResumePickerRelativeTime,
  formatResumePickerRow,
  formatResumePickerRowMeta,
  formatResumePickerSnippet,
  initialResumePickerState,
  resumePickerStateWithQuery,
} from "../../src/tui/resume-picker";
import type { ResumePickerItem } from "../../src/tui/resume-picker";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");

const FIXTURE: readonly ResumePickerItem[] = [
  {
    id: "s-one",
    title: "Alpha chat",
    created: "",
    updated: "2026-11-13T11:50:00.000Z",
    messageCount: 4,
  },
  {
    id: "s-two",
    title: "Beta fork",
    created: "",
    updated: "2026-11-13T10:00:00.000Z",
    snippet: "landlock fence",
    messageCount: 12,
    forkedFrom: { sessionId: "s-one", messageIndex: 3, parentSeq: 0 },
  },
  { id: "s-three", title: "Gamma", created: "", updated: "2026-11-10T12:00:00.000Z", messageCount: 0 },
];

function searchFixture(query: string, limit = 40): readonly ResumePickerItem[] {
  const q = query.trim().toLowerCase();
  const pool =
    q === ""
      ? FIXTURE
      : FIXTURE.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.id.toLowerCase().includes(q) ||
            (s.snippet ?? "").toLowerCase().includes(q),
        );
  return pool.slice(0, limit);
}

describe("resume-picker state", () => {
  test("filter narrows items and resets selection", () => {
    let state = initialResumePickerState(searchFixture);
    expect(state.items.length).toBe(3);
    const step = applyResumePickerKey(state, { kind: "filter", ch: "b" }, { listRows: 5, search: searchFixture });
    expect(step.outcome).toEqual({ kind: "pending" });
    expect(step.state.query).toBe("b");
    expect(step.state.items.map((s) => s.id)).toEqual(["s-two"]);
    expect(step.state.selectedIndex).toBe(0);
  });

  test("backspace rewinds query", () => {
    const base = resumePickerStateWithQuery(
      initialResumePickerState(searchFixture),
      "be",
      searchFixture,
    );
    const step = applyResumePickerKey(base, { kind: "backspace" }, { listRows: 5, search: searchFixture });
    expect(step.state.query).toBe("b");
  });

  test("arrow keys wrap and scroll", () => {
    let state = initialResumePickerState(searchFixture);
    const down = applyResumePickerKey(state, { kind: "down" }, { listRows: 2, search: searchFixture });
    state = down.state;
    expect(state.selectedIndex).toBe(1);
    const upWrap = applyResumePickerKey(state, { kind: "up" }, { listRows: 2, search: searchFixture });
    expect(upWrap.state.selectedIndex).toBe(0);
    const wrapEnd = applyResumePickerKey(upWrap.state, { kind: "up" }, { listRows: 2, search: searchFixture });
    expect(wrapEnd.state.selectedIndex).toBe(2);
    expect(wrapEnd.state.scrollOffset).toBe(1);
  });

  test("enter resumes and escape starts new", () => {
    const state = initialResumePickerState(searchFixture);
    const pick = applyResumePickerKey(state, { kind: "confirm" }, { listRows: 5, search: searchFixture });
    expect(pick.outcome).toEqual({ kind: "resume", sessionId: "s-one" });
    const esc = applyResumePickerKey(state, { kind: "dismiss" }, { listRows: 5, search: searchFixture });
    expect(esc.outcome).toEqual({ kind: "new" });
  });
});

describe("resume-picker layout", () => {
  test("relative time and message count formatters", () => {
    expect(formatResumePickerRelativeTime("2026-11-13T11:59:30.000Z", NOW)).toBe("now");
    expect(formatResumePickerRelativeTime("2026-11-13T10:00:00.000Z", NOW)).toBe("2h");
    expect(formatResumePickerRowMeta(FIXTURE[1]!, NOW)).toBe("2h · 12 msgs");
  });

  test("row marks current session and selection", () => {
    const rowSel = formatResumePickerRow(FIXTURE[1], "s-one", true, 72, NOW);
    expect(rowSel.startsWith(">")).toBe(true);
    expect(rowSel).toContain("s-two");
    expect(rowSel).toContain("12 msgs");
    expect(rowSel).toContain("2h");
    const rowCurrent = formatResumePickerRow(FIXTURE[0], "s-one", false, 60, NOW);
    expect(rowCurrent).toContain("*");
    expect(rowCurrent).toContain("s-one");
    expect(rowCurrent).toContain("4 msgs");
  });

  test("snippet merges fork preview and user-turn text", () => {
    const snip = formatResumePickerSnippet(FIXTURE[1]!, 80);
    expect(snip).toContain("fork s-one");
    expect(snip).toContain("msg 3");
    expect(snip).toContain("landlock");
  });

  test("buildResumePickerFrame paints filter and hits", () => {
    const state = resumePickerStateWithQuery(
      initialResumePickerState(searchFixture),
      "land",
      searchFixture,
    );
    const buf = buildResumePickerFrame({
      width: 80,
      height: 8,
      state,
      currentSessionId: "s-one",
    });
    const painted = encodeDiffRuns(diffBuffers(null, buf));
    expect(painted).toContain("Filter:");
    expect(painted).toContain("land");
    expect(painted).toContain("s-two");
    expect(painted).toContain("Resume");
    expect(painted).toContain("session");
    expect(painted).toContain("landlock");
    expect(painted).toContain("fence");
  });

  test("buildResumePickerFrame shows preview line under selected item", () => {
    const state = initialResumePickerState(searchFixture);
    state.selectedIndex = 1;
    const buf = buildResumePickerFrame({
      width: 72,
      height: 10,
      state,
      currentSessionId: "s-one",
    });
    const painted = encodeDiffRuns(diffBuffers(null, buf));
    expect(painted).toContain("landlock");
    expect(painted).toContain("fence");
  });
});
