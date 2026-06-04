#!/usr/bin/env node
// A runnable version of the attack a plain hash chain cannot survive: edit a
// past entry, then recompute EVERY hash forward so the chain links up again.
// It uses notary's OWN exported hashCore — the strongest version of the attack.
// Against signed receipts it fails: `notary verify` reports an invalid signature,
// because the forger cannot reproduce the Ed25519 signature without the key.
//
// Usage: node examples/forge-attempt.mjs [path/to/receipts.jsonl]
import { readFileSync, writeFileSync } from "node:fs";
import { hashCore } from "../dist/index.js";

const file = process.argv[2] ?? ".notary/receipts.jsonl";
const entries = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

// Tamper with the first entry's payload.
entries[0].payload.forged = "this run did something it was never approved to do";

// Recompute the whole chain forward so it is internally consistent again.
let prevHash = entries[0].prevHash;
for (const e of entries) {
  e.prevHash = prevHash;
  const { hash, ...core } = e;
  e.hash = hashCore(core);
  prevHash = e.hash;
}
writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(`forged the receipt and recomputed all ${entries.length} hashes forward.`);
console.log("the chain is now internally consistent. run `notary verify` again.");
