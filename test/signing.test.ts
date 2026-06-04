import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSkill } from "../src/runner.js";
import { autoApprove } from "../src/approval.js";
import {
  hashCore,
  readEntries,
  verifyFile,
  type AuditEntry,
} from "../src/audit.js";
import { keyDirFor, loadVerifier } from "../src/signing.js";
import type { ModelRunner } from "../src/model.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = resolve(HERE, "..", "examples", "skills");

function tmpAudit(): string {
  return join(mkdtempSync(join(tmpdir(), "notary-sign-")), "receipts.jsonl");
}

const fixed = {
  now: () => new Date("2026-06-04T12:00:00.000Z"),
  newRunId: () => "run-1",
  model: (async () => ({
    text: "ok",
    model: "fake",
    usage: { inputTokens: 1, outputTokens: 1 },
  })) as ModelRunner,
};

async function sealedRun(auditFile: string) {
  return runSkill({
    skillDir: join(SKILLS, "summarise"),
    granted: ["fs.read", "model.call"],
    input: "doc",
    auditFile,
    approvalHook: autoApprove,
    ...fixed,
  });
}

function writeAll(file: string, entries: AuditEntry[]) {
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("signed receipts defeat a file-rewriting attacker", () => {
  it("ATTACK A — recompute-forward forgery is caught by the signature", async () => {
    const file = tmpAudit();
    await sealedRun(file);
    const verifier = loadVerifier(keyDirFor(file));

    // Honest receipt verifies.
    expect(verifyFile(file, { verifier }).ok).toBe(true);

    // Attacker edits a past entry, then recomputes EVERY hash forward so the
    // chain is internally consistent again (the reviewer's 10-line attack).
    const entries = readEntries(file);
    (entries[0].payload as Record<string, unknown>).description = "FORGED";
    let prevHash = entries[0].prevHash;
    for (const e of entries) {
      e.prevHash = prevHash;
      const { hash, ...core } = e;
      e.hash = hashCore(core);
      prevHash = e.hash;
    }
    writeAll(file, entries);

    // Without the key, the forged chain looks structurally fine — the old hole.
    expect(verifyFile(file).ok).toBe(true);

    // With the key, the seal's signature no longer matches: forgery caught.
    const result = verifyFile(file, { verifier });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/signature|head|entries/i);
  });

  it("ATTACK A+ — even a fully self-consistent forgery fails the signature", async () => {
    const file = tmpAudit();
    await sealedRun(file);
    const verifier = loadVerifier(keyDirFor(file));

    // The sophisticated attacker forges content, recomputes all hashes forward,
    // AND rewrites the seal's committed head/seq/count to match the new chain —
    // so every structural and commitment check passes. Only the signature, which
    // they cannot reproduce without the private key, still betrays them.
    const entries = readEntries(file);
    (entries[0].payload as Record<string, unknown>).description = "FORGED";
    let prevHash = entries[0].prevHash;
    for (const e of entries) {
      e.prevHash = prevHash;
      if (e.event === "receipt.sealed") {
        // make the commitment self-consistent with the forged chain
        (e.payload as Record<string, unknown>).runHeadHash = prevHash;
        (e.payload as Record<string, unknown>).runFinalSeq = e.seq;
        (e.payload as Record<string, unknown>).runCount = entries.filter((x) => x.runId === e.runId).length;
      }
      const { hash, ...core } = e;
      e.hash = hashCore(core);
      prevHash = e.hash;
    }
    writeAll(file, entries);

    const result = verifyFile(file, { verifier });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/invalid signature/i);
  });

  it("ATTACK B — tail truncation is caught by pinning the head", async () => {
    const file = tmpAudit();
    const res = await sealedRun(file);
    const verifier = loadVerifier(keyDirFor(file));
    const pinnedHead = res.receipt.entries.at(-1)!.hash;

    // Drop the last two entries (e.g. to hide the sealed outcome).
    const entries = readEntries(file);
    writeAll(file, entries.slice(0, -2));

    // The surviving prefix is internally consistent, so a naive check passes…
    expect(verifyFile(file, { verifier }).ok).toBe(true);
    // …but pinning the previously-recorded head detects the truncation.
    const result = verifyFile(file, { verifier, expectedHead: pinnedHead });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/truncat|head/i);
  });

  it("removing an entry from within a sealed run breaks the committed count", async () => {
    const file = tmpAudit();
    await sealedRun(file);
    const verifier = loadVerifier(keyDirFor(file));

    // Remove the run.finished entry but keep the seal, then recompute hashes
    // forward so the chain links are consistent.
    let entries = readEntries(file).filter((e) => e.event !== "run.finished");
    let prevHash = entries[0].prevHash;
    for (const e of entries) {
      e.prevHash = prevHash;
      const { hash, ...core } = e;
      e.hash = hashCore(core);
      prevHash = e.hash;
    }
    writeAll(file, entries);

    const result = verifyFile(file, { verifier });
    expect(result.ok).toBe(false);
  });

  it("a wrong public key is reported, not silently accepted", async () => {
    const file = tmpAudit();
    await sealedRun(file);
    // A different, unrelated key.
    const otherDir = tmpAudit();
    await sealedRun(otherDir);
    const wrongVerifier = loadVerifier(keyDirFor(otherDir));

    const result = verifyFile(file, { verifier: wrongVerifier });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/key|signature/i);
  });

  it("an honest receipt verifies and reports the signature was checked", async () => {
    const file = tmpAudit();
    await sealedRun(file);
    const result = verifyFile(file, { verifier: loadVerifier(keyDirFor(file)) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signaturesChecked).toBe(true);
      expect(result.sealsVerified).toBe(1);
    }
  });
});
