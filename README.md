# notary

**A black-box recorder and approval gate for any Claude skill. Tamper-evident, human-approved execution receipts. Drop-in MCP server, no infra, under 1,000 lines.**

You let a Claude skill touch your files, your tools, your customers. Can you prove what it was *allowed* to do, that a human *approved* it, and that the log of what happened hasn't been edited after the fact?

`notary` is one small thing that does exactly that. Point it at a skill folder. It checks the skill's declared permissions against what you granted, optionally pauses for a human to approve, runs it, and writes a **hash-chained, verifiable receipt** of everything that happened. Alter any past line of that receipt and `notary verify` tells you which line broke.

No database. No auth. No dashboard. No hosting. Those are *your* job — and that's the point.

```
npx notary run examples/skills/contract-review --doc nda.txt
```

```
✓ skill loaded: contract-review
✓ gate: declared [fs.read, model.call] ⊆ granted [fs.read, model.call]
? approve "contract-review" to run? [y/N] y
✓ approved by cli
… running …
─ output ───────────────────────────────────────────
  3 issues found in nda.txt (see summary)
────────────────────────────────────────────────────
✓ receipt sealed: 7 entries → .notary/receipts.jsonl
  verify with:  npx notary verify
```

```
npx notary verify
OK — 7 entries, chain intact.
```

Tamper with one line of the receipt and run it again:

```
npx notary verify
BROKEN at seq 4 — hash mismatch (entry was altered after sealing).
```

## How it works — the whole thing in 5 steps

1. **Load** — a skill is a folder with a `SKILL.md` and a small front-matter manifest declaring its `capabilities` (what it may read, write, or call).
2. **Gate** — are the declared capabilities a subset of what you granted? If the skill asks for more than you allowed, it's **denied** and nothing runs.
3. **Approve** — if the skill or your policy requires it, a pluggable approval hook pauses for a human decision. The default is a CLI prompt; swap in a webhook or Slack.
4. **Run** — the skill executes via the Anthropic SDK with only the granted tools. Inputs, model/version, and outputs are captured.
5. **Receipt** — every step is appended as a hash-chained entry to an append-only JSONL file. Each entry carries the SHA-256 of the one before it, so editing any past entry breaks every hash after it. `notary verify` re-walks the chain and proves it's intact.

## The receipt

Append-only `./.notary/receipts.jsonl`. One line per event:

```json
{ "seq": 3, "ts": "...", "runId": "...", "event": "run.finished", "skill": "contract-review", "payload": { "...": "..." }, "prevHash": "…", "hash": "…" }
```

`hash = sha256(canonicalJSON({seq, ts, runId, event, skill, payload, prevHash}))`. The `prevHash` of each entry is the `hash` of the previous one. The chain is the proof.

## Use it as an MCP server

`notary` exposes a `run_skill` tool over MCP, so Claude Desktop, Cursor, or any MCP client can run skills through the same gate → approve → receipt path.

```json
{
  "mcpServers": {
    "notary": { "command": "npx", "args": ["notary", "mcp"] }
  }
}
```

## What notary deliberately is *not*

No users, no multi-tenancy, no database, no web UI, no config framework, no plugin system, no skill-authoring tools. One job, forever. Everything else is the forker's job — fork it and build your product on top.

## License

MIT.
