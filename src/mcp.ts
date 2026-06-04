import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * The MCP server is notary's distribution surface: any MCP client (Claude
 * Desktop, Cursor, …) can run a skill through the same gate → approve → run →
 * receipt path. It exposes two tools — `run_skill` and `verify_receipt`.
 *
 * There is no terminal to prompt on over stdio, so notary does NOT silently
 * auto-approve — that would contradict the "human-approved" guarantee. Instead
 * the caller must assert that a human approved by passing `approve: true`. If a
 * skill requires approval and that assertion is absent, the run is recorded as
 * rejected and nothing executes. A forker wiring notary into a product replaces
 * this with a real out-of-band approval (webhook, Slack, a UI confirmation).
 */
import { resolve } from "node:path";
import { runSkill } from "./runner.js";
import type { ApprovalHook } from "./approval.js";
import { verifyFile } from "./audit.js";
import { keyDirFor, loadVerifier } from "./signing.js";

const DEFAULT_AUDIT = ".notary/receipts.jsonl";

export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: "notary", version: "0.1.0" });

  server.registerTool(
    "run_skill",
    {
      title: "Run a Claude skill through notary",
      description:
        "Run a skill folder through notary's gate (capability check), approval, and execution, producing a tamper-evident receipt. Returns the result, the run status, and the receipt chain proof.",
      inputSchema: {
        skillDir: z.string().describe("Path to the skill folder (contains SKILL.md)."),
        input: z.string().describe("The input the skill acts on, e.g. document text."),
        granted: z
          .array(z.string())
          .describe("Capabilities granted for this run, e.g. ['fs.read','model.call']."),
        auditFile: z
          .string()
          .optional()
          .describe(`Receipts file (default: ${DEFAULT_AUDIT}).`),
        approve: z
          .boolean()
          .optional()
          .describe(
            "Assert that a human has approved this run. Required for skills that need approval — without it the run is recorded as rejected and does not execute.",
          ),
        requireApproval: z
          .boolean()
          .optional()
          .describe("Force the approval gate even if the skill does not require it."),
      },
    },
    async ({ skillDir, input, granted, auditFile, approve, requireApproval }) => {
      const approvalHook: ApprovalHook = async () => ({
        approved: approve === true,
        by: "mcp-caller",
        reason: approve === true ? "approved by MCP caller" : "no approval asserted in run_skill call",
      });
      const res = await runSkill({
        skillDir: resolve(skillDir),
        granted,
        input,
        auditFile: auditFile ?? DEFAULT_AUDIT,
        approvalHook,
        requireApproval,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: res.status,
                runId: res.runId,
                skill: res.skill,
                output: res.output ?? null,
                receipt: res.receipt,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "verify_receipt",
    {
      title: "Verify a notary receipt chain",
      description:
        "Re-walk a receipt file's hash chain and report whether it is intact, or the first sequence number where it broke.",
      inputSchema: {
        auditFile: z
          .string()
          .optional()
          .describe(`Receipts file to verify (default: ${DEFAULT_AUDIT}).`),
        publicKey: z
          .string()
          .optional()
          .describe("Base64 Ed25519 public key to verify seal signatures against (default: the key beside the receipts file)."),
        expectedHead: z
          .string()
          .optional()
          .describe("Expected hash of the final entry; pass a previously-pinned head to detect tail truncation."),
      },
    },
    async ({ auditFile, publicKey, expectedHead }) => {
      const file = auditFile ?? DEFAULT_AUDIT;
      const verifier = loadVerifier(keyDirFor(file), publicKey);
      const result = verifyFile(file, { verifier, expectedHead });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // connect() resolves once the transport is wired up; keep the process alive
  // until the client disconnects (stdin closes) so the CLI does not exit early.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
