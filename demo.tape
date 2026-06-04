# Renders demo.gif — the notary "try to forge it" demo.
# Render with:  ANTHROPIC_API_KEY=sk-... vhs demo.tape
# (the key is read from the environment; it is never typed into the recording)

Output demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 840
Set Theme "Dracula"
Set Padding 22
Set TypingSpeed 30ms

# Setup (hidden): put the notary shim on PATH, start from a clean receipts dir.
Hide
Type "export PATH=/tmp/notarybin:$PATH; cd /Users/andy/notary; rm -rf .notary; clear"
Enter
Show

# 1. Run a skill: gate -> human approval -> run -> signed receipt.
Type "notary run examples/skills/contract-review --doc examples/sample-nda.txt"
Enter
Sleep 2.5s
Type "y"
Enter
Sleep 9s

# 2. Verify: signature checked against the public key.
Type "notary verify"
Enter
Sleep 2.5s

# 3. Forge it: recompute the whole hash chain forward.
Type "node examples/forge-attempt.mjs"
Enter
Sleep 2.5s

# 4. Verify again: the signature catches what a hash chain cannot.
Type "notary verify"
Enter
Sleep 4s
