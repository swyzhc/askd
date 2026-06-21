#!/usr/bin/env node
// askd eval harness — CLI entrypoint.
//
// Loads cases.json, runs each against the real Claude backend, grades the
// streamed result, and prints + writes a metrics report.
//
//   node run.js                 # run all cases (deterministic graders only)
//   node run.js --judge         # also run LLM-judge graders (extra model calls)
//   node run.js --case <id>     # run a single case by id
//   node run.js --out file.json # where to write machine-readable results
//
// Requires a logged-in Claude Code on this machine (the harness drives your
// local login, exactly like the bridge does — it has no API key of its own).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCase } from './runner.js'
import { judgeCase } from './judge.js'
import { runDeterministicGraders, casePassed } from './graders.js'
import { aggregate, formatReport } from './report.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')

function parseArgs(argv) {
  const args = { judge: false, case: null, out: resolve(HERE, 'results.json'), file: resolve(HERE, 'cases.json') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--judge') args.judge = true
    else if (a === '--case') args.case = argv[++i]
    else if (a === '--out') args.out = resolve(argv[++i])
    else if (a === '--file') args.file = resolve(argv[++i])
  }
  return args
}

// Resolve dataset placeholders: "$REPO" -> the askd repo root.
function resolveCwd(cwd) {
  if (!cwd) return null
  if (cwd === '$REPO') return REPO_ROOT
  return cwd.startsWith('$REPO/') ? resolve(REPO_ROOT, cwd.slice('$REPO/'.length)) : cwd
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let cases = JSON.parse(readFileSync(args.file, 'utf8'))
  if (args.case) cases = cases.filter((c) => c.id === args.case)
  if (cases.length === 0) {
    console.error(`No cases to run${args.case ? ` (no case id "${args.case}")` : ''}.`)
    process.exit(1)
  }

  console.log(`Running ${cases.length} case(s)${args.judge ? ' with LLM judge' : ''}…`)
  const records = []
  for (const raw of cases) {
    const spec = { ...raw, cwd: resolveCwd(raw.cwd) }
    process.stdout.write(`  • ${spec.id} … `)
    const result = await runCase(spec)
    const graders = runDeterministicGraders(result, spec)
    if (args.judge && spec.judge) graders.push(await judgeCase(spec, result))
    const passed = casePassed(graders)
    records.push({ spec: raw, result, graders, passed })
    console.log(passed ? '✓' : '✗')
  }

  const agg = aggregate(records)
  const report = formatReport(records, agg)
  console.log(report)

  // Machine-readable output for CI / tracking over time.
  writeFileSync(
    args.out,
    JSON.stringify({ ranAt: new Date().toISOString(), summary: agg, records }, null, 2),
  )
  console.log(`Wrote ${args.out}`)

  // Non-zero exit if any case failed, so CI can gate on it.
  process.exit(agg.passed === agg.total ? 0 : 1)
}

main().catch((e) => {
  console.error('eval harness crashed:', e)
  process.exit(2)
})
