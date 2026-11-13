import { describe, expect, test } from "bun:test";
import {
  effectHostEditRepairEnabled,
  resolveKernelFsEditOldString,
  renderKernelFsEditReplacement,
} from "../../src/core/effect-host-edit-repair";
import { restoreEnv, setEnv, snapshotEnv } from "./helpers";

describe("resolveKernelFsEditOldString", () => {
  test("exact match without repair flag", () => {
    const r = resolveKernelFsEditOldString("alpha-beta", "beta", {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.oldString).toBe("beta");
    }
  });

  test("trim repair behind HZ_EFFECT_HOST_EDIT_REPAIR", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
      expect(effectHostEditRepairEnabled()).toBe(true);
      const content = "xx hello world yy";
      const miss = resolveKernelFsEditOldString(content, "  hello world  ", {});
      expect(miss.ok).toBe(false);
      const hit = resolveKernelFsEditOldString(content, "  hello world  ", process.env);
      expect(hit.ok).toBe(true);
      if (hit.ok) expect(hit.oldString).toBe("hello world");
    } finally {
      restoreEnv(snap);
    }
  });

  test("relative-indent window reindents nested replacement under opt-in repair", () => {
    const content = "fn main() {\n    if ready {\n        emit();\n    }\n}\n";
    const old = "if ready {\n    emit();\n}";
    const miss = resolveKernelFsEditOldString(content, old, {});
    expect(miss.ok).toBe(false);
    const hit = resolveKernelFsEditOldString(content, old, { HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.indentPrefix).toBe("    ");
      expect(renderKernelFsEditReplacement("if ready {\n    send();\n}", hit, content)).toBe(
        "    if ready {\n        send();\n    }",
      );
    }
  });

  test("relative-indent duplicate windows refuse as ambiguous", () => {
    const content = "    if ready {\n        emit();\n    }\n  if ready {\n      emit();\n  }";
    const hit = resolveKernelFsEditOldString(content, "if ready {\n    emit();\n}", {
      HZ_EFFECT_HOST_EDIT_REPAIR: "1",
    });
    expect(hit).toEqual({ ok: false, reason: "ambiguous" });
  });

  test("per-line trim window repair (ruling 337)", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
      const content = "  alpha  \n  beta  \n";
      const miss = resolveKernelFsEditOldString(content, "alpha\nbeta", {});
      expect(miss.ok).toBe(false);
      const hit = resolveKernelFsEditOldString(content, "alpha\nbeta", process.env);
      expect(hit.ok).toBe(true);
      if (hit.ok) expect(hit.oldString).toBe("  alpha  \n  beta  ");
    } finally {
      restoreEnv(snap);
    }
  });

  test("per-line trimEnd window repair (ruling 335)", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
      const content = "alpha  \nbeta  \ngamma\n";
      const miss = resolveKernelFsEditOldString(content, "alpha\nbeta", {});
      expect(miss.ok).toBe(false);
      const hit = resolveKernelFsEditOldString(content, "alpha\nbeta", process.env);
      expect(hit.ok).toBe(true);
      if (hit.ok) expect(hit.oldString).toBe("alpha  \nbeta  ");
    } finally {
      restoreEnv(snap);
    }
  });

  test("per-line unicode-fold window repair (ruling 339)", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
      const content = "say \u2018hi\u2019\nnext\n";
      const miss = resolveKernelFsEditOldString(content, "say 'hi'\nnext", {});
      expect(miss.ok).toBe(false);
      const hit = resolveKernelFsEditOldString(content, "say 'hi'\nnext", process.env);
      expect(hit.ok).toBe(true);
      if (hit.ok) expect(hit.oldString).toBe("say \u2018hi\u2019\nnext");
    } finally {
      restoreEnv(snap);
    }
  });

  test("three-way trim window rebases replacement and preserves CRLF", () => {
    const content = "header\r\n    begin  \r\n        call(1);   \r\n    end\r\nfooter\r\n";
    const old = "begin\n    call(1);\nend";
    const hit = resolveKernelFsEditOldString(content, old, { HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.indentPrefix).toBe("    ");
      expect(renderKernelFsEditReplacement("begin\n    call(2);\nend", hit, content)).toBe(
        "    begin\r\n        call(2);\r\n    end",
      );
    }
  });

  test("line-patch anchored window rebases a unique changed middle", () => {
    const content = "top\n  begin\n    unexpected();\n  end\nbottom\n";
    const old = "begin\n    expected();\nend";
    expect(resolveKernelFsEditOldString(content, old, {})).toEqual({ ok: false, reason: "not_found" });
    const hit = resolveKernelFsEditOldString(content, old, { HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.indentPrefix).toBe("  ");
      expect(renderKernelFsEditReplacement("begin\n    replacement();\nend", hit, content)).toBe(
        "  begin\n      replacement();\n  end",
      );
    }
  });

  test("line-patch refuses indistinguishable anchor pairs", () => {
    const content = "  begin\n  first();\n  end\n  begin\n  second();\n  end\n";
    expect(resolveKernelFsEditOldString(content, "begin\nunknown();\nend", {
      HZ_EFFECT_HOST_EDIT_REPAIR: "1",
    })).toEqual({ ok: false, reason: "ambiguous" });
  });

  test("newline normalisation repair", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
      const content = "line\r\nnext";
      const r = resolveKernelFsEditOldString(content, "line\nnext", process.env);
      expect(r.ok).toBe(true);
    } finally {
      restoreEnv(snap);
    }
  });

  test("ambiguous stays fail-closed", () => {
    const r = resolveKernelFsEditOldString("aaa", "a", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ambiguous");
  });
});
