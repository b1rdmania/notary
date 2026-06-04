# notary

**A black-box recorder and approval gate for any Claude skill. Signed, tamper-evident, human-approved execution receipts. Drop-in MCP server, no infra, under 1,500 lines.**

You let a Claude skill touch your files, your tools, your customers. Can you prove what it was *allowed* to do, that a human *approved* it, and that the record of what happened hasn't been edited after the fact?

`notary` is one small thing that does exactly that. Point it at a skill folder. It checks the skill's declared permissions against what you granted, optionally pauses for a human to approve, runs it, and writes an **Ed25519-signed, hash-chained receipt** of everything that happened. Anyone holding the public key can verify a receipt is genuine — and **nobody can forge, alter, reorder, or truncate a sealed receipt without the private signing key.**

No database. No auth server. No dashboard. No hosting. Those are *your* job — and that's the point.

```
npx @b1rdmania/notary run examples/skills/contract-review --doc nda.txt
```

```
✓ skill loaded: contract-review
✓ gate: declared [fs.read, model.call] ⊆ granted [fs.read, model.call]
? approve "contract-review" to run with [fs.read, model.call]? [y/N] y
✓ approved by cli
… running …
─ output ───────────────────────────────────────────
  6 issues found in nda.txt (see summary)
────────────────────────────────────────────────────
✓ receipt sealed & signed: 7 entries → .notary/receipts.jsonl
  signed by key 81917d5862cd0b94
  pin this head to detect truncation: 37476b5b36929d91…
  verify with:  notary verify
```

```
npx @b1rdmania/notary verify
OK — 7 entries, chain intact. 1 signed receipt verified
```

Now try to forge it — edit any past entry and recompute every hash forward so the chain is internally consistent again:

```
npx @b1rdmania/notary verify
BROKEN at seq 6 — invalid signature (the receipt was forged or altered after signing)
```

A plain hash chain can't stop that attack — the forger just recomputes the chain. The **signature** can, because they don't have the key.

## How it works — the whole thing in 5 steps

1. **Load** — a skill is a folder with a `SKILL.md` and a small front-matter manifest declaring its `capabilities` (what it may read, write, or call).
2. **Gate** — are the declared capabilities a subset of what you granted? If the skill declares more than you allowed, it's **denied** and nothing runs. (notary records and gates declared *intent*; it does not itself sandbox the model's tool access — wiring capabilities to a real sandbox is the forker's job.)
3. **Approve** — if the skill or your policy requires it, a pluggable approval hook pauses for a human decision. The default is a CLI prompt; swap in a webhook or Slack.
4. **Run** — the skill executes via the Anthropic SDK. Inputs, model/version, token usage, and an output hash are captured.
5. **Seal** — every step is appended as a hash-chained entry, and the final receipt is **signed with an Ed25519 key**. `notary verify` re-walks the chain and checks the signature against the public key.

## The receipt — and exactly what it guarantees

Append-only `./.notary/receipts.jsonl`. One line per event; the final `receipt.sealed` line carries the signature:

```json
{ "seq": 6, "ts": "...", "runId": "...", "event": "receipt.sealed", "skill": "contract-review",
  "payload": { "status": "completed", "runCount": 7, "runFinalSeq": 6, "runHeadHash": "…",
               "signature": "…", "keyId": "81917d58…" }, "prevHash": "…", "hash": "…" }
```

Two layers, and it's worth being precise about what each buys you:

- **The hash chain** (`hash = sha256(canonicalJSON(entry-without-hash))`, each `prevHash` linking to the prior `hash`) detects accidental corruption and naive edits — anything that leaves a stale hash or a broken link.
- **The Ed25519 signature** is the part that matters against a real adversary. A hash chain alone does **not** stop someone who can rewrite the whole file and recompute every hash forward. The signature does: the seal commits to the run's content, length, and chain head, and is signed with a private key the verifier never holds. **You cannot produce a valid sealed receipt — forged, altered, reordered, or with entries added or removed — without that key.**

**Threat model, stated honestly:**

- ✅ Forge or tamper with a sealed receipt's contents → caught (bad signature).
- ✅ Add, remove, or reorder entries within a sealed run → caught (committed count/head + signature).
- ✅ Truncate the tail of the file → caught **if you pinned the head** (`notary` prints it after every run; verify with `--head <hash>`).
- ⚠️ Delete an entire sealed receipt from a *collection* of receipts → a single signed receipt can't prove a sibling was deleted. For that, pin the latest head out-of-band or publish heads to an append-only/transparency log. notary gives you the pinnable head; where you anchor it is your call.

The guarantee is **"unforgeable without the signing key,"** not magic. Keep the private key off the machine that ships receipts to be verified, and hand out only the public key.

## Keys — zero infra

On first run, notary generates a local Ed25519 keypair: the private key goes to `.notary/notary.key` (mode `0600`, gitignored — keep it secret), the public key to `.notary/notary.pub` (share it). In production, supply your own private key via `NOTARY_PRIVATE_KEY` (base64 PKCS8 DER) and keep it wherever you keep secrets. No KMS, no service required.

```
notary verify receipts.jsonl --pubkey <base64>   # verify with a key you were given
notary verify receipts.jsonl --head <hash>       # also assert the file wasn't truncated
```

## Use it as an MCP server

`notary` exposes `run_skill` and `verify_receipt` over MCP, so Claude Desktop, Cursor, or any MCP client can run skills through the same gate → approve → seal path.

```json
{
  "mcpServers": {
    "notary": { "command": "npx", "args": ["@b1rdmania/notary", "mcp"] }
  }
}
```

**Approval over MCP:** there's no terminal to prompt on, so notary does *not* silently auto-approve — that would break the "human-approved" guarantee. The caller must assert a human approved by passing `approve: true` to `run_skill`. Without it, a skill that requires approval is recorded as **rejected** and does not run. Wire `approve` to a real out-of-band confirmation (a UI button, a Slack action) in your integration.

## What notary deliberately is *not*

No users, no multi-tenancy, no database, no web UI, no config framework, no plugin system, no skill-authoring tools, no execution sandbox. One job, forever. Everything else is the forker's job — fork it and build your product on top.

## License

MIT.
