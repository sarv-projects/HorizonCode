/**
 * catalog-cost-bootstrap.test.ts — createRuntime registers the loaded catalog
 * once at boot so the process-local cost seam resolves priced models honestly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRuntime } from "../../src/core/index";
import { catalogPriceTableRevision, getCostCatalog, setCostCatalog, usageCostEventFields } from "../../src/core/usage-cost";

const savedSnapshot = process.env.HZ_MODELS_SNAPSHOT;
const dirs: string[] = [];
afterEach(() => {
  setCostCatalog(undefined);
  if (savedSnapshot === undefined) delete process.env.HZ_MODELS_SNAPSHOT;
  else process.env.HZ_MODELS_SNAPSHOT = savedSnapshot;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pricedSnapshot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-cost-boot-"));
  dirs.push(dir);
  const providers: Record<string, unknown> = {};
  // External snapshots must clear the 100-provider floor; fill with inert ones.
  for (let i = 0; i < 100; i += 1) {
    providers[`p${i}`] = { id: `p${i}`, defaultModel: "m", models: { m: { id: "m", limit: { context: 1000 } } } };
  }
  providers["priced"] = {
    id: "priced",
    defaultModel: "priced-1",
    models: {
      "priced-1": {
        id: "priced-1",
        limit: { context: 128_000 },
        cost: { input: 1, output: 2 },
      },
    },
  };
  const file = path.join(dir, "catalog.json");
  writeFileSync(file, JSON.stringify({ providers }), "utf8");
  return file;
}

describe("cost catalog boot registration", () => {
  test("createRuntime registers the loaded catalog for callers that do not thread it", async () => {
    process.env.HZ_MODELS_SNAPSHOT = pricedSnapshot();
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-cost-ws-"));
    dirs.push(workspace);
    const runtime = await createRuntime({ workspace, mock: true });
    try {
      expect(getCostCatalog()?.providers["priced"]?.models["priced-1"]?.cost?.input).toBe(1);
      const fields = usageCostEventFields({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, "priced", "priced-1");
      expect(fields?.priceTableRevision).toBe(catalogPriceTableRevision("priced", "priced-1"));
      expect(fields?.costMicroUsd).toBe(3_000_000); // $1/M in + $2/M out
    } finally {
      await runtime.close();
    }
  });
});
