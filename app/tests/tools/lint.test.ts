import { describe, expect, test } from "bun:test";
import { getTool } from "../../src/tools/index";

describe("lint tool", () => {
  test("registered with path-only schema", () => {
    const tool = getTool("lint");
    expect(tool?.name).toBe("lint");
    expect(tool?.parameters.required).toEqual(["path"]);
  });
});
