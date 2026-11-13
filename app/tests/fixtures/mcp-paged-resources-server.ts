/**
 * mcp-paged-resources-server.ts — paginated `resources/list` for MCP cursor tests.
 */

interface ResourceShape {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

const RESOURCES: ResourceShape[] = [
  { uri: "file:///a.txt", name: "alpha", mimeType: "text/plain" },
  { uri: "file:///b.txt", name: "beta", mimeType: "text/plain" },
  { uri: "file:///c.txt", name: "gamma", mimeType: "text/plain" },
  { uri: "file:///d.txt", name: "delta", mimeType: "text/plain" },
  { uri: "file:///e.txt", name: "epsilon", mimeType: "text/plain" },
];

const PAGE_SIZE = 2;
const CURSOR_PREFIX = "res-page-";

function pageIndexFromCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  if (!cursor.startsWith(CURSOR_PREFIX)) return -1;
  const index = Number.parseInt(cursor.slice(CURSOR_PREFIX.length), 10);
  return Number.isFinite(index) && index >= 0 ? index : -1;
}

function listPage(cursor: string | undefined): { resources: ResourceShape[]; nextCursor?: string } {
  const page = pageIndexFromCursor(cursor);
  if (page < 0) return { resources: [] };
  const start = page * PAGE_SIZE;
  const slice = RESOURCES.slice(start, start + PAGE_SIZE);
  const nextStart = start + PAGE_SIZE;
  if (nextStart >= RESOURCES.length) return { resources: slice };
  return { resources: slice, nextCursor: `${CURSOR_PREFIX}${page + 1}` };
}

function write(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id: number | string, result: unknown): void {
  write({ jsonrpc: "2.0", id, result });
}

function replyError(id: number | string | null, code: number, message: string): void {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message: Record<string, unknown>): Promise<void> {
  const method = typeof message.method === "string" ? message.method : "";
  const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : null;
  if (method === "initialize") {
    if (id === null) return;
    reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { resources: { subscribe: false, listChanged: false } },
      serverInfo: { name: "mcp-paged-resources", version: "0.0.1" },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (id === null) return;
  if (method === "tools/list") {
    reply(id, { tools: [] });
    return;
  }
  if (method === "resources/list") {
    const params =
      message.params !== null && typeof message.params === "object" && !Array.isArray(message.params)
        ? (message.params as Record<string, unknown>)
        : {};
    const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
    reply(id, listPage(cursor));
    return;
  }
  replyError(id, -32601, `method not found: ${method}`);
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      message = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    void handle(message).catch((err) => {
      const mid = typeof message.id === "number" || typeof message.id === "string" ? message.id : null;
      if (mid !== null) replyError(mid, -32603, err instanceof Error ? err.message : String(err));
    });
  }
});

process.stdin.resume();
