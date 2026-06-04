import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * The receipt is an append-only, hash-chained log. Each entry stores the
 * SHA-256 of the entry before it (`prevHash`), and its own `hash` is computed
 * over its canonical content *including* that prevHash. So the entries form a
 * chain: editing any past entry changes its hash, which no longer matches the
 * `prevHash` recorded in the next entry — `verify` finds exactly where.
 *
 * No database. The whole store is one JSONL file.
 */

export type AuditEvent =
  | "skill.loaded"
  | "gate.checked"
  | "approval.requested"
  | "approval.decided"
  | "run.started"
  | "run.finished"
  | "receipt.sealed";

/** The fields that are hashed. `hash` is derived, so it is excluded. */
export interface AuditCore {
  seq: number;
  ts: string;
  runId: string;
  event: AuditEvent;
  skill: string;
  payload: Record<string, unknown>;
  prevHash: string;
}

export interface AuditEntry extends AuditCore {
  hash: string;
}

/** Genesis prevHash for the very first entry in a fresh log. */
export const GENESIS = "0".repeat(64);

/**
 * Deterministic JSON: object keys sorted recursively so the same logical
 * content always hashes to the same string regardless of key insertion order.
 * `undefined` is normalised the way JSON.stringify treats it — dropped as an
 * object property, rendered as `null` inside an array — so this never emits the
 * invalid token `undefined` into the hashed string. Payloads are expected to be
 * JSON-clean data; this just removes the foot-gun in the hashing path.
 */
