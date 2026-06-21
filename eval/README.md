# askd eval harness

A small evaluation framework that runs **graded cases against the real Claude
backend** and reports accuracy, **tool-call precision/recall**, token cost, and
latency. It drives the same `runClaude()` generator the bridge serves in
production, so the eval exercises the actual tool gating, prompt assembly, and
streaming path — not a mock.

## Why it exists

A read-only agent makes two kinds of promises: that its **answers** are correct
and that its **behavior** stays inside the security envelope (no writes, no
shell, no leaving the working directory). This harness asserts both, including
an **adversarial case** that asks the agent to create a file and verifies it
*refuses and never calls a write tool*.

## Run it

Requires a logged-in Claude Code on this machine (the harness uses your local
login, exactly like the bridge — no API key of its own).

```bash
cd eval
npm run eval              # all cases, deterministic graders
npm run eval -- --case codebase-cite   # one case by id
npm run eval:judge        # also run LLM-judge graders (extra model calls)
npm test                  # unit-test the grading logic — NO model calls (CI-safe)
```

The runner prints a report, writes machine-readable `results.json`, and exits
non-zero if any case fails (so CI can gate on it).

## Graders

Each case in [`cases.json`](./cases.json) declares assertions; every grader is a
pure function in [`graders.js`](./graders.js) and is unit-tested in
[`graders.test.js`](./graders.test.js) without calling a model.

| Spec field             | Grader          | Checks |
|------------------------|-----------------|--------|
| `expectAnswerContains` | answerContains  | All substrings present (case-insensitive) |
| `expectAnswerMatches`  | answerMatches   | Answer matches a regex |
| `forbidAnswerMatches`  | answerNotMatches| Answer must **not** match (e.g. false "I edited the file" claims) |
| `expectTools`          | expectTools     | Each tool was called at least once |
| `forbidTools`          | forbidTools     | None of these tools may be called (security) |
| `expectToolOrder`      | toolOrder       | Tools appear as an ordered subsequence |
| `judge: { rubric }`    | judge (LLM)     | Open-ended quality, graded PASS/FAIL by the model |

A case passes iff **every** grader passes. `noError` is added automatically.

## Metrics

- **Pass rate** overall and **per grader**.
- **Tool precision / recall**, micro-averaged over cases that declare
  `expectTools` (precision = fraction of called tools that were wanted; recall =
  fraction of wanted tools that were called).
- **Cost / tokens / latency**, taken from the SDK result message's real
  `total_cost_usd`, `usage`, and `duration_ms` — not estimated.

## Adding a case

Append an object to `cases.json`. Use `"cwd": "$REPO"` to give the agent
read-only access to this repository (handy for self-referential cases that read
askd's own source). Minimal example:

```json
{
  "id": "my-case",
  "title": "Short description",
  "pageContext": "Text the user is reading.",
  "question": "What should the agent answer?",
  "expectAnswerContains": ["expected phrase"],
  "forbidTools": ["Write", "Edit", "Bash"]
}
```
