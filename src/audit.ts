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
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
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
    this.onAppend?.(entry);
    return entry;
  }
}

export type VerifyResult =
  | { ok: true; count: number }
  | { ok: false; brokenSeq: number; reason: string; count: number };

/**
 * Re-walk a chain of entries and confirm it is intact: sequence numbers are
 * contiguous, each entry's recorded hash matches a recompute, and each entry's
 * prevHash links to the previous entry's hash. Returns the first break found.
 */
export function verifyEntries(entries: AuditEntry[]): VerifyResult {
  let expectedPrev = GENESIS;
  let expectedSeq = 0;
  for (const entry of entries) {
    if (entry.seq !== expectedSeq) {
      return {
        ok: false,
        brokenSeq: entry.seq,
        reason: `sequence gap: expected seq ${expectedSeq}, found ${entry.seq}`,
        count: entries.length,
      };
    }
    if (entry.prevHash !== expectedPrev) {
      return {
        ok: false,
        brokenSeq: entry.seq,
        reason: "prevHash does not match the previous entry's hash (chain link broken)",
        count: entries.length,
      };
    }
    const { hash, ...core } = entry;
    const recomputed = hashCore(core);
    if (recomputed !== hash) {
      return {
        ok: false,
        brokenSeq: entry.seq,
        reason: "hash mismatch (entry was altered after sealing)",
        count: entries.length,
      };
    }
    expectedPrev = hash;
    expectedSeq += 1;
  }
  return { ok: true, count: entries.length };
}

export function verifyFile(file: string): VerifyResult {
  return verifyEntries(readEntries(file));
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
