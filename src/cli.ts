#!/usr/bin/env node
process.removeAllListeners("warning"); // keep the demo output clean of dep warnings
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runSkill } from "./runner.js";
import { autoApprove, cliApprove } from "./approval.js";
import { verifyFile } from "./audit.js";
import { runMcpServer } from "./mcp.js";

/**
 * The CLI is the demo surface: `run` walks a skill through the five steps and
 * prints each beat; `verify` re-walks a receipt chain; `mcp` starts the server.
 * Argument parsing is deliberately hand-rolled — no framework, no config layer.
 */

const DEFAULT_AUDIT = ".notary/receipts.jsonl";
const DEFAULT_GRANT = ["fs.read", "model.call"];

function parseFlags(args: string[]): {
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const C = {
  ok: (s: string) => `\x1b[32m✓\x1b[0m ${s}`,
  bad: (s: string) => `\x1b[31m✗\x1b[0m ${s}`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

async function cmdRun(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const skillDir = positional[0];
  if (!skillDir) {
    console.error("usage: notary run <skill-dir> [--doc <file>] [--grant a,b] [--yes] [--audit <file>]");
    return 2;
  }

  const granted =
    typeof flags.grant === "string"
      ? flags.grant.split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_GRANT;
  const auditFile = typeof flags.audit === "string" ? flags.audit : DEFAULT_AUDIT;

  let input = "";
  if (typeof flags.doc === "string") {
    input = readFileSync(resolve(flags.doc), "utf8");
  } else if (typeof flags.input === "string") {
    input = flags.input;
  }

  // Print each beat live as the receipt seals it, so the approval prompt lands
  // in the right place in the output.
  const printBeat = (e: { event: string; skill: string; payload: Record<string, unknown> }) => {
    if (e.event === "skill.loaded") {
      console.log(C.ok(`skill loaded: ${e.skill}`));
    } else if (e.event === "gate.checked") {
      const p = e.payload as { allowed: boolean; declared: string[]; granted: string[]; missing: string[] };
      if (p.allowed) {
        console.log(C.ok(`gate: declared [${p.declared.join(", ")}] ⊆ granted [${p.granted.join(", ")}]`));
      } else {
        console.log(C.bad(`gate: denied — skill needs [${p.missing.join(", ")}] which was not granted`));
      }
    } else if (e.event === "approval.decided") {
      const p = e.payload as { approved: boolean; by: string };
      console.log(p.approved ? C.ok(`approved by ${p.by}`) : C.bad(`rejected by ${p.by}`));
    } else if (e.event === "run.started") {
      console.log(C.dim("… running …"));
    } else if (e.event === "run.finished") {
      const p = e.payload as { model: string; usage: { inputTokens: number; outputTokens: number } };
      console.log(C.dim(`ran with ${p.model} (${p.usage.inputTokens}+${p.usage.outputTokens} tokens)`));
    }
  };

  const res = await runSkill({
    skillDir: resolve(skillDir),
    granted,
    input,
    auditFile,
    approvalHook: flags.yes === true ? autoApprove : cliApprove,
    onEvent: printBeat,
  });

  if (res.status === "completed" && res.output !== undefined) {
    console.log("\n─ output " + "─".repeat(52));
    console.log(res.output);
    console.log("─".repeat(61) + "\n");
  } else if (res.status === "failed") {
    const last = res.receipt.entries.find((e) => e.event === "run.finished");
    const err = (last?.payload as { error?: string } | undefined)?.error ?? "unknown error";
    console.log(C.bad(`run failed: ${err}`));
  }

  console.log(
    C.ok(
      `receipt sealed: ${res.receipt.entries.length} entries → ${auditFile}`,
    ),
  );
  console.log(C.dim(`  verify with:  notary verify ${auditFile === DEFAULT_AUDIT ? "" : auditFile}`.trimEnd()));

  return res.status === "completed" ? 0 : 1;
}

function cmdVerify(args: string[]): number {
  const { positional } = parseFlags(args);
  const file = positional[0] ?? DEFAULT_AUDIT;
  const result = verifyFile(file);
  if (result.ok) {
    console.log(C.ok(`OK — ${result.count} entries, chain intact.`));
    return 0;
  }
  console.log(C.bad(`BROKEN at seq ${result.brokenSeq} — ${result.reason}`));
  return 1;
}

function usage(): void {
  console.log(`notary — tamper-evident, human-approved execution receipts for Claude skills

usage:
  notary run <skill-dir> [--doc <file>] [--input <text>] [--grant a,b] [--yes] [--audit <file>]
  notary verify [<receipts-file>]
  notary mcp

defaults:
  --grant   ${DEFAULT_GRANT.join(",")}
  --audit   ${DEFAULT_AUDIT}`);
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "run":
      return cmdRun(rest);
    case "verify":
      return cmdVerify(rest);
    case "mcp":
      await runMcpServer();
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      return 0;
    default:
      console.error(`unknown command: ${cmd}\n`);
      usage();
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(C.bad(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  },
);
