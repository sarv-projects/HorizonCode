import { describe, expect, test } from "bun:test";
import { forkSessionCli, renderSessionList } from "../../src/core/session-cli";
import { SessionStore } from "../../src/core/session";
import { makeWorkspace } from "../tools/helpers";

describe("session-cli", () => {
  test("list and fork", () => {
    const ws = makeWorkspace();
    const store = new SessionStore(ws);
    const parent = store.createSession("parent", { permissionMode: "accept-edits" });
    store.appendMessage(parent.id, { role: "user", content: "hi" });
    store.appendMessage(parent.id, { role: "assistant", content: "hello" });
    const list = renderSessionList(ws);
    expect(list).toContain(parent.id);
    const child = forkSessionCli(ws, parent.id, { at: 1, permissionMode: "default" });
    expect(child.childId).not.toBe(parent.id);
    expect(child.messageIndex).toBe(1);
    expect(child.permissionMode).toBe("default");
  });
});
