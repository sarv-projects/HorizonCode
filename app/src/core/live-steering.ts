/**
 * live-steering.ts — agent-side channel for mid-stream provider steer (C-9).
 *
 * ADAPT from omp `packages/agent/src/live-steering.ts` (LiveSteeringChannel):
 * a provider that can inject user input into the response it is streaming
 * (OpenAI Responses `response.steer`) claims queued text through this channel.
 * Accepted steers are recorded as what the model saw; rejected / undeliverable
 * steers stay deferred for the ordinary step-boundary drain. Once anything is
 * deferred, later claims must wait — delivering them live would reorder user
 * messages.
 *
 * This slice is the claim/accept/reject ordering seam only. Real Responses
 * WebSocket `response.steer` wire remains OPEN.
 */

import type { LiveSteerClaim, LiveSteering } from "../contracts";
import type { InterjectionBuffer, PendingInterjection } from "./interjection";

export interface LiveSteeringQueue {
  /** Resolves once steering is queued or `signal` aborts; never consumes. */
  wait(signal: AbortSignal): Promise<void>;
  /** Dequeues the next steering batch (may be empty). */
  take(signal: AbortSignal): Promise<PendingInterjection[]>;
}

/** Build a queue adapter over the turn's interjection buffer. */
export function interjectionLiveSteeringQueue(buffer: InterjectionBuffer): LiveSteeringQueue {
  return {
    async wait(signal: AbortSignal): Promise<void> {
      if (!buffer.isEmpty() || signal.aborted) return;
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          clearInterval(timer);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        // InterjectionBuffer has no waiters; poll lightly until abort or push.
        const timer = setInterval(() => {
          if (!buffer.isEmpty() || signal.aborted) {
            clearInterval(timer);
            signal.removeEventListener("abort", onAbort);
            resolve();
          }
        }, 5);
      });
    },
    async take(signal: AbortSignal): Promise<PendingInterjection[]> {
      if (signal.aborted) return [];
      return buffer.drainAll();
    },
  };
}

/** One provider call's live-steering source. */
export class LiveSteeringChannel implements LiveSteering {
  /** Steering the provider delivered into the in-flight response, in queue order. */
  readonly accepted: PendingInterjection[] = [];
  /** Steering taken from the queue but not delivered; always after {@link accepted}. */
  readonly deferred: PendingInterjection[] = [];
  readonly #queue: LiveSteeringQueue;

  constructor(queue: LiveSteeringQueue) {
    this.#queue = queue;
  }

  wait(signal: AbortSignal): Promise<void> {
    // Once input is deferred, later input must follow it at the boundary.
    if (this.deferred.length === 0) return this.#queue.wait(signal);
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async claim(signal: AbortSignal): Promise<LiveSteerClaim | undefined> {
    if (this.deferred.length > 0 || signal.aborted) return undefined;
    let messages: PendingInterjection[];
    try {
      messages = await this.#queue.take(signal);
    } catch {
      return undefined;
    }
    if (messages.length === 0) return undefined;
    // Text-only path: images were already refused at acceptInterjection.
    const texts = messages.map((m) => m.text);
    let settled = false;
    return {
      messages: texts,
      accept: () => {
        if (settled) return;
        settled = true;
        this.accepted.push(...messages);
      },
      reject: () => {
        if (settled) return;
        settled = true;
        this.deferred.push(...messages);
      },
    };
  }

  /** Put rejected/unclaimed steers back for step-boundary drain (FIFO). */
  restoreDeferred(buffer: InterjectionBuffer): void {
    if (this.deferred.length === 0) return;
    buffer.restoreFront(this.deferred.splice(0, this.deferred.length));
  }
}
