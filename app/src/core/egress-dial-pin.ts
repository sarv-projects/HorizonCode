/**
 * egress-dial-pin.ts -- advisory dial-time DNS rebind re-check
 * (plan Task 12).
 *
 * Pure seam over an injected resolver: no live DNS, no traffic interception,
 * no authority widening. It never changes a Guard `ask` into `allow`; the
 * kernel egress decider is untouched. Shell-net egress is never `enforced`.
 */

import { isIP } from "node:net";

export const DIAL_PIN_TTL_MS = 30_000;

export class EgressRebindRefused extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
    readonly address: string,
  ) {
    super(`egress dial refused: ${host}:${port} resolved to unpinned address ${address}`);
    this.name = "EgressRebindRefused";
  }
}

export interface DialPin {
  host: string;
  port: number;
  addresses: readonly string[];
  resolvedAtMs: number;
}

export interface DialPinDeps {
  resolve(host: string): Promise<readonly string[]>;
  now(): number;
  /** ADDITIVE advisory: refuse resolved non-public IPs (SSRF guard). Default off. */
  refuseNonPublic?: boolean;
}

export async function resolveAndPin(
  host: string,
  port: number,
  deps: DialPinDeps,
): Promise<DialPin> {
  if (host.trim() === "") throw new Error("HZ_PRECONDITION_FAILED: dial pin requires a host");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("HZ_PRECONDITION_FAILED: dial pin requires a valid port");
  }
  const answers = (await deps.resolve(host)).map((answer) => answer.trim()).filter((answer) => answer !== "");
  if (answers.length === 0) throw new Error("HZ_PRECONDITION_FAILED: dial pin resolver returned no addresses");
  const invalid = answers.find((answer) => isIP(answer) === 0);
  if (invalid !== undefined) {
    throw new Error(`HZ_PRECONDITION_FAILED: dial pin resolver returned a non-IP address: ${invalid}`);
  }
  // ADDITIVE (advisory SSRF guard): when requested, refuse resolved addresses
  // in non-public ranges (loopback/private/link-local/metadata). Default off.
  if (deps.refuseNonPublic === true) {
    const { isNonPublicIp } = await import("./egress-ip-classify");
    const unsafe = answers.find(isNonPublicIp);
    if (unsafe !== undefined) {
      throw new Error(`HZ_PRECONDITION_FAILED: dial pin resolved to a non-public address: ${unsafe}`);
    }
  }
  return {
    host,
    port,
    addresses: Object.freeze([...new Set(answers)]),
    resolvedAtMs: deps.now(),
  };
}

/** Must be called immediately before a dial when a pin was requested. */
export function assertDialAddressStillPinned(pin: DialPin, address: string): void {
  if (!pin.addresses.includes(address)) throw new EgressRebindRefused(pin.host, pin.port, address);
}

export function pinExpired(pin: DialPin, nowMs: number, ttlMs = DIAL_PIN_TTL_MS): boolean {
  return nowMs - pin.resolvedAtMs >= ttlMs;
}
