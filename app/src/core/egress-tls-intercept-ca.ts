/**
 * Hermetic test CA material for `HZ_EGRESS_TLS_INTERCEPT_CA` (ruling **281**).
 *
 * Production CONNECT forward does not terminate TLS; with intercept + CA the proxy
 * refuses the tunnel fail-closed until terminate/re-encrypt lands.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

export type HermeticInterceptCaPaths = {
  caCertPath: string;
  caKeyPath: string;
};

/** True when the path exists and looks like a PEM certificate chain/key file. */
export function egressTlsInterceptCaLoadable(caPath: string | undefined): boolean {
  if (typeof caPath !== "string" || caPath.trim() === "") return false;
  try {
    const text = readFileSync(caPath, "utf8");
    return text.includes("BEGIN CERTIFICATE") || text.includes("BEGIN PRIVATE KEY");
  } catch {
    return false;
  }
}

/**
 * When intercept is armed and a loadable CA path is set, CONNECT forward must
 * refuse (fail-closed) rather than passthrough — terminate is not implemented.
 */
export function egressTlsTerminateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HZ_EGRESS_TLS_TERMINATE?.trim();
  if (raw === "1") return true;
  return raw?.toLowerCase() === "true";
}

export function egressTlsInterceptRefuseForward(env: Record<string, string | undefined> = process.env): boolean {
  const armed = env.HZ_EGRESS_TLS_INTERCEPT?.trim();
  const interceptOn = armed === "1" || armed?.toLowerCase() === "true";
  if (!interceptOn) return false;
  if (!egressTlsInterceptCaLoadable(env.HZ_EGRESS_TLS_INTERCEPT_CA)) return false;
  if (egressTlsTerminateEnabled(env)) return false;
  return true;
}

/** CA signing key for terminate; defaults to sibling `.key.pem` of the cert path. */
export function egressTlsInterceptCaKeyPath(env: Record<string, string | undefined>): string | undefined {
  const explicit = env.HZ_EGRESS_TLS_INTERCEPT_CA_KEY?.trim();
  if (explicit) return explicit;
  const cert = env.HZ_EGRESS_TLS_INTERCEPT_CA?.trim();
  if (!cert) return undefined;
  if (cert.endsWith(".pem")) return cert.replace(/\.pem$/, ".key.pem");
  return `${cert}.key.pem`;
}

export type HermeticLeafCertMaterial = {
  certPem: string;
  keyPem: string;
};

/** Mint a short-lived leaf cert for `servername` signed by the hermetic intercept CA (openssl when present). */
export function mintHermeticLeafCert(
  caCertPath: string,
  caKeyPath: string,
  servername: string,
): HermeticLeafCertMaterial {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-leaf-"));
  const csrPath = path.join(dir, "leaf.csr");
  const keyPath = path.join(dir, "leaf.key.pem");
  const certPath = path.join(dir, "leaf.cert.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        csrPath,
        "-subj",
        `/CN=${servername}`,
      ],
      { stdio: "pipe" },
    );
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        csrPath,
        "-CA",
        caCertPath,
        "-CAkey",
        caKeyPath,
        "-CAcreateserial",
        "-out",
        certPath,
        "-days",
        "1",
      ],
      { stdio: "pipe" },
    );
    return { certPem: readFileSync(certPath, "utf8"), keyPem: readFileSync(keyPath, "utf8") };
  } catch {
    return {
      certPem: readFileSync(caCertPath, "utf8"),
      keyPem: readFileSync(caKeyPath, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const EGRESS_TLS_INTERCEPT_REFUSE_BODY =
  "HZ_EGRESS_TLS_INTERCEPT: CA configured but TLS terminate/re-encrypt is not implemented; refusing CONNECT (fail-closed; advisory only)";

/**
 * Writes a short-lived self-signed CA under `dir` for hermetic tests (openssl when present).
 */
export function writeHermeticInterceptCaMaterial(dir: string): HermeticInterceptCaPaths {
  const caCertPath = path.join(dir, "hz-intercept-ca.pem");
  const caKeyPath = path.join(dir, "hz-intercept-ca.key.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        caKeyPath,
        "-out",
        caCertPath,
        "-days",
        "1",
        "-subj",
        "/CN=hz-hermetic-intercept-ca",
      ],
      { stdio: "pipe" },
    );
    return { caCertPath, caKeyPath };
  } catch {
    writeFileSync(
      caCertPath,
      ["-----BEGIN CERTIFICATE-----", "hz-hermetic-intercept-ca-stub-281", "-----END CERTIFICATE-----", ""].join("\n"),
    );
    writeFileSync(
      caKeyPath,
      ["-----BEGIN PRIVATE KEY-----", "hz-hermetic-intercept-ca-stub-281", "-----END PRIVATE KEY-----", ""].join("\n"),
    );
    return { caCertPath, caKeyPath };
  }
}
