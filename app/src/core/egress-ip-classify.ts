/**
 * egress-ip-classify.ts — advisory non-public-IP classifier for the forward
 * dial path (codex `is_non_public_ip` / grok egress ADAPT).
 *
 * Pure: classifies a literal IP (no DNS, no IO). Used by the advisory dial-pin
 * seam (790) to flag rebind targets in non-public ranges. Unknown/garbage is
 * NON-PUBLIC (fail closed). Advisory only — never shell-net `enforced`.
 */

export type IpClass =
  | "loopback"
  | "private"
  | "link_local"
  | "unspecified"
  | "multicast"
  | "reserved"
  | "public";

export interface ParsedIp {
  class: IpClass;
  version: 4 | 6;
}

const STRICT_IPV4_RE = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

function parseStrictIpv4ToU32(ip: string): number | undefined {
  if (!STRICT_IPV4_RE.test(ip)) return undefined;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return undefined;
  }
  const [a, b, c, d] = parts as [number, number, number, number];
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
}

function classifyIpv4U32(u32: number): IpClass {
  const first = u32 >>> 24;
  if (first === 0) return "unspecified"; // 0.0.0.0/8
  if (first === 127) return "loopback"; // 127.0.0.0/8
  if (first === 10) return "private"; // 10.0.0.0/8
  if (((u32 & 0xfff00000) >>> 0) === 0xac100000) return "private"; // 172.16.0.0/12
  if (((u32 & 0xffff0000) >>> 0) === 0xc0a80000) return "private"; // 192.168.0.0/16
  if (((u32 & 0xffc00000) >>> 0) === 0x64400000) return "private"; // 100.64.0.0/10 (CGNAT)
  if (((u32 & 0xffff0000) >>> 0) === 0xa9fe0000) return "link_local"; // 169.254.0.0/16
  if (((u32 & 0xf0000000) >>> 0) === 0xe0000000) return "multicast"; // 224.0.0.0/4
  if (((u32 & 0xf0000000) >>> 0) === 0xf0000000) return "reserved"; // 240.0.0.0/4 & 255.255.255.255
  return "public";
}

function parseStrictIpv6ToBigInt(ip: string): bigint | undefined {
  if (!ip.includes(":")) return undefined;
  // Reject zone identifiers or whitespace or triple colons.
  if (ip.includes("%") || /\s/.test(ip) || ip.includes(":::")) return undefined;

  const doubleColonParts = ip.split("::");
  if (doubleColonParts.length > 2) return undefined;

  const parseSide = (side: string, allowEmbeddedV4: boolean): number[] | undefined => {
    if (side === "") return [];
    const tokens = side.split(":");
    const groups: number[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i]!;
      if (tok === "") return undefined;
      if (allowEmbeddedV4 && i === tokens.length - 1 && tok.includes(".")) {
        const v4 = parseStrictIpv4ToU32(tok);
        if (v4 === undefined) return undefined;
        groups.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(tok)) return undefined;
        groups.push(Number.parseInt(tok, 16));
      }
    }
    return groups;
  };

  let groups: number[];
  if (doubleColonParts.length === 1) {
    const parsed = parseSide(doubleColonParts[0]!, true);
    if (!parsed || parsed.length !== 8) return undefined;
    groups = parsed;
  } else {
    const left = parseSide(doubleColonParts[0]!, false);
    const right = parseSide(doubleColonParts[1]!, true);
    if (!left || !right) return undefined;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return undefined;
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  }

  let acc = 0n;
  for (const g of groups) {
    acc = (acc << 16n) | BigInt(g);
  }
  return acc;
}

function classifyIpv6BigInt(v6: bigint): IpClass {
  if (v6 === 0n) return "unspecified"; // ::/128
  if (v6 === 1n) return "loopback"; // ::1/128
  // IPv4-mapped IPv6 ::ffff:0:0/96
  if ((v6 >> 32n) === 0xffffn) {
    return classifyIpv4U32(Number(v6 & 0xffffffffn));
  }
  // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48
  if ((v6 >> 32n) === 0x0064ff9b0000000000000000n || (v6 >> 80n) === 0x0064ff9b0001n) {
    return "private";
  }
  // Deprecated IPv4-compatible ::/96 (other than :: and ::1)
  if ((v6 >> 32n) === 0n) {
    return classifyIpv4U32(Number(v6 & 0xffffffffn));
  }
  // Link-local fe80::/10
  if ((v6 >> 118n) === 0x3fan) return "link_local";
  // Unique Local Address (ULA) fc00::/7
  if ((v6 >> 121n) === 0x7en) return "private";
  // Multicast ff00::/8
  if ((v6 >> 120n) === 0xffn) return "multicast";
  // Discard-only 100::/64
  if ((v6 >> 64n) === 0x0100000000000000n) return "reserved";
  return "public";
}

export function parseIpLiteral(value: string): ParsedIp | undefined {
  if (typeof value !== "string") return undefined;
  let ip = value.trim();
  if (ip === "") return undefined;
  if (ip.startsWith("[") || ip.endsWith("]")) {
    if (!ip.startsWith("[") || !ip.endsWith("]")) return undefined;
    ip = ip.slice(1, -1);
    if (!ip.includes(":")) return undefined;
  }

  if (ip.includes(":")) {
    const v6 = parseStrictIpv6ToBigInt(ip);
    if (v6 === undefined) return undefined;
    return { class: classifyIpv6BigInt(v6), version: 6 };
  }

  const u32 = parseStrictIpv4ToU32(ip);
  if (u32 === undefined) return undefined;
  return { class: classifyIpv4U32(u32), version: 4 };
}

/** True when an address is NOT a public unicast address (fail-closed on garbage). */
export function isNonPublicIp(value: string): boolean {
  const parsed = parseIpLiteral(value);
  if (parsed === undefined) return true;
  return parsed.class !== "public";
}
