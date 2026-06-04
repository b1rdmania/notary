import { describe, expect, it } from "vitest";
import {
  AuditLog,
  canonicalJSON,
  readEntries,
  verifyEntries,
  verifyFile,
} from "../src/audit.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "notary-audit-"));
  return join(dir, "receipts.jsonl");
}

const T = "2026-06-04T00:00:00.000Z";

describe("canonicalJSON", () => {
  it("sorts keys so logically-equal objects hash the same", () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe(canonicalJSON({ a: 2, b: 1 }));
    expect(canonicalJSON({ a: { y: 1, x: 2 } })).toBe('{"a":{"x":2,"y":1}}');
  });
});

describe("audit chain", () => {
  it("verifies an intact chain", () => {
    const file = tmpFile();
    const log = new AuditLog(file);
    log.append({ ts: T, runId: "r1", event: "skill.loaded", skill: "s" });
    log.append({ ts: T, runId: "r1", event: "run.started", skill: "s" });
    log.append({ ts: T, runId: "r1", event: "receipt.sealed", skill: "s" });
    const result = verifyFile(file);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.count).toBe(3);
  });

  it("detects a tampered payload in a past entry", () => {
    const file = tmpFile();
    const log = new AuditLog(file);
    log.append({ ts: T, runId: "r1", event: "skill.loaded", skill: "s" });
    log.append({ ts: T, runId: "r1", event: "gate.checked", skill: "s", payload: { allowed: false } });
    log.append({ ts: T, runId: "r1", event: "receipt.sealed", skill: "s" });

    const entries = readEntries(file);
    // Flip the gate decision but leave the recorded hash untouched.
    entries[1].payload = { allowed: true };
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const result = verifyFile(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenSeq).toBe(1);
  });

  it("detects a deleted entry as a broken chain link", () => {
    const file = tmpFile();
    const log = new AuditLog(file);
    log.append({ ts: T, runId: "r1", event: "skill.loaded", skill: "s" });
    log.append({ ts: T, runId: "r1", event: "run.started", skill: "s" });
    log.append({ ts: T, runId: "r1", event: "receipt.sealed", skill: "s" });

    const entries = readEntries(file);
    entries.splice(1, 1); // remove the middle entry
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const result = verifyEntries(readEntries(file));
    expect(result.ok).toBe(false);
  });

  it("continues the chain across separate AuditLog sessions", () => {
    const file = tmpFile();
    new AuditLog(file).append({ ts: T, runId: "r1", event: "skill.loaded", skill: "s" });
    new AuditLog(file).append({ ts: T, runId: "r2", event: "skill.loaded", skill: "s" });
    const result = verifyFile(file);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.count).toBe(2);
  });
});
