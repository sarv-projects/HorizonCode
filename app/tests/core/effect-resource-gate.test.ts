import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { EffectHost, createEffectId } from "../../src/core/effect-host";
import {
  frozenUnknownResourceKeys,
  isR170MutatingTool,
  mutationResourceTargets,
  mutatingToolResourceKey,
  observePendingResourceKeys,
  observePendingTargetForTool,
  r170ResourceGateRefusal,
  shellExplicitResourceTarget,
  unknownEffectIdsForResourceKey,
} from "../../src/core/effect-resource-gate";
import { registerMcpTools, clearMcpTools } from "../../src/core/mcp/registry";

describe("effect-resource-gate (R170 reduced)", () => {
  const workspace = path.resolve("/tmp/hz-r170-ws");

  test("mutatingToolResourceKey resolves write path", () => {
    const key = mutatingToolResourceKey("write", { path: "src/a.ts" }, workspace);
    expect(key).toBe(path.resolve(workspace, "src/a.ts"));
  });

  test("blocks second write on same path when prior effect unknown", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const resource = path.resolve(workspace, "b.txt");
    host.begin(effectId, "write", "call-1");
    host.recordAllow(effectId);
    host.recordObserve(effectId, {
      receiptId: "r1",
      receiptSeq: 1,
      resourceKey: resource,
    });
    expect(host.reconcileEffect(effectId)).toBe("unknown");

    const frozen = frozenUnknownResourceKeys(host);
    expect(frozen.has(resource)).toBe(true);

    const refusal = r170ResourceGateRefusal(
      "edit",
      { path: "b.txt" },
      workspace,
      frozen,
      host,
    );
    expect(refusal).toContain("blocked_by_unknown");
    expect(refusal).toContain(resource);
    expect(refusal).toContain("driving UNKNOWN effect(s)");
    expect(refusal).toContain(effectId.slice(0, 13));
    expect(unknownEffectIdsForResourceKey(host, resource)).toEqual([effectId]);
  });

  test("blocks ast_edit on same path when prior effect unknown (ruling 317)", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const resource = path.resolve(workspace, "struct.ts");
    host.begin(effectId, "write", "call-1");
    host.recordAllow(effectId);
    host.recordObserve(effectId, { receiptId: "r1", receiptSeq: 1, resourceKey: resource });
    const frozen = frozenUnknownResourceKeys(host);
    const key = mutatingToolResourceKey("ast_edit", { path: "struct.ts", pat: "x", out: "y" }, workspace);
    expect(key).toBe(resource);
    const refusal = r170ResourceGateRefusal(
      "ast_edit",
      { path: "struct.ts", pat: "x", out: "y" },
      workspace,
      frozen,
      host,
    );
    expect(refusal).toContain("blocked_by_unknown");
    expect(refusal).toContain(effectId.slice(0, 13));
  });

  test("observePendingTargetForTool shell uses explicit cwd not default workspace (ruling 336)", () => {
    expect(observePendingTargetForTool("shell", { command: "pwd" }, workspace)).toBeUndefined();
    expect(shellExplicitResourceTarget({ command: "pwd" }, workspace)).toBeUndefined();
    expect(observePendingTargetForTool("shell", { command: "pwd", cwd: "pkg" }, workspace)).toBe(
      path.resolve(workspace, "pkg"),
    );
    expect(observePendingTargetForTool("write", { path: "a.ts" }, workspace)).toBe(
      path.resolve(workspace, "a.ts"),
    );
  });

  test("observePendingResourceKeys tracks execute without observe (ruling 333)", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const resource = path.resolve(workspace, "inflight.ts");
    host.begin(effectId, "write", "call-1");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true, resourceKey: resource });
    const pending = observePendingResourceKeys(host);
    expect(pending.get(resource)).toEqual([effectId]);
    host.recordObserve(effectId, { receiptId: "r2", receiptSeq: 2, resourceKey: resource });
    expect(observePendingResourceKeys(host).size).toBe(0);
  });

  test("multi-file apply_patch cannot bypass in-run UNKNOWN with a disjoint final projection", () => {
    const hot = path.resolve(workspace, "hot.ts");
    const patch = "*** Begin Patch\n*** Add File: hot.ts\n+hot\n*** Add File: cold.ts\n+cold\n*** End Patch";
    const refusal = r170ResourceGateRefusal(
      "apply_patch", { input: patch }, workspace, new Set([hot]),
    );
    expect(refusal).toContain("blocked_by_unknown");
    expect(refusal).toContain(hot);
  });

  test("SQLite mutators are R170 mutating and fail-closed on UNKNOWN (ruling 690)", () => {
    expect(isR170MutatingTool("memory_remember")).toBe(true);
    expect(isR170MutatingTool("handoff_create")).toBe(true);
    expect(mutationResourceTargets("memory_remember", { text: "x" }, workspace)).toBeUndefined();
    const host = new EffectHost();
    const effectId = createEffectId();
    const resource = path.resolve(workspace, "sqlite-u.txt");
    host.begin(effectId, "write", "call-sql");
    host.recordAllow(effectId);
    host.recordObserve(effectId, { receiptId: "r-sql", receiptSeq: 1, resourceKey: resource });
    const frozen = frozenUnknownResourceKeys(host);
    const refusal = r170ResourceGateRefusal(
      "memory_remember",
      { text: "note" },
      workspace,
      frozen,
      host,
    );
    expect(refusal).toContain("blocked_by_unknown");
    expect(refusal).toContain("unknown resource target");
  });

  test("MCP mutating tool blocked on UNKNOWN overlap; read-only hint exempt (ruling 683)", () => {
    clearMcpTools();
    registerMcpTools("srv", [
      { name: "write_file", inputSchema: { type: "object" } },
      { name: "read_file", inputSchema: { type: "object" }, readOnlyHint: true },
    ]);
    const writeTool = "mcp__srv__write_file";
    const readTool = "mcp__srv__read_file";
    expect(isR170MutatingTool(writeTool)).toBe(true);
    expect(isR170MutatingTool(readTool)).toBe(false);
    const host = new EffectHost();
    const effectId = createEffectId();
    const resource = path.resolve(workspace, "mcp-u.txt");
    host.begin(effectId, "write", "call-1");
    host.recordAllow(effectId);
    host.recordObserve(effectId, { receiptId: "r1", receiptSeq: 1, resourceKey: resource });
    const frozen = frozenUnknownResourceKeys(host);
    const refusal = r170ResourceGateRefusal(
      writeTool,
      { path: "mcp-u.txt", content: "z" },
      workspace,
      frozen,
      host,
    );
    expect(refusal).toContain("blocked_by_unknown");
    expect(r170ResourceGateRefusal(readTool, { path: "mcp-u.txt" }, workspace, frozen, host)).toBeUndefined();
    expect(mutationResourceTargets(readTool, { path: "mcp-u.txt" }, workspace)).toEqual([]);
    clearMcpTools();
  });

  test("allows edit on different path", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const resource = path.resolve(workspace, "c.txt");
    host.begin(effectId, "write", "call-1");
    host.recordAllow(effectId);
    host.recordObserve(effectId, { receiptId: "r1", receiptSeq: 1, resourceKey: resource });
    const frozen = frozenUnknownResourceKeys(host);
    expect(
      r170ResourceGateRefusal("write", { path: "other.txt" }, workspace, frozen),
    ).toBeUndefined();
  });
});
