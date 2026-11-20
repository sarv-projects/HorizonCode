/**
 * ACP v2 agent bridge (ruling 642) — Agent Client Protocol over JSON-RPC 2.0.
 *
 * Speaks `initialize` + baseline `session/*` + honest `agentCapabilities` and
 * `session/update` `agent_message_chunk` streaming so IDE hosts (Zed / JetBrains /
 * VS Code / Neovim ACP clients) can attach without a custom fork. Prompt
 * execution is injected (`promptHandler`) so tests stay hermetic; product
 * `hzcode acp` wires a real runtime when available.
 *
 * Does **not** yet claim full ACP surface (auth methods, MCP-from-client,
 * elicitation, bidirectional editor drive, or gate:frontend-parity).
 *
 * Spec: https://agentclientprotocol.com/protocol/v2/
 */

import { randomBytes } from "node:crypto";

export const ACP_PROTOCOL_VERSION = 2 as const;
export const ACP_AGENT_NAME = "horizoncode";
export const ACP_AGENT_VERSION = "0.1.0";

export type AcpJsonRpcId = string | number;

export type AcpRequest = {
  jsonrpc: "2.0";
  id: AcpJsonRpcId;
  method: string;
  params?: unknown;
};

export type AcpResponse =
  | { jsonrpc: "2.0"; id: AcpJsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: AcpJsonRpcId | null; error: { code: number; message: string; data?: unknown } };

export type AcpSessionUpdateNotification = {
  jsonrpc: "2.0";
  method: "session/update";
  params: {
    sessionId: string;
    update: {
      sessionUpdate: "agent_message_chunk";
      messageId: string;
      content: { type: "text"; text: string };
    };
  };
};

export type AcpPromptHandler = (input: {
  sessionId: string;
  cwd: string;
  prompt: string;
  signal?: AbortSignal;
  /** Stream assistant text to the IDE via `session/update` (required baseline for ACP). */
  onAgentMessageChunk?: (text: string) => void;
}) => Promise<{ stopReason: "end_turn" | "cancelled" | "max_tokens" | "error"; text: string }>;

export type AcpSession = {
  sessionId: string;
  cwd: string;
  createdAt: string;
};

const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;
const ERR_NOT_INITIALIZED = -32001;
const ERR_SESSION_NOT_FOUND = -32002;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function newSessionId(): string {
  return `sess_${randomBytes(12).toString("hex")}`;
}

export type AcpAgentOptions = {
  promptHandler?: AcpPromptHandler;
  agentInfo?: { name: string; title: string; version: string };
  /** Product stdio bridge writes JSON-RPC notifications to stdout. */
  onNotification?: (notification: AcpSessionUpdateNotification) => void;
};

export const ACP_AGENT_CAPABILITIES_HONEST = {
  /** Baseline text `session/prompt` only; richer blocks omitted until implemented. */
  promptCapabilities: {},
} as const;

/**
 * In-memory ACP agent. One connection / one agent instance.
 * Call `handleMessage` with parsed JSON-RPC request objects.
 */
export class AcpAgent {
  private initialized = false;
  private readonly sessions = new Map<string, AcpSession>();
  private readonly inflightPrompts = new Map<string, AbortController>();
  private readonly promptHandler: AcpPromptHandler;
  private readonly info: { name: string; title: string; version: string };
  private readonly onNotification?: (notification: AcpSessionUpdateNotification) => void;

  constructor(opts: AcpAgentOptions = {}) {
    this.promptHandler =
      opts.promptHandler ??
      (async ({ prompt }) => ({
        stopReason: "end_turn" as const,
        text: `[acp] received prompt (${prompt.length} chars); wire a runtime promptHandler for live turns`,
      }));
    this.info = opts.agentInfo ?? {
      name: ACP_AGENT_NAME,
      title: "HorizonCode",
      version: ACP_AGENT_VERSION,
    };
    this.onNotification = opts.onNotification;
  }