export function canonicalJSON(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJSON(v === undefined ? null : v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`,
  );
  return `{${parts.join(",")}}`;
}

export function hashCore(core: AuditCore): string {
  return createHash("sha256").update(canonicalJSON(core)).digest("hex");
}

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Read every entry from a receipts file (returns [] if it does not exist). */
export function readEntries(file: string): AuditEntry[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditEntry);
}

/**
 * An append-only audit log bound to a single JSONL file. Construct one, then
 * `append()` events; each call links to and is persisted immediately after the
 * previous one.
 */
export class AuditLog {
  private seq: number;
  private prevHash: string;

  /**
   * @param file       where the chain is appended
   * @param onAppend   optional hook fired after each entry is persisted, used
   *                   by the CLI to stream beats live as they happen
   */
  constructor(
    public readonly file: string,
    private readonly onAppend?: (entry: AuditEntry) => void,
  ) {
    const existing = readEntries(file);
    if (existing.length > 0) {
      const last = existing[existing.length - 1];
      this.seq = last.seq + 1;
      this.prevHash = last.hash;
    } else {
      this.seq = 0;
      this.prevHash = GENESIS;
    }
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** The current chain head: the seq and prevHash the next entry will carry. */
  currentHead(): { seq: number; prevHash: string } {
    return { seq: this.seq, prevHash: this.prevHash };
  }

  append(params: {
    ts: string;
    runId: string;
    event: AuditEvent;
    skill: string;
    payload?: Record<string, unknown>;
  }): AuditEntry {
    const core: AuditCore = {
      seq: this.seq,
      ts: params.ts,
      runId: params.runId,
      event: params.event,
      skill: params.skill,
      payload: params.payload ?? {},
      prevHash: this.prevHash,
    };
    const hash = hashCore(core);
    const entry: AuditEntry = { ...core, hash };
    appendFileSync(this.file, JSON.stringify(entry) + "\n");
    this.seq += 1;
    this.prevHash = hash;
    // The onAppend hook is for display only; a buggy hook must never be able to
    // break sealing or corrupt the chain, so its errors are swallowed.
    try {
      this.onAppend?.(entry);
    } catch {
      /* ignore */
    }
    return entry;
  }
}

/** The signature-bearing fields a sealed receipt carries in its payload. */
export interface SealCommitment {
  status: string;
  runCount: number;
  runFinalSeq: number;
  runHeadHash: string;
}

/** Anything that can check an Ed25519 signature over a message. */
export interface SignatureChecker {
  keyId: string;
  verify(message: string, signatureB64: string): boolean;
}

/**
 * The exact message that is signed for a sealed receipt: the seal's core with
 * the signature and keyId stripped from the payload (you cannot sign your own
 * signature). Signer and verifier must build this identically.
 */
export function sealSigningMessage(
  core: Omit<AuditCore, "payload">,
  commitment: SealCommitment,
): string {
  return canonicalJSON({
    seq: core.seq,
    ts: core.ts,
    runId: core.runId,
    event: core.event,
    skill: core.skill,
    payload: commitment,
    prevHash: core.prevHash,
  });
}

export type VerifyResult =
  | {
      ok: true;
      count: number;
      /** Sealed receipts whose signature was checked and passed. */
      sealsVerified: number;
      /** False when no public key was available to check signatures. */
      signaturesChecked: boolean;
    }
  | { ok: false; brokenSeq: number; reason: string; count: number };

export interface VerifyOptions {
  /** Public-key checker; when present, every sealed receipt's signature is verified. */
  verifier?: SignatureChecker | null;
  /** Expected hash of the final entry; pin this externally to catch tail truncation. */
  expectedHead?: string;
}

/**
 * Re-walk a chain and confirm it is intact AND, when a verifier is supplied,
 * that every sealed receipt carries a valid signature over its committed
 * content. The structural check alone catches corruption and naive edits; the
 * signature check is what defeats a file-rewriting attacker who recomputes the
 * chain forward. Returns the first break found.
 */
export function verifyEntries(
  entries: AuditEntry[],
  options: VerifyOptions = {},
): VerifyResult {
  const { verifier, expectedHead } = options;
  let expectedPrev = GENESIS;
  let expectedSeq = 0;
  let sealsVerified = 0;

  for (const entry of entries) {
    if (entry.seq !== expectedSeq) {
      return broken(entry.seq, `sequence gap: expected seq ${expectedSeq}, found ${entry.seq}`, entries.length);
    }
    if (entry.prevHash !== expectedPrev) {
      return broken(entry.seq, "prevHash does not match the previous entry's hash (chain link broken)", entries.length);
    }
    const { hash, ...core } = entry;
    if (hashCore(core) !== hash) {
      return broken(entry.seq, "hash mismatch (entry was altered after sealing)", entries.length);
    }

    if (entry.event === "receipt.sealed" && verifier) {
      const sealError = checkSeal(entry, entries, verifier);
      if (sealError) return broken(entry.seq, sealError, entries.length);
      sealsVerified += 1;
    }

    expectedPrev = hash;
    expectedSeq += 1;
  }

  if (expectedHead !== undefined) {
    const actualHead = entries.length > 0 ? entries[entries.length - 1].hash : GENESIS;
    if (actualHead !== expectedHead) {
      return broken(
        expectedSeq,
        `final hash ${actualHead.slice(0, 12)}… does not match the pinned head ${expectedHead.slice(0, 12)}… (entries may have been truncated)`,
        entries.length,
      );
    }
  }

  return {
    ok: true,
    count: entries.length,
    sealsVerified,
    signaturesChecked: Boolean(verifier),
  };
}

function broken(brokenSeq: number, reason: string, count: number): VerifyResult {
  return { ok: false, brokenSeq, reason, count };
}

/** Verify one sealed receipt's signature and that it commits to real content. */
function checkSeal(
  entry: AuditEntry,
  entries: AuditEntry[],
  verifier: SignatureChecker,
): string | null {
  const p = entry.payload as Record<string, unknown>;
  const signature = p.signature;
  const keyId = p.keyId;
  if (typeof signature !== "string" || typeof keyId !== "string") {
    return "sealed receipt is missing its signature (was it produced by an older notary?)";
  }
  if (keyId !== verifier.keyId) {
    return `sealed receipt was signed by key ${keyId} but verified against ${verifier.keyId} (wrong key)`;
  }
  const commitment: SealCommitment = {
    status: String(p.status ?? ""),
    runCount: Number(p.runCount),
    runFinalSeq: Number(p.runFinalSeq),
    runHeadHash: String(p.runHeadHash ?? ""),
  };
  // The committed values must match what is actually in the chain.
  if (commitment.runFinalSeq !== entry.seq) {
    return "sealed receipt's committed seq does not match its position";
  }
  if (commitment.runHeadHash !== entry.prevHash) {
    return "sealed receipt's committed head does not match the chain (an entry was added or removed before the seal)";
  }
  const actualRunCount = entries.filter((e) => e.runId === entry.runId).length;
  if (commitment.runCount !== actualRunCount) {
    return `sealed receipt committed to ${commitment.runCount} entries but ${actualRunCount} are present (entries added or removed)`;
  }
  const message = sealSigningMessage(entry, commitment);
  if (!verifier.verify(message, signature)) {
    return "invalid signature (the receipt was forged or altered after signing)";
  }
  return null;
}

export function verifyFile(file: string, options: VerifyOptions = {}): VerifyResult {
  return verifyEntries(readEntries(file), options);
}

/** Extract the entries for one run plus a compact chain proof. */
export function extractReceipt(entries: AuditEntry[], runId: string) {
  const slice = entries.filter((e) => e.runId === runId);
  return {
    runId,
    entries: slice,
    proof:
      slice.length > 0
        ? {
            firstPrevHash: slice[0].prevHash,
            finalHash: slice[slice.length - 1].hash,
            count: slice.length,
          }
        : null,
  };
}
