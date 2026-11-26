import { describe, expect, it } from "bun:test";
import {
  buildFileCallEdges,
  createCallGraph,
  updateCallGraphIncremental,
  queryCallers,
  computeCallGraphBlastRadius,
} from "../../src/core/call-graph";

describe("Incremental Call Graph (Engineering Brain)", () => {
  const targetSymbols = new Set(["parseToken", "validateInput", "computeHash"]);

  it("extracts call-site edges from file content ignoring comments and strings", () => {
    const code = `
      // parseToken("comment")
      /* validateInput("block") */
      const s = "computeHash()";
      export function processData(raw: string) {
        validateInput(raw);
        const token = parseToken(raw);
        return computeHash(token);
      }
    `;

    const edges = buildFileCallEdges("src/processor.ts", code, targetSymbols);

    expect(edges.length).toBe(3);
    const callees = edges.map((e) => e.toSymbol).sort();
    expect(callees).toEqual(["computeHash", "parseToken", "validateInput"]);
    expect(edges.every((e) => e.fromFile === "src/processor.ts")).toBe(true);
    expect(edges.every((e) => e.callSites === 1)).toBe(true);
  });

  it("creates and queries a call graph index", () => {
    const fileA = `
      function runA() {
        validateInput("data");
        parseToken("tok");
      }
    `;
    const fileB = `
      function runB() {
        validateInput("data2");
      }
    `;

    let graph = createCallGraph();
    graph = updateCallGraphIncremental(graph, "src/a.ts", fileA, targetSymbols);
    graph = updateCallGraphIncremental(graph, "src/b.ts", fileB, targetSymbols);

    const callersOfValidate = queryCallers(graph, "validateInput");
    expect(callersOfValidate.length).toBe(2);
    expect(callersOfValidate.map((c) => c.fromFile).sort()).toEqual(["src/a.ts", "src/b.ts"]);

    const callersOfParse = queryCallers(graph, "parseToken");
    expect(callersOfParse.length).toBe(1);
    expect(callersOfParse[0]?.fromFile).toBe("src/a.ts");
  });

  it("updates file edges incrementally without affecting sibling files", () => {
    const fileA = `validateInput("data");`;
    const fileB = `validateInput("data2");`;

    let graph = createCallGraph();
    graph = updateCallGraphIncremental(graph, "src/a.ts", fileA, targetSymbols);
    graph = updateCallGraphIncremental(graph, "src/b.ts", fileB, targetSymbols);

    expect(queryCallers(graph, "validateInput").length).toBe(2);

    // Update file A to remove the call to validateInput and add computeHash
    const updatedA = `computeHash("data");`;
    graph = updateCallGraphIncremental(graph, "src/a.ts", updatedA, targetSymbols);

    const callersOfValidate = queryCallers(graph, "validateInput");
    expect(callersOfValidate.length).toBe(1);
    expect(callersOfValidate[0]?.fromFile).toBe("src/b.ts");

    const callersOfHash = queryCallers(graph, "computeHash");
    expect(callersOfHash.length).toBe(1);
    expect(callersOfHash[0]?.fromFile).toBe("src/a.ts");
  });

  it("computes blast radius across changed symbols", () => {
    let graph = createCallGraph();
    graph = updateCallGraphIncremental(
      graph,
      "src/caller1.ts",
      `parseToken(x); parseToken(y);`,
      targetSymbols,
    );
    graph = updateCallGraphIncremental(
      graph,
      "src/caller2.ts",
      `computeHash(z);`,
      targetSymbols,
    );

    const blast = computeCallGraphBlastRadius(graph, ["parseToken"]);
    expect(blast.affectedFiles).toEqual(["src/caller1.ts"]);
    expect(blast.totalCallSites).toBe(2);

    const blastMulti = computeCallGraphBlastRadius(graph, ["parseToken", "computeHash"]);
    expect(blastMulti.affectedFiles.sort()).toEqual(["src/caller1.ts", "src/caller2.ts"]);
    expect(blastMulti.totalCallSites).toBe(3);
  });
});
