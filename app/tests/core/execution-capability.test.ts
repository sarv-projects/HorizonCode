import { describe, expect, test } from "bun:test";
import {
  getExecutionCapability,
  localExecutionCapability,
  resetExecutionCapability,
  setExecutionCapability,
} from "../../src/core/execution-capability";
import type { OwnedSpawn, SpawnOwnedOptions } from "../../src/core/owned-spawn";

describe("ExecutionCapability", () => {
  test("defaults to local spawnOwned", () => {
    resetExecutionCapability();
    expect(getExecutionCapability().spawnOwned).toBe(localExecutionCapability().spawnOwned);
  });

  test("setExecutionCapability replaces spawn path", async () => {
    resetExecutionCapability();
    const seen: string[] = [];
    setExecutionCapability({
      async spawnOwned(cmd: string[], opts: SpawnOwnedOptions): Promise<OwnedSpawn> {
        seen.push(opts.label);
        return { proc: { pid: 1, kill: () => {}, killed: false } as OwnedSpawn["proc"] };
      },
    });
    await getExecutionCapability().spawnOwned(["echo"], {
      stateDir: "/tmp",
      label: "test-cap",
      cwd: "/tmp",
    });
    expect(seen).toEqual(["test-cap"]);
    resetExecutionCapability();
  });
});
