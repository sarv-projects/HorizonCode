/**
 * symbol-graph.ts — Durable Symbol Graph Persistence & Semantic Edges
 *
 * Engineering Brain (rulings 640 / 713 / 863 / 878):
 * Durable persistence for symbols, semantic definitions, references, and call edges
 * backed by SQLite (WAL mode, parameterized statements, indexed lookups).
 * Supports incremental file reindexing, definition/reference queries, and multi-hop
 * semantic blast-radius traversal.
 */

import { Database } from "bun:sqlite";
import { assertSqliteReconcileBarrierClear } from "./session";

export type SymbolKind = "function" | "class" | "interface" | "variable" | "type" | "method";
export type SemanticEdgeKind = "call" | "reference" | "import" | "implements" | "extends";

export interface SymbolNode {
  id: string;
  filePath: string;
  name: string;
  kind: SymbolKind;
  line: number;
  isExported: boolean;
  doc?: string;
  updatedAt?: number;
}

export interface SymbolEdge {
  id: string;
  fromSymbolId: string;
  toSymbolId: string;
  kind: SemanticEdgeKind;
  weight: number;
  updatedAt?: number;
}

export interface SymbolEdgeWithTarget extends SymbolEdge {
  targetNode?: SymbolNode;
}

export interface SymbolEdgeWithSource extends SymbolEdge {
  sourceNode?: SymbolNode;
}

export interface SemanticBlastRadius {
  rootSymbolId: string;
  affectedSymbols: string[];
  affectedFiles: string[];
  edgeCount: number;
  depthReached: number;
}

export function makeSymbolNodeId(filePath: string, name: string, kind: SymbolKind): string {
  return `${filePath}#${name}:${kind}`;
}

export function makeSymbolEdgeId(fromSymbolId: string, toSymbolId: string, kind: SemanticEdgeKind): string {
  return `${fromSymbolId}->${kind}->${toSymbolId}`;
}

