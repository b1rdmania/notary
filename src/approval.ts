import { createInterface } from "node:readline";

/**
 * An approval hook decides whether a run may proceed. notary ships two: a CLI
 * prompt (the human-in-the-loop default) and an auto-approver (for tests and
 * non-interactive use). A forker plugs in a webhook or Slack hook by satisfying
 * this same interface — that is the entire extension point for approvals.
 */

export interface ApprovalRequest {
  skill: string;
  description: string;
  capabilities: string[];
  runId: string;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Who/what made the decision, recorded in the receipt. */
  by: string;
  reason?: string;
}

export type ApprovalHook = (req: ApprovalRequest) => Promise<ApprovalDecision>;

/** Always approves. For tests and explicitly non-interactive runs. */
export const autoApprove: ApprovalHook = async () => ({
  approved: true,
  by: "auto",
  reason: "autoApprove hook",
});

/** Always rejects. Useful for policy-off / dry runs. */
export const autoReject: ApprovalHook = async () => ({
  approved: false,
  by: "auto",
  reason: "autoReject hook",
});

/** Prompts a human on the terminal. The default for the CLI demo. */
export const cliApprove: ApprovalHook = async (req) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `? approve "${req.skill}" to run with [${req.capabilities.join(", ")}]? [y/N] `,
        resolve,
      );
    });
    const approved = /^y(es)?$/i.test(answer.trim());
    return {
      approved,
      by: "cli",
      reason: approved ? "approved at prompt" : "rejected at prompt",
    };
  } finally {
    rl.close();
  }
};
