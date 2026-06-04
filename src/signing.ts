import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "./audit.js";

/**
 * The external root of trust. A hash chain proves a record is internally
 * consistent; it does NOT stop someone who can rewrite the whole file and
 * recompute every hash forward. The signature does: each sealed receipt is
 * signed with an Ed25519 private key, and anyone holding only the public key can
 * verify it. Without the private key you cannot forge or alter a sealed receipt.
 *
 * Zero-infra by design: keys are local. The private key comes from the
 * NOTARY_PRIVATE_KEY env var or a local key file (which the operator secures);
 * the public key is what you hand to whoever needs to verify. No KMS, no
 * service. The precise guarantee is therefore "unforgeable without the signing
 * key" — keep the private key off the box that ships receipts to be verified.
 */

const PRIV_FILE = "notary.key"; // base64 PKCS8 DER, private — keep secret
const PUB_FILE = "notary.pub"; // base64 SPKI DER, public — share for verifying

export interface Signer {
  keyId: string;
  publicKeyB64: string;
  sign(message: string): string;
}

export interface SigVerifier {
  keyId: string;
  verify(message: string, signatureB64: string): boolean;
}

function privFromB64(b64: string): KeyObject {
  return createPrivateKey({
    key: Buffer.from(b64, "base64"),
    format: "der",
    type: "pkcs8",
  });
}

function pubFromB64(b64: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(b64, "base64"),
    format: "der",
    type: "spki",
  });
}

function publicKeyB64(pub: KeyObject): string {
  return pub.export({ format: "der", type: "spki" }).toString("base64");
}

function privateKeyB64(priv: KeyObject): string {
  return priv.export({ format: "der", type: "pkcs8" }).toString("base64");
}

/** Short, stable fingerprint of a public key, recorded in each sealed receipt. */
export function keyIdOf(pubB64: string): string {
  return sha256(pubB64).slice(0, 16);
}

function signerFrom(priv: KeyObject): Signer {
  const pub = createPublicKey(priv);
  const pubB64 = publicKeyB64(pub);
  return {
    keyId: keyIdOf(pubB64),
    publicKeyB64: pubB64,
    sign: (message: string) =>
      cryptoSign(null, Buffer.from(message, "utf8"), priv).toString("base64"),
  };
}

export function verifierFrom(pubB64: string): SigVerifier {
  const pub = pubFromB64(pubB64);
  return {
    keyId: keyIdOf(pubB64),
    verify: (message: string, signatureB64: string) => {
      try {
        return cryptoVerify(
          null,
          Buffer.from(message, "utf8"),
          pub,
          Buffer.from(signatureB64, "base64"),
        );
      } catch {
        return false;
      }
    },
  };
}

/**
 * Resolve the signing key, in priority order:
 *   1. NOTARY_PRIVATE_KEY env var (base64 PKCS8 DER)
 *   2. <keyDir>/notary.key
 *   3. generate a fresh keypair, persist it (private 0600), and notify once
 * Always (re)writes <keyDir>/notary.pub so a verifier can find the public key.
 */
export function loadOrCreateSigner(
  keyDir: string,
  notify: (msg: string) => void = () => {},
): Signer {
  const envKey = process.env.NOTARY_PRIVATE_KEY;
  if (envKey) {
    return signerFrom(privFromB64(envKey.trim()));
  }

  if (!existsSync(keyDir)) mkdirSync(keyDir, { recursive: true });
  const privPath = join(keyDir, PRIV_FILE);
  const pubPath = join(keyDir, PUB_FILE);

  let priv: KeyObject;
  if (existsSync(privPath)) {
    priv = privFromB64(readFileSync(privPath, "utf8").trim());
  } else {
    const pair = generateKeyPairSync("ed25519");
    priv = pair.privateKey;
    writeFileSync(privPath, privateKeyB64(priv) + "\n", { mode: 0o600 });
    chmodSync(privPath, 0o600);
    notify(
      `generated a signing key at ${privPath} (keep it secret). ` +
        `public key written to ${pubPath} — share that to let others verify.`,
    );
  }

  const signer = signerFrom(priv);
  writeFileSync(pubPath, signer.publicKeyB64 + "\n");
  return signer;
}

/**
 * Resolve a public key for verification: an explicit base64 string, else
 * <keyDir>/notary.pub. Returns null if none is available (then verify can only
 * do the structural chain check, not prove the signatures).
 */
export function loadVerifier(
  keyDir: string,
  publicKeyB64Override?: string,
): SigVerifier | null {
  if (publicKeyB64Override) return verifierFrom(publicKeyB64Override.trim());
  const pubPath = join(keyDir, PUB_FILE);
  if (existsSync(pubPath)) {
    return verifierFrom(readFileSync(pubPath, "utf8").trim());
  }
  return null;
}

/** The conventional key directory that sits beside a receipts file. */
export function keyDirFor(auditFile: string): string {
  return dirname(auditFile);
}
