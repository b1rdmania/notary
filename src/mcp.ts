import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * The MCP server is notary's distribution surface: any MCP client (Claude
 * Desktop, Cursor, …) can run a skill through the same gate → approve → run →
 * receipt path. It exposes two tools — `run_skill` and `verify_receipt`.
 *
 * Approval over MCP defaults to auto-approve, because there is no terminal to
 * prompt on; the client/operator is expected to plug in their own approval hook
 * (webhook, Slack, a UI confirmation) when wiring notary into a product. The
 * receipt still records who approved and when, so the trail is intact either way.
 */
import { resolve } from "node:path";
import { runSkill } from "./runner.js";
import { autoApprove } from "./approval.js";
import { verifyFile } from "./audit.js";

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
        requireApproval: z
          .boolean()
          .optional()
          .describe("Force approval even if the skill does not require it."),
      },
    },
    async ({ skillDir, input, granted, auditFile, requireApproval }) => {
      const res = await runSkill({
        skillDir: resolve(skillDir),
        granted,
        input,
        auditFile: auditFile ?? DEFAULT_AUDIT,
        approvalHook: autoApprove,
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
      },
    },
    async ({ auditFile }) => {
      const result = verifyFile(auditFile ?? DEFAULT_AUDIT);
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
