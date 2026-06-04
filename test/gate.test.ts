import { describe, expect, it } from "vitest";
import { checkGate } from "../src/gate.js";

describe("gate", () => {
  it("allows when declared capabilities are a subset of granted", () => {
    const r = checkGate(["fs.read", "model.call"], ["fs.read", "model.call", "fs.write"]);
    expect(r.allowed).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("denies and reports the missing capability when a skill over-reaches", () => {
    const r = checkGate(["fs.read", "fs.write"], ["fs.read", "model.call"]);
    expect(r.allowed).toBe(false);
    expect(r.missing).toEqual(["fs.write"]);
  });

  it("honours a trailing-segment wildcard grant", () => {
    const r = checkGate(["fs.read", "fs.write"], ["fs.*"]);
    expect(r.allowed).toBe(true);
  });

  it("honours a total wildcard grant", () => {
    const r = checkGate(["fs.read", "model.call", "net.fetch"], ["*"]);
    expect(r.allowed).toBe(true);
  });

  it("does not let a prefix wildcard leak across namespaces", () => {
    const r = checkGate(["net.fetch"], ["fs.*"]);
    expect(r.allowed).toBe(false);
    expect(r.missing).toEqual(["net.fetch"]);
  });
});
