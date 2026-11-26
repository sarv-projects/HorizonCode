import { describe, expect, test } from "bun:test";
import {
  SymbolGraphStorage,
  makeSymbolEdgeId,
  makeSymbolNodeId,
  type SymbolEdge,
  type SymbolNode,
} from "../../src/core/symbol-graph";

describe("SymbolGraphStorage persistence and semantic queries", () => {
  test("initializes schema and inserts/retrieves symbol nodes", () => {
    const storage = new SymbolGraphStorage(":memory:");
    expect(storage.countNodes()).toBe(0);

    const node1: SymbolNode = {
      id: makeSymbolNodeId("app/src/core/loop.ts", "runTurn", "function"),
      filePath: "app/src/core/loop.ts",
      name: "runTurn",
      kind: "function",
      line: 93,
      isExported: true,
      doc: "Executes a single model turn",
    };

    storage.upsertNode(node1);
    expect(storage.countNodes()).toBe(1);

    const retrieved = storage.getNode(node1.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.name).toBe("runTurn");
    expect(retrieved?.filePath).toBe("app/src/core/loop.ts");
    expect(retrieved?.line).toBe(93);
    expect(retrieved?.isExported).toBe(true);
    expect(retrieved?.doc).toBe("Executes a single model turn");

    // Test upsert idempotence / update
    storage.upsertNode({ ...node1, line: 95, doc: "Updated doc" });
    expect(storage.countNodes()).toBe(1);
    const updated = storage.getNode(node1.id);
    expect(updated?.line).toBe(95);
    expect(updated?.doc).toBe("Updated doc");

    storage.close();
  });

  test("batch upserts nodes and queries by file and name", () => {
    const storage = new SymbolGraphStorage(":memory:");

    const nodes: SymbolNode[] = [
      {
        id: makeSymbolNodeId("app/src/core/auth.ts", "authenticateUser", "function"),
        filePath: "app/src/core/auth.ts",
        name: "authenticateUser",
        kind: "function",
        line: 12,
        isExported: true,
      },
      {
        id: makeSymbolNodeId("app/src/core/auth.ts", "UserToken", "interface"),
        filePath: "app/src/core/auth.ts",
        name: "UserToken",
        kind: "interface",
        line: 45,
        isExported: true,
      },
      {
        id: makeSymbolNodeId("app/src/api/login.ts", "authenticateUser", "function"),
        filePath: "app/src/api/login.ts",
        name: "authenticateUser",
        kind: "function",
        line: 8,
        isExported: false,
      },
    ];

    storage.batchUpsertNodes(nodes);
    expect(storage.countNodes()).toBe(3);

    const authFileNodes = storage.queryNodesByFile("app/src/core/auth.ts");
    expect(authFileNodes.length).toBe(2);
    expect(authFileNodes.map((n) => n.name)).toEqual(["authenticateUser", "UserToken"]);

    const sameNameNodes = storage.queryNodesByName("authenticateUser");
    expect(sameNameNodes.length).toBe(2);
    expect(sameNameNodes.map((n) => n.filePath)).toEqual(["app/src/api/login.ts", "app/src/core/auth.ts"]);

    storage.close();
  });

  test("manages semantic edges, in-edges, and out-edges with source/target resolution", () => {
    const storage = new SymbolGraphStorage(":memory:");

    const nodeA: SymbolNode = {
      id: makeSymbolNodeId("src/service.ts", "handleRequest", "function"),
      filePath: "src/service.ts",
      name: "handleRequest",
      kind: "function",
      line: 10,
      isExported: true,
    };
    const nodeB: SymbolNode = {
      id: makeSymbolNodeId("src/db.ts", "queryDatabase", "function"),
      filePath: "src/db.ts",
      name: "queryDatabase",
      kind: "function",
      line: 25,
      isExported: true,
    };

    storage.batchUpsertNodes([nodeA, nodeB]);

    const edge: SymbolEdge = {
      id: makeSymbolEdgeId(nodeA.id, nodeB.id, "call"),
      fromSymbolId: nodeA.id,
      toSymbolId: nodeB.id,
      kind: "call",
      weight: 3,
    };

    storage.upsertEdge(edge);
    expect(storage.countEdges()).toBe(1);

    const outEdges = storage.queryOutEdges(nodeA.id);
    expect(outEdges.length).toBe(1);
    expect(outEdges[0]?.kind).toBe("call");
    expect(outEdges[0]?.weight).toBe(3);
    expect(outEdges[0]?.targetNode?.name).toBe("queryDatabase");
    expect(outEdges[0]?.targetNode?.filePath).toBe("src/db.ts");

    const inEdges = storage.queryInEdges(nodeB.id);
    expect(inEdges.length).toBe(1);
    expect(inEdges[0]?.kind).toBe("call");
    expect(inEdges[0]?.sourceNode?.name).toBe("handleRequest");
    expect(inEdges[0]?.sourceNode?.filePath).toBe("src/service.ts");

    storage.close();
  });

  test("removes file symbols and cascades to connected edges", () => {
    const storage = new SymbolGraphStorage(":memory:");

    const nodeA: SymbolNode = {
      id: "fileA#foo:function",
      filePath: "fileA.ts",
      name: "foo",
      kind: "function",
      line: 1,
      isExported: true,
    };
    const nodeB: SymbolNode = {
      id: "fileB#bar:function",
      filePath: "fileB.ts",
      name: "bar",
      kind: "function",
      line: 1,
      isExported: true,
    };
    const nodeC: SymbolNode = {
      id: "fileC#baz:function",
      filePath: "fileC.ts",
      name: "baz",
      kind: "function",
      line: 1,
      isExported: true,
    };

    storage.batchUpsertNodes([nodeA, nodeB, nodeC]);
    storage.batchUpsertEdges([
      { id: "e1", fromSymbolId: nodeA.id, toSymbolId: nodeB.id, kind: "call", weight: 1 },
      { id: "e2", fromSymbolId: nodeB.id, toSymbolId: nodeC.id, kind: "call", weight: 1 },
    ]);

    expect(storage.countNodes()).toBe(3);
    expect(storage.countEdges()).toBe(2);

    // Remove fileB
    storage.removeFileSymbols("fileB.ts");

    expect(storage.countNodes()).toBe(2);
    expect(storage.getNode("fileB#bar:function")).toBeUndefined();
    // Both e1 (to B) and e2 (from B) should have been pruned
    expect(storage.countEdges()).toBe(0);

    storage.close();
  });

  test("queryDefinitionAndReferences returns symbols and incoming reference edges", () => {
    const storage = new SymbolGraphStorage(":memory:");

    const defNode: SymbolNode = {
      id: "src/auth.ts#verifyToken:function",
      filePath: "src/auth.ts",
      name: "verifyToken",
      kind: "function",
      line: 20,
      isExported: true,
    };
    const caller1: SymbolNode = {
      id: "src/routes/login.ts#loginHandler:function",
      filePath: "src/routes/login.ts",
      name: "loginHandler",
      kind: "function",
      line: 5,
      isExported: false,
    };
    const caller2: SymbolNode = {
      id: "src/routes/profile.ts#profileHandler:function",
      filePath: "src/routes/profile.ts",
      name: "profileHandler",
      kind: "function",
      line: 10,
      isExported: false,
    };

    storage.batchUpsertNodes([defNode, caller1, caller2]);
    storage.batchUpsertEdges([
      { id: "e1", fromSymbolId: caller1.id, toSymbolId: defNode.id, kind: "call", weight: 2 },
      { id: "e2", fromSymbolId: caller2.id, toSymbolId: defNode.id, kind: "call", weight: 1 },
    ]);

    const result = storage.queryDefinitionAndReferences("verifyToken");
    expect(result.definitions.length).toBe(1);
    expect(result.definitions[0]?.filePath).toBe("src/auth.ts");
    expect(result.references.length).toBe(2);
    expect(result.references.map((r) => r.sourceNode?.name)).toContain("loginHandler");
    expect(result.references.map((r) => r.sourceNode?.name)).toContain("profileHandler");

    storage.close();
  });

  test("querySemanticBlastRadius performs bounded BFS traversal across callers", () => {
    const storage = new SymbolGraphStorage(":memory:");

    // leaf <- mid <- top
    const leaf: SymbolNode = {
      id: "leaf#coreUtil:function",
      filePath: "src/core.ts",
      name: "coreUtil",
      kind: "function",
      line: 1,
      isExported: true,
    };
    const mid1: SymbolNode = {
      id: "mid1#midService1:function",
      filePath: "src/mid1.ts",
      name: "midService1",
      kind: "function",
      line: 1,
      isExported: true,
    };
    const mid2: SymbolNode = {
      id: "mid2#midService2:function",
      filePath: "src/mid2.ts",
      name: "midService2",
      kind: "function",
      line: 1,
      isExported: true,
    };
    const top: SymbolNode = {
      id: "top#appController:function",
      filePath: "src/top.ts",
      name: "appController",
      kind: "function",
      line: 1,
      isExported: true,
    };

    storage.batchUpsertNodes([leaf, mid1, mid2, top]);
    // mid1 calls leaf, mid2 calls leaf, top calls mid1
    storage.batchUpsertEdges([
      { id: "e1", fromSymbolId: mid1.id, toSymbolId: leaf.id, kind: "call", weight: 1 },
      { id: "e2", fromSymbolId: mid2.id, toSymbolId: leaf.id, kind: "call", weight: 1 },
      { id: "e3", fromSymbolId: top.id, toSymbolId: mid1.id, kind: "call", weight: 1 },
    ]);

    // Depth 1: should find mid1 and mid2
    const blastD1 = storage.querySemanticBlastRadius(leaf.id, 1);
    expect(blastD1.depthReached).toBe(1);
    expect(blastD1.affectedSymbols).toEqual(["mid1#midService1:function", "mid2#midService2:function"]);
    expect(blastD1.affectedFiles).toEqual(["src/core.ts", "src/mid1.ts", "src/mid2.ts"]);

    // Depth 2+: should reach top as well
    const blastD2 = storage.querySemanticBlastRadius(leaf.id, 2);
    expect(blastD2.depthReached).toBe(2);
    expect(blastD2.affectedSymbols).toEqual([
      "mid1#midService1:function",
      "mid2#midService2:function",
      "top#appController:function",
    ]);
    expect(blastD2.affectedFiles).toEqual(["src/core.ts", "src/mid1.ts", "src/mid2.ts", "src/top.ts"]);

    storage.close();
  });
});
