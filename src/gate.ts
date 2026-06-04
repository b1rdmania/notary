import type { Capability } from "./skill.js";

/**
 * The gate answers one question: are the skill's declared capabilities a subset
 * of the capabilities the operator granted? If the skill asks for anything it
 * wasn't granted, the gate denies it and nothing runs.
 *
 * Capabilities support a single trailing wildcard segment, so a grant of
 * "fs.*" covers "fs.read" and "fs.write", and "*" grants everything. Matching
 * is otherwise exact.
 */

export interface GateResult {
  allowed: boolean;
  /** Declared capabilities that were not covered by any grant. */
  missing: Capability[];
  declared: Capability[];
  granted: Capability[];
}

function grantCovers(grant: Capability, declared: Capability): boolean {
  if (grant === "*") return true;
  if (grant === declared) return true;
  if (grant.endsWith(".*")) {
    const prefix = grant.slice(0, -1); // keep the dot, e.g. "fs."
    return declared.startsWith(prefix);
  }
  return false;
}

export function checkGate(
  declared: Capability[],
  granted: Capability[],
): GateResult {
  const missing = declared.filter(
    (cap) => !granted.some((grant) => grantCovers(grant, cap)),
  );
  return {
    allowed: missing.length === 0,
    missing,
    declared,
    granted,
  };
}
