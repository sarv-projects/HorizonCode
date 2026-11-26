/**
 * subagent-inbox.ts — bounded typed subagent mailbox
 * (claude-code/opencode task-board + mailbox ADAPT).
 *
 * Per-agent FIFO with a per-agent cap (oldest dropped + counted) and a global
 * cap (throws). Uses the AgentId string identity from ruling 808. No IO, no
 * authority — a pure in-process message seam; the caller owns delivery.
 */

export interface InboxMessage {
  id: string;
  to: string;
  body: string;
  seq: number;
  atMs: number;
}

export interface InboxOptions {
  perAgentCap?: number;
  globalCap?: number;
  now?: () => number;
}

export class SubagentInbox {
  private readonly queues = new Map<string, InboxMessage[]>();
  private readonly dropped = new Map<string, number>();
  private readonly seq = new Map<string, number>();
  private total = 0;
  private msgSeq = 0;
  private readonly perAgentCap: number;
  private readonly globalCap: number;
  private readonly now: () => number;

  constructor(opts: InboxOptions = {}) {
    this.perAgentCap = Math.max(1, opts.perAgentCap ?? 64);
    this.globalCap = Math.max(1, opts.globalCap ?? 1024);
    this.now = opts.now ?? Date.now;
  }

  post(to: string, body: string): InboxMessage {
    if (typeof to !== "string" || to.trim() === "") throw new Error("HZ_PRECONDITION_FAILED: inbox recipient required");
    if (this.total >= this.globalCap) throw new Error("HZ_PRECONDITION_FAILED: subagent inbox global cap reached");
    const s = (this.seq.get(to) ?? 0) + 1;
    this.seq.set(to, s);
    const msg: InboxMessage = {
      id: `im-${++this.msgSeq}`,
      to,
      body,
      seq: s,
      atMs: this.now(),
    };
    const q = this.queues.get(to) ?? [];
    q.push(msg);
    this.queues.set(to, q);
    this.total += 1;
    while (q.length > this.perAgentCap) {
      q.shift();
      this.dropped.set(to, (this.dropped.get(to) ?? 0) + 1);
      this.total -= 1;
    }
    return msg;
  }

  drain(to: string): InboxMessage[] {
    const q = this.queues.get(to);
    if (q === undefined || q.length === 0) return [];
    this.queues.set(to, []);
    this.total -= q.length;
    return q;
  }

  droppedCount(to: string): number {
    return this.dropped.get(to) ?? 0;
  }

  pending(to: string): number {
    return this.queues.get(to)?.length ?? 0;
  }

  size(): number {
    return this.total;
  }
}
