import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runSkill } from "../src/runner.js";
import { autoApprove, autoReject } from "../src/approval.js";
import { verifyFile } from "../src/audit.js";
import { keyDirFor, loadVerifier } from "../src/signing.js";
import type { ModelRunner } from "../src/model.js";

/** Structural + signature verification through the default key beside the file. */
function fullyVerified(auditFile: string): boolean {
  const result = verifyFile(auditFile, { verifier: loadVerifier(keyDirFor(auditFile)) });
  return result.ok && result.signaturesChecked && result.sealsVerified === 1;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = resolve(HERE, "..", "examples", "skills");

function tmpAudit(): string {
  return join(mkdtempSync(join(tmpdir(), "notary-run-")), "receipts.jsonl");
}

const fakeModel: ModelRunner = async () => ({
  text: "1. Liability clause is one-sided.\n2. No governing law.",
  model: "fake-model",
  usage: { inputTokens: 10, outputTokens: 20 },
});

// Deterministic injections so receipts are reproducible in tests.
const fixed = {
  now: () => new Date("2026-06-04T12:00:00.000Z"),
  newRunId: () => "test-run-1",
  model: fakeModel,
};

describe("runSkill", () => {
  it("completes the happy path and seals a verifiable receipt", async () => {
    const auditFile = tmpAudit();
    const res = await runSkill({
      skillDir: join(SKILLS, "contract-review"),
      granted: ["fs.read", "model.call"],
      input: "Some NDA text.",
      auditFile,
      approvalHook: autoApprove,
      ...fixed,
    });

    expect(res.status).toBe("completed");
    expect(res.output).toContain("Liability");
    // load, gate, approval.requested, approval.decided, run.started, run.finished, receipt.sealed
    expect(res.receipt.entries.map((e) => e.event)).toEqual([
      "skill.loaded",
      "gate.checked",
      "approval.requested",
      "approval.decided",
      "run.started",
      "run.finished",
      "receipt.sealed",
    ]);
    expect(fullyVerified(auditFile)).toBe(true);
  });

  it("denies a skill that over-reaches its granted capabilities", async () => {
    const auditFile = tmpAudit();
    const res = await runSkill({
      skillDir: join(SKILLS, "contract-review"),
      granted: ["fs.read"], // missing model.call
      input: "x",
      auditFile,
      approvalHook: autoApprove,
      ...fixed,
    });

    expect(res.status).toBe("denied");
    expect(res.output).toBeUndefined();
    const events = res.receipt.entries.map((e) => e.event);
    expect(events).toContain("gate.checked");
    expect(events).not.toContain("run.started");
    expect(fullyVerified(auditFile)).toBe(true);
  });

  it("records a rejection when approval is refused and never runs", async () => {
    const auditFile = tmpAudit();
    const res = await runSkill({
      skillDir: join(SKILLS, "contract-review"),
      granted: ["fs.read", "model.call"],
      input: "x",
      auditFile,
      approvalHook: autoReject,
      ...fixed,
    });

    expect(res.status).toBe("rejected");
    const events = res.receipt.entries.map((e) => e.event);
    expect(events).toContain("approval.decided");
    expect(events).not.toContain("run.started");
    expect(fullyVerified(auditFile)).toBe(true);
  });

  it("seals a verifiable receipt even when the model call fails", async () => {
    const auditFile = tmpAudit();
    const boom: ModelRunner = async () => {
      throw new Error("model exploded");
    };
    const res = await runSkill({
      skillDir: join(SKILLS, "summarise"),
      granted: ["fs.read", "model.call"],
      input: "x",
      auditFile,
      ...fixed,
      model: boom,
    });

    expect(res.status).toBe("failed");
    const finished = res.receipt.entries.find((e) => e.event === "run.finished");
    expect((finished?.payload as { error: string }).error).toContain("model exploded");
    // The chain is intact and sealed despite the failure.
    expect(res.receipt.entries.at(-1)?.event).toBe("receipt.sealed");
    expect(fullyVerified(auditFile)).toBe(true);
  });

  it("skips approval for a skill that does not require it", async () => {
    const auditFile = tmpAudit();
    const res = await runSkill({
      skillDir: join(SKILLS, "summarise"),
      granted: ["fs.read", "model.call"],
      input: "A document about cats.",
      auditFile,
      ...fixed,
    });

    expect(res.status).toBe("completed");
    const events = res.receipt.entries.map((e) => e.event);
    expect(events).not.toContain("approval.requested");
  });
});
