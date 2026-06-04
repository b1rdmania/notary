import { randomUUID } from "node:crypto";
import {
  AuditLog,
  extractReceipt,
  readEntries,
  sealSigningMessage,
  sha256,
} from "./audit.js";
import type { AuditEntry, SealCommitment } from "./audit.js";
import { checkGate } from "./gate.js";
import { loadSkill } from "./skill.js";
import type { ApprovalHook } from "./approval.js";
import { cliApprove } from "./approval.js";
import type { ModelRunner } from "./model.js";
import { anthropicRunner } from "./model.js";
import type { Signer } from "./signing.js";
import { keyDirFor, loadOrCreateSigner } from "./signing.js";

/**
 * The core. Walks a single skill through the five steps — load, gate, approve,
 * run, receipt — appending a hash-chained entry at each one. Everything that
 * touches the outside world (the clock, the run id, the approval hook, the
 * model) is injectable, so the whole flow is testable offline.
 */

export interface RunOptions {
  skillDir: string;
  /** Capabilities the operator grants for this run. */
  granted: string[];
  /** The user input the skill acts on (e.g. document text). */
  input: string;
  /** Where the receipt chain is written. */
  auditFile: string;
  /** Approval hook. Defaults to a CLI prompt. */
  approvalHook?: ApprovalHook;
  /** Force approval even if the skill's manifest does not require it. */
  requireApproval?: boolean;
  /** Model runner. Defaults to the Anthropic SDK. */
  model?: ModelRunner;
  /** Ed25519 signer for sealing receipts. Defaults to a local key beside the audit file. */
  signer?: Signer;
  /** Clock, injectable for deterministic tests. */
  now?: () => Date;
  /** Run id generator, injectable for deterministic tests. */
  newRunId?: () => string;
  /** Fired as each receipt entry is sealed, so callers can stream beats live. */
  onEvent?: (entry: AuditEntry) => void;
}

export type RunStatus = "denied" | "rejected" | "completed" | "failed";

export interface RunResult {
  status: RunStatus;
  runId: string;
  skill: string;
  output?: string;
  /** The slice of receipt entries for this run plus a chain proof. */
  receipt: { runId: string; entries: AuditEntry[]; proof: unknown };
}

export async function runSkill(opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? (() => new Date());
  const newRunId = opts.newRunId ?? (() => randomUUID());
  const approvalHook = opts.approvalHook ?? cliApprove;
  const model = opts.model ?? anthropicRunner;
  const signer =
    opts.signer ?? loadOrCreateSigner(keyDirFor(opts.auditFile), (m) => console.error(`notary: ${m}`));

  const runId = newRunId();
  const log = new AuditLog(opts.auditFile, opts.onEvent);
  const ts = () => now().toISOString();

  // 1. Load
  const skill = loadSkill(opts.skillDir);
  const skillName = skill.manifest.name;
  log.append({
    ts: ts(),
    runId,
    event: "skill.loaded",
    skill: skillName,
    payload: {
      description: skill.manifest.description,
      capabilities: skill.manifest.capabilities,
      requiresApproval: skill.manifest.requiresApproval,
      promptHash: sha256(skill.prompt),
    },
  });

  // 2. Gate
  const gate = checkGate(skill.manifest.capabilities, opts.granted);
  log.append({
    ts: ts(),
    runId,
    event: "gate.checked",
    skill: skillName,
    payload: {
      allowed: gate.allowed,
      declared: gate.declared,
      granted: gate.granted,
      missing: gate.missing,
    },
  });
  if (!gate.allowed) {
    return finish("denied", runId, skillName, log, opts.auditFile, ts, signer, undefined);
  }

  // 3. Approve
  const mustApprove = skill.manifest.requiresApproval || opts.requireApproval === true;
  if (mustApprove) {
    log.append({
      ts: ts(),
      runId,
      event: "approval.requested",
      skill: skillName,
      payload: { capabilities: skill.manifest.capabilities },
    });
    const decision = await approvalHook({
      skill: skillName,
      description: skill.manifest.description,
      capabilities: skill.manifest.capabilities,
      runId,
    });
    log.append({
      ts: ts(),
      runId,
      event: "approval.decided",
      skill: skillName,
      payload: { approved: decision.approved, by: decision.by, reason: decision.reason ?? "" },
    });
    if (!decision.approved) {
      return finish("rejected", runId, skillName, log, opts.auditFile, ts, signer, undefined);
    }
  }

  // 4. Run. A failure still seals a receipt — a failed run is evidence too.
  log.append({
    ts: ts(),
    runId,
    event: "run.started",
    skill: skillName,
    payload: { inputHash: sha256(opts.input) },
  });
  let result;
  try {
    result = await model({ system: skill.prompt, input: opts.input });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.append({
      ts: ts(),
      runId,
      event: "run.finished",
      skill: skillName,
      payload: { error: message },
    });
    return finish("failed", runId, skillName, log, opts.auditFile, ts, signer, undefined);
  }
  log.append({
    ts: ts(),
    runId,
    event: "run.finished",
    skill: skillName,
    payload: {
      model: result.model,
      usage: result.usage,
      outputHash: sha256(result.text),
    },
  });

  // 5. Receipt
  return finish("completed", runId, skillName, log, opts.auditFile, ts, signer, result.text);
}

/**
 * Seal the run with a signed receipt. The signature commits to the run's final
 * seq, its entry count, and the chain head at seal time — so the sealed receipt
 * cannot be forged, reordered, or have entries added/removed without the key.
 */
function finish(
  status: RunStatus,
  runId: string,
  skill: string,
  log: AuditLog,
  auditFile: string,
  ts: () => string,
  signer: Signer,
  output: string | undefined,
): RunResult {
  const head = log.currentHead();
  const tsNow = ts();
  const runCountBeforeSeal = readEntries(auditFile).filter((e) => e.runId === runId).length;

  const commitment: SealCommitment = {
    status,
    runCount: runCountBeforeSeal + 1, // includes this seal entry
    runFinalSeq: head.seq,
    runHeadHash: head.prevHash,
  };
  const message = sealSigningMessage(
    { seq: head.seq, ts: tsNow, runId, event: "receipt.sealed", skill, prevHash: head.prevHash },
    commitment,
  );
  const signature = signer.sign(message);

  log.append({
    ts: tsNow,
    runId,
    event: "receipt.sealed",
    skill,
    payload: { ...commitment, signature, keyId: signer.keyId },
  });

  const receipt = extractReceipt(readEntries(auditFile), runId);
  return { status, runId, skill, output, receipt };
}
