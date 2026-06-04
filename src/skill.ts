import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A skill is a folder containing a SKILL.md file. The file begins with a small
 * YAML-ish front-matter block (between `---` fences) declaring the skill's name,
 * a one-line description, the capabilities it needs, and whether it requires
 * human approval to run. Everything after the closing fence is the prompt body.
 *
 * We parse a deliberately tiny subset of YAML — strings, booleans, and inline
 * `[a, b, c]` lists — so notary stays dependency-free. Anything fancier than
 * that is out of scope.
 */

/** A capability is a coarse permission string, e.g. "fs.read" or "model.call". */
export type Capability = string;

export interface SkillManifest {
  name: string;
  description: string;
  /** Capabilities the skill declares it needs. */
  capabilities: Capability[];
  /** If true, the skill always requires human approval regardless of policy. */
  requiresApproval: boolean;
}

export interface Skill {
  manifest: SkillManifest;
  /** The prompt body (everything after the front-matter). */
  prompt: string;
  /** Absolute path to the skill folder. */
  dir: string;
}

const FENCE = "---";

/** Split a SKILL.md into its raw front-matter block and the body below it. */
function splitFrontMatter(raw: string): { front: string; body: string } {
  const text = raw.replace(/^﻿/, "");
  if (!text.startsWith(FENCE)) {
    throw new Error(
      "SKILL.md must start with a `---` front-matter block declaring name and capabilities.",
    );
  }
  const end = text.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) {
    throw new Error("SKILL.md front-matter block is not closed with `---`.");
  }
  const front = text.slice(FENCE.length, end).trim();
  const body = text.slice(end + FENCE.length + 1).trim();
  return { front, body };
}

/** Parse one scalar value: a quoted/bare string, a boolean, or an inline list. */
function parseValue(raw: string): string | boolean | string[] {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter((s) => s.length > 0);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  return unquote(v);
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** Parse the tiny key: value front-matter into a record. */
function parseFrontMatter(front: string): Record<string, string | boolean | string[]> {
  const out: Record<string, string | boolean | string[]> = {};
  for (const line of front.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    out[key] = parseValue(trimmed.slice(colon + 1));
  }
  return out;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

/** Load and validate a skill from its folder. */
export function loadSkill(dir: string): Skill {
  const raw = readFileSync(join(dir, "SKILL.md"), "utf8");
  const { front, body } = splitFrontMatter(raw);
  const fm = parseFrontMatter(front);

  const name = typeof fm.name === "string" ? fm.name : "";
  if (!name) throw new Error("SKILL.md front-matter must declare a `name`.");

  const manifest: SkillManifest = {
    name,
    description: typeof fm.description === "string" ? fm.description : "",
    capabilities: asStringArray(fm.capabilities),
    requiresApproval: fm.requiresApproval === true,
  };

  return { manifest, prompt: body, dir };
}
