/**
 * Product opt-in for C-9 Responses WebSocket `response.steer`.
 *
 * Hermetic wire + pump already ship (`responses-steer-wire.ts`). This module
 * attaches them to a real provider when `HZ_RESPONSES_STEER=1` and the model is
 * in the GPT-6 steer allowlist. Chat-completions streams still run; the WS is a
 * parallel steer channel. Without a `response.created` id, steers reject and the
 * LiveSteeringChannel deferred drain keeps user text for the step boundary.
 */

import type { Provider, ProviderEvent, ProviderRequest } from "../../contracts";
import {
  RESPONSES_STEER_MODELS,
  ResponsesSteerWire,
  pumpResponsesSteering,
  type SteerSocketFactory,
} from "./responses-steer-wire";

export function productResponsesSteerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.HZ_RESPONSES_STEER?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function modelSupportsResponsesSteer(model: string): boolean {
  const id = model.trim().toLowerCase();
  if (id === "") return false;
  return RESPONSES_STEER_MODELS.some((m) => id === m || id.startsWith(`${m}-`) || id.includes(m));
}

export interface ResponsesSteerProductOptions {
  apiKey: string;
  socketFactory?: SteerSocketFactory;
  /** Injectable env for tests. */
  env?: Record<string, string | undefined>;
}

/**
 * When product steer is enabled, mark `liveSteering` and pump claimed steers
 * over the Responses WS for GPT-6-class models. Other models stay unchanged.
 */
export function wrapProviderWithResponsesSteer(
  provider: Provider,
  opts: ResponsesSteerProductOptions,
): Provider {
  const env = opts.env ?? process.env;
  if (!productResponsesSteerEnabled(env)) return provider;
  if (opts.apiKey.trim() === "") return provider;

  const innerStream = provider.stream.bind(provider);
  return {
    name: provider.name,
    liveSteering: true,
    stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      if (!modelSupportsResponsesSteer(req.model) || req.liveSteering === undefined) {
        return innerStream(req);
      }
      return streamWithSteerPump(innerStream, req, opts);
    },
  };
}

async function* streamWithSteerPump(
  innerStream: (req: ProviderRequest) => AsyncIterable<ProviderEvent>,
  req: ProviderRequest,
  opts: ResponsesSteerProductOptions,
): AsyncIterable<ProviderEvent> {
  const steering = req.liveSteering;
  if (steering === undefined) {
    yield* innerStream(req);
    return;
  }
  const wire = new ResponsesSteerWire({
    apiKey: opts.apiKey,
    ...(opts.socketFactory !== undefined ? { socketFactory: opts.socketFactory } : {}),
  });
  const cut = new AbortController();
  const onAbort = (): void => cut.abort();
  req.signal.addEventListener("abort", onAbort, { once: true });
  let pump: Promise<void> | undefined;
  try {
    await wire.open();
    pump = pumpResponsesSteering(steering, wire, cut.signal);
    yield* innerStream(req);
  } finally {
    cut.abort();
    req.signal.removeEventListener("abort", onAbort);
    wire.close();
    if (pump !== undefined) {
      try {
        await pump;
      } catch {
        /* pump exits on abort */
      }
    }
  }
}
