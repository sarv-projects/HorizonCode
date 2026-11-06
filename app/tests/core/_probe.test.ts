import { test, expect } from "bun:test";
import { marker } from "./helpers";

test("probe", () => {
  expect(marker).toBe(1);
});

test.skipIf(true)("skipped probe", () => {
  expect(1).toBe(2);
});