export class SymbolGraphStorage {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS symbol_nodes (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        is_exported INTEGER NOT NULL,
        doc TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS symbol_edges (
        id TEXT PRIMARY KEY,
        from_symbol_id TEXT NOT NULL,
        to_symbol_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        weight INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbol_nodes(file_path);");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbol_nodes(name);");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_edges_from ON symbol_edges(from_symbol_id);");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_edges_to ON symbol_edges(to_symbol_id);");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_edges_kind ON symbol_edges(kind);");
  }

  public upsertNode(node: SymbolNode): void {
    assertSqliteReconcileBarrierClear("symbol-graph.upsertNode");
    const updatedAt = node.updatedAt ?? Date.now();
    const isExportedInt = node.isExported ? 1 : 0;
    const stmt = this.db.prepare(`
      INSERT INTO symbol_nodes (id, file_path, name, kind, line, is_exported, doc, updated_at)
      VALUES ($id, $filePath, $name, $kind, $line, $isExported, $doc, $updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        file_path = excluded.file_path,
        name = excluded.name,
        kind = excluded.kind,
        line = excluded.line,
        is_exported = excluded.is_exported,
        doc = excluded.doc,
        updated_at = excluded.updated_at;
    `);
    stmt.run({
      $id: node.id,
      $filePath: node.filePath,
      $name: node.name,
      $kind: node.kind,
      $line: node.line,
      $isExported: isExportedInt,
      $doc: node.doc ?? null,
      $updatedAt: updatedAt,
    });
  }

  public batchUpsertNodes(nodes: readonly SymbolNode[]): void {
    if (nodes.length === 0) return;
    const txn = this.db.transaction(() => {
      for (const node of nodes) {
        this.upsertNode(node);
      }
    });
    txn();
  }

  public upsertEdge(edge: SymbolEdge): void {
    assertSqliteReconcileBarrierClear("symbol-graph.upsertEdge");
    const updatedAt = edge.updatedAt ?? Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO symbol_edges (id, from_symbol_id, to_symbol_id, kind, weight, updated_at)
      VALUES ($id, $fromSymbolId, $toSymbolId, $kind, $weight, $updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        weight = excluded.weight,
        updated_at = excluded.updated_at;
    `);
    stmt.run({
      $id: edge.id,
      $fromSymbolId: edge.fromSymbolId,
      $toSymbolId: edge.toSymbolId,
      $kind: edge.kind,
      $weight: edge.weight,
      $updatedAt: updatedAt,
    });
  }

  public batchUpsertEdges(edges: readonly SymbolEdge[]): void {
    if (edges.length === 0) return;
    const txn = this.db.transaction(() => {
      for (const edge of edges) {
        this.upsertEdge(edge);
      }
    });
    txn();
  }

  public getNode(id: string): SymbolNode | undefined {
    const stmt = this.db.prepare(`
      SELECT id, file_path as filePath, name, kind, line, is_exported as isExported, doc, updated_at as updatedAt
      FROM symbol_nodes
      WHERE id = $id;
    `);
    const row = stmt.get({ $id: id }) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      filePath: row.filePath,
      name: row.name,
      kind: row.kind as SymbolKind,
      line: row.line,
      isExported: row.isExported === 1,
      doc: row.doc ?? undefined,
      updatedAt: row.updatedAt,
    };
  }

  public queryNodesByName(name: string): SymbolNode[] {
    const stmt = this.db.prepare(`
      SELECT id, file_path as filePath, name, kind, line, is_exported as isExported, doc, updated_at as updatedAt
      FROM symbol_nodes
      WHERE name = $name
      ORDER BY file_path, line;
    `);
    const rows = stmt.all({ $name: name }) as any[];
    return rows.map((r) => ({
      id: r.id,
      filePath: r.filePath,
      name: r.name,
      kind: r.kind as SymbolKind,
      line: r.line,
      isExported: r.isExported === 1,
      doc: r.doc ?? undefined,
      updatedAt: r.updatedAt,
    }));
  }

  public queryNodesByFile(filePath: string): SymbolNode[] {
    const stmt = this.db.prepare(`
      SELECT id, file_path as filePath, name, kind, line, is_exported as isExported, doc, updated_at as updatedAt
      FROM symbol_nodes
      WHERE file_path = $filePath
      ORDER BY line;
    `);
    const rows = stmt.all({ $filePath: filePath }) as any[];
    return rows.map((r) => ({
      id: r.id,
      filePath: r.filePath,
      name: r.name,
      kind: r.kind as SymbolKind,
      line: r.line,
      isExported: r.isExported === 1,
      doc: r.doc ?? undefined,
      updatedAt: r.updatedAt,
    }));
  }

  public queryInEdges(toSymbolId: string): SymbolEdgeWithSource[] {
    const stmt = this.db.prepare(`
      SELECT e.id, e.from_symbol_id as fromSymbolId, e.to_symbol_id as toSymbolId, e.kind, e.weight, e.updated_at as updatedAt,
             n.file_path as sourceFilePath, n.name as sourceName, n.kind as sourceKind, n.line as sourceLine, n.is_exported as sourceExported, n.doc as sourceDoc
      FROM symbol_edges e
      LEFT JOIN symbol_nodes n ON e.from_symbol_id = n.id
      WHERE e.to_symbol_id = $toSymbolId
      ORDER BY e.weight DESC;
    `);
    const rows = stmt.all({ $toSymbolId: toSymbolId }) as any[];
    return rows.map((r) => {
      const edge: SymbolEdgeWithSource = {
        id: r.id,
        fromSymbolId: r.fromSymbolId,
        toSymbolId: r.toSymbolId,
        kind: r.kind as SemanticEdgeKind,
        weight: r.weight,
        updatedAt: r.updatedAt,
      };
      if (r.sourceFilePath) {
        edge.sourceNode = {
          id: r.fromSymbolId,
          filePath: r.sourceFilePath,
          name: r.sourceName,
          kind: r.sourceKind as SymbolKind,
          line: r.sourceLine,
          isExported: r.sourceExported === 1,
          doc: r.sourceDoc ?? undefined,
        };
      }
      return edge;
    });
  }

  public queryOutEdges(fromSymbolId: string): SymbolEdgeWithTarget[] {
    const stmt = this.db.prepare(`
      SELECT e.id, e.from_symbol_id as fromSymbolId, e.to_symbol_id as toSymbolId, e.kind, e.weight, e.updated_at as updatedAt,
             n.file_path as targetFilePath, n.name as targetName, n.kind as targetKind, n.line as targetLine, n.is_exported as targetExported, n.doc as targetDoc
      FROM symbol_edges e
      LEFT JOIN symbol_nodes n ON e.to_symbol_id = n.id
      WHERE e.from_symbol_id = $fromSymbolId
      ORDER BY e.weight DESC;
    `);
    const rows = stmt.all({ $fromSymbolId: fromSymbolId }) as any[];
    return rows.map((r) => {
      const edge: SymbolEdgeWithTarget = {
        id: r.id,
        fromSymbolId: r.fromSymbolId,
        toSymbolId: r.toSymbolId,
        kind: r.kind as SemanticEdgeKind,
        weight: r.weight,
        updatedAt: r.updatedAt,
      };
      if (r.targetFilePath) {
        edge.targetNode = {
          id: r.toSymbolId,
          filePath: r.targetFilePath,
          name: r.targetName,
          kind: r.targetKind as SymbolKind,
          line: r.targetLine,
          isExported: r.targetExported === 1,
          doc: r.targetDoc ?? undefined,
        };
      }
      return edge;
    });
  }

  public removeFileSymbols(filePath: string): void {
    assertSqliteReconcileBarrierClear("symbol-graph.removeFileSymbols");
    const txn = this.db.transaction(() => {
      // Find all symbol IDs in this file
      const findStmt = this.db.prepare("SELECT id FROM symbol_nodes WHERE file_path = $filePath;");
      const rows = findStmt.all({ $filePath: filePath }) as { id: string }[];
      const ids = rows.map((r) => r.id);

      if (ids.length > 0) {
        // Delete all edges connected to these symbols
        const delEdges = this.db.prepare(
          "DELETE FROM symbol_edges WHERE from_symbol_id = $id OR to_symbol_id = $id;",
        );
        for (const id of ids) {
          delEdges.run({ $id: id });
        }
      }

      // Delete the nodes
      const delNodes = this.db.prepare("DELETE FROM symbol_nodes WHERE file_path = $filePath;");
      delNodes.run({ $filePath: filePath });
    });
    txn();
  }

  public queryDefinitionAndReferences(name: string): {
    definitions: SymbolNode[];
    references: SymbolEdgeWithSource[];
  } {
    const definitions = this.queryNodesByName(name);
    const references: SymbolEdgeWithSource[] = [];
    const seenEdgeIds = new Set<string>();

    for (const def of definitions) {
      const inEdges = this.queryInEdges(def.id);
      for (const edge of inEdges) {
        if (!seenEdgeIds.has(edge.id)) {
          seenEdgeIds.add(edge.id);
          references.push(edge);
        }
      }
    }

    return { definitions, references };
  }

  public querySemanticBlastRadius(rootSymbolId: string, maxDepth: number = 3): SemanticBlastRadius {
    const visitedSymbols = new Set<string>();
    const affectedFiles = new Set<string>();
    let totalEdges = 0;
    let maxDepthReached = 0;

    const rootNode = this.getNode(rootSymbolId);
    if (rootNode) {
      affectedFiles.add(rootNode.filePath);
    }

    type QueueItem = { id: string; depth: number };
    const queue: QueueItem[] = [{ id: rootSymbolId, depth: 0 }];
    visitedSymbols.add(rootSymbolId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth > maxDepthReached) {
        maxDepthReached = current.depth;
      }
      if (current.depth >= maxDepth) continue;

      const inEdges = this.queryInEdges(current.id);
      for (const edge of inEdges) {
        totalEdges += 1;
        const callerSymbolId = edge.fromSymbolId;
        if (!visitedSymbols.has(callerSymbolId)) {
          visitedSymbols.add(callerSymbolId);
          if (edge.sourceNode) {
            affectedFiles.add(edge.sourceNode.filePath);
          } else {
            const node = this.getNode(callerSymbolId);
            if (node) affectedFiles.add(node.filePath);
          }
          queue.push({ id: callerSymbolId, depth: current.depth + 1 });
        }
      }
    }

    // Exclude root symbol itself from affected symbols list
    const affectedList = [...visitedSymbols].filter((id) => id !== rootSymbolId).sort();

    return {
      rootSymbolId,
      affectedSymbols: affectedList,
      affectedFiles: [...affectedFiles].sort(),
      edgeCount: totalEdges,
      depthReached: maxDepthReached,
    };
  }

  public countNodes(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM symbol_nodes;").get() as any;
    return row?.count ?? 0;
  }

  public countEdges(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM symbol_edges;").get() as any;
    return row?.count ?? 0;
  }

  public close(): void {
    this.db.close();
  }
}