  private emitAgentMessageChunk(sessionId: string, messageId: string, text: string): boolean {
    if (text === "") return false;
    this.onNotification?.({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text },
        },
      },
    });
    return true;
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  async handleMessage(raw: unknown): Promise<AcpResponse | null> {
    if (!isRecord(raw) || raw.jsonrpc !== "2.0") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: ERR_INVALID_REQUEST, message: "invalid JSON-RPC 2.0 request" },
      };
    }
    // Notification (no id): ignore until we emit agent→client traffic.
    if (!("id" in raw) || raw.id === undefined || raw.id === null) {
      return null;
    }
    const id = raw.id as AcpJsonRpcId;
    if (typeof raw.method !== "string" || raw.method.trim() === "") {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: ERR_INVALID_REQUEST, message: "method required" },
      };
    }
    try {
      return await this.dispatch(id, raw.method, raw.params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { jsonrpc: "2.0", id, error: { code: ERR_INTERNAL, message } };
    }
  }

  private async dispatch(id: AcpJsonRpcId, method: string, params: unknown): Promise<AcpResponse> {
    if (method === "initialize") {
      return this.initialize(id, params);
    }
    if (!this.initialized) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: ERR_NOT_INITIALIZED, message: "call initialize before other methods" },
      };
    }
    switch (method) {
      case "session/new":
        return this.sessionNew(id, params);
      case "session/list":
        return this.sessionList(id);
      case "session/close":
        return this.sessionClose(id, params);
      case "session/prompt":
        return await this.sessionPrompt(id, params);
      case "session/cancel":
        return this.sessionCancel(id, params);
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: ERR_METHOD_NOT_FOUND, message: `method not found: ${method}` },
        };
    }
  }

  private initialize(id: AcpJsonRpcId, params: unknown): AcpResponse {
    // Accept v1 or v2 client protocolVersion; speak v2.
    const clientVersion =
      isRecord(params) && typeof params.protocolVersion === "number"
        ? params.protocolVersion
        : ACP_PROTOCOL_VERSION;
    if (clientVersion < 1) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: ERR_INVALID_PARAMS, message: "protocolVersion must be >= 1" },
      };
    }
    this.initialized = true;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { ...ACP_AGENT_CAPABILITIES_HONEST },
        agentInfo: this.info,
        authMethods: [],
      },
    };
  }

  private sessionNew(id: AcpJsonRpcId, params: unknown): AcpResponse {
    const cwd = isRecord(params) && typeof params.cwd === "string" ? params.cwd.trim() : "";
    const absolute =
      cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
    if (!absolute) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: ERR_INVALID_PARAMS, message: "session/new requires absolute cwd" },
      };
    }
    const sessionId = newSessionId();
    const session: AcpSession = {
      sessionId,
      cwd,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, session);
    return { jsonrpc: "2.0", id, result: { sessionId } };
  }

  private sessionList(id: AcpJsonRpcId): AcpResponse {
    const sessions = [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      createdAt: s.createdAt,
    }));
    return { jsonrpc: "2.0", id, result: { sessions } };
  }

  private sessionClose(id: AcpJsonRpcId, params: unknown): AcpResponse {
    if (!isRecord(params) || typeof params.sessionId !== "string") {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: ERR_INVALID_PARAMS, message: "session/close requires sessionId" },
      };
    }
    if (!this.sessions.has(params.sessionId)) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: ERR_SESSION_NOT_FOUND, message: `unknown session ${params.sessionId}` },
      };
    }
    this.inflightPrompts.get(params.sessionId)?.abort();
    this.inflightPrompts.delete(params.sessionId);
    this.sessions.delete(params.sessionId);
    return { jsonrpc: "2.0", id, result: {} };
  }

  private sessionCancel(id: AcpJsonRpcId, params: unknown): AcpResponse {
    if (!isRecord(params) || typeof params.sessionId !== "string") {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: ERR_INVALID_PARAMS, message: "session/cancel requires sessionId" },
      };
    }
    if (!this.sessions.has(params.sessionId)) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: ERR_SESSION_NOT_FOUND, message: `unknown session ${params.sessionId}` },
      };
    }
    const inflight = this.inflightPrompts.get(params.sessionId);
    if (inflight) {
      inflight.abort();
      this.inflightPrompts.delete(params.sessionId);
    }
    return { jsonrpc: "2.0", id, result: {} };
  }

  private async sessionPrompt(id: AcpJsonRpcId, params: unknown): Promise<AcpResponse> {
    if (!isRecord(params) || typeof params.sessionId !== "string") {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: ERR_INVALID_PARAMS, message: "session/prompt requires sessionId" },
      };
    }
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: ERR_SESSION_NOT_FOUND, message: `unknown session ${params.sessionId}` },
      };
    }
    const promptText = extractPromptText(params);
    if (promptText === undefined) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: ERR_INVALID_PARAMS, message: "session/prompt requires prompt text" },
      };
    }
    const prior = this.inflightPrompts.get(session.sessionId);
    prior?.abort();
    const controller = new AbortController();
    this.inflightPrompts.set(session.sessionId, controller);
    const messageId = `msg_${randomBytes(8).toString("hex")}`;
    let streamedChunk = false;
    const onAgentMessageChunk = (text: string) => {
      if (this.emitAgentMessageChunk(session.sessionId, messageId, text)) {
        streamedChunk = true;
      }
    };
    let outcome: Awaited<ReturnType<AcpPromptHandler>>;
    try {
      outcome = await this.promptHandler({
        sessionId: session.sessionId,
        cwd: session.cwd,
        prompt: promptText,
        signal: controller.signal,
        onAgentMessageChunk,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            stopReason: "cancelled",
            content: [{ type: "text", text: "" }],
          },
        };
      }
      throw err;
    } finally {
      if (this.inflightPrompts.get(session.sessionId) === controller) {
        this.inflightPrompts.delete(session.sessionId);
      }
    }
    const stopReason = controller.signal.aborted ? "cancelled" : outcome.stopReason;
    if (!streamedChunk && outcome.text.trim() !== "") {
      this.emitAgentMessageChunk(session.sessionId, messageId, outcome.text);
    }
    return {
      jsonrpc: "2.0",
      id,
      result: {
        stopReason,
        // Reduced: return assistant text as a single content block for hosts.
        content: [{ type: "text", text: outcome.text }],
      },
    };
  }
}

/** Pull plain text from ACP prompt params (string or content blocks). */
export function extractPromptText(params: Record<string, unknown>): string | undefined {
  if (typeof params.prompt === "string" && params.prompt.trim() !== "") return params.prompt;
  if (typeof params.text === "string" && params.text.trim() !== "") return params.text;
  if (Array.isArray(params.prompt)) {
    const parts: string[] = [];
    for (const block of params.prompt) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    const joined = parts.join("\n").trim();
    return joined !== "" ? joined : undefined;
  }
  return undefined;
}

/** Parse one NDJSON line into an ACP request (or null if blank). */
export function parseAcpLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  return JSON.parse(trimmed) as unknown;
}
