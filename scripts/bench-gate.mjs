#!/usr/bin/env node
/**
 * bench-gate.mjs — perf-regression gate for FTC-004.
 *
 * Workflow:
 *   1. `npm run bench` writes `tests/__bench__/last-run.json` (vitest JSON
 *      reporter format).
 *   2. We compare each bench's `hz` (operations/sec) against the committed
 *      baseline at `tests/__bench__/baseline.json`.
 *   3. If any bench is more than `MAX_REGRESSION_RATIO` slower (default 2x),
 *      we exit non-zero with a per-bench breakdown.
 *
 * First-run behavior: if `baseline.json` doesn't exist, we write the
 * current run AS the baseline and exit 0. CI's first run on the second
 * commit will start gating; this prevents a self-blocked merge of the
 * bench files themselves.
 *
 * Rebaseline: delete `tests/__bench__/baseline.json` and re-run; commit
 * the new file. Doing this should be a deliberate decision, ideally
 * tied to a CHANGELOG entry explaining what changed.
 *
 * Why `hz` not `mean`: tinybench reports both, but hz is more stable
 * across iteration count (mean drops with batch size). We compare on
 * ops/sec.
 *
 * Threshold rationale (2x): CI-runner variance + shared host noise
 * makes tighter thresholds churn. 2x is the "algorithm shape changed"
 * threshold, not a fine-grained perf-tuning loop.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const BENCH_DIR = resolve(REPO_ROOT, 'tests', '__bench__');
const LAST_RUN_PATH = resolve(BENCH_DIR, 'last-run.json');
const BASELINE_PATH = resolve(BENCH_DIR, 'baseline.json');

const MAX_REGRESSION_RATIO = 2.0;

if (!existsSync(LAST_RUN_PATH)) {
  console.error(`[bench-gate] no bench output at ${LAST_RUN_PATH}`);
  console.error(`[bench-gate] did you run \`npm run bench\` first?`);
  process.exit(1);
}

const lastRunRaw = readFileSync(LAST_RUN_PATH, 'utf-8');
const lastRun = JSON.parse(lastRunRaw);

/**
 * Vitest's bench JSON shape (vitest 4): an array of file results, each
 * with a `groups` array, each group has a `benchmarks` array with
 * `{name, hz, mean, ...}`. We flatten to { "groupName > benchName": hz }.
 */
function flattenRun(run) {
  const flat = {};
  // Vitest writes `{files: [...]}` at the top.
  const files = run.files ?? [];
  for (const file of files) {
    const groups = file.groups ?? [];
    for (const group of groups) {
      const benchmarks = group.benchmarks ?? [];
      for (const b of benchmarks) {
        const key = `${group.fullName ?? group.name} > ${b.name}`;
        if (typeof b.hz === 'number' && Number.isFinite(b.hz)) {
          flat[key] = b.hz;
        }
      }
    }
  }
  return flat;
}

const lastHz = flattenRun(lastRun);
const benchNames = Object.keys(lastHz);
if (benchNames.length === 0) {
  console.error('[bench-gate] flattened run produced 0 benches');
  console.error('[bench-gate] check vitest bench JSON reporter shape');
  console.error('[bench-gate] raw run:', lastRunRaw.slice(0, 500));
  process.exit(1);
}

if (!existsSync(BASELINE_PATH)) {
  if (!existsSync(BENCH_DIR)) mkdirSync(BENCH_DIR, { recursive: true });
  // First run — write baseline + exit 0 with a clear advisory.
  writeFileSync(BASELINE_PATH, JSON.stringify({ benches: lastHz, createdAt: new Date().toISOString() }, null, 2));
  console.log(`[bench-gate] no baseline found — wrote ${BASELINE_PATH}`);
  console.log(`[bench-gate] commit this file. Next run will compare against it.`);
  console.log(`[bench-gate] baseline values (ops/sec):`);
  for (const [n, hz] of Object.entries(lastHz)) {
    console.log(`  ${n}: ${hz.toFixed(2)} ops/sec`);
  }
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
const baseHz = baseline.benches ?? {};

const rows = [];
const regressions = [];
for (const name of benchNames) {
  const cur = lastHz[name];
  const base = baseHz[name];
  if (base === undefined) {
    rows.push({ name, cur, base: null, ratio: null, status: 'NEW' });
    continue;
  }
  // ratio < 1 = current is slower than baseline.
  const ratio = cur / base;
  const status = ratio < 1 / MAX_REGRESSION_RATIO ? 'FAIL' : 'OK';
  rows.push({ name, cur, base, ratio, status });
  if (status === 'FAIL') regressions.push({ name, cur, base, ratio });
}

console.log('[bench-gate] results:');
console.log('  ' + 'name'.padEnd(70) + ' baseline   current    ratio   status');
for (const r of rows) {
  const baseStr = r.base === null ? '       —' : r.base.toFixed(2);
  const curStr = r.cur.toFixed(2);
  const ratioStr = r.ratio === null ? '   —' : `${r.ratio.toFixed(3)}x`;
  console.log(
    `  ${r.name.padEnd(70)} ${baseStr.padStart(9)} ${curStr.padStart(10)} ${ratioStr.padStart(8)} ${r.status}`
  );
}

if (regressions.length > 0) {
  console.error(`\n[bench-gate] FAILED — ${regressions.length} bench(es) regressed more than ${MAX_REGRESSION_RATIO}x:`);
  for (const r of regressions) {
    console.error(`  ${r.name}: ${r.cur.toFixed(2)} ops/sec vs baseline ${r.base.toFixed(2)} (${r.ratio.toFixed(3)}x)`);
  }
  console.error(`\n[bench-gate] If this is an intentional algorithm change, delete tests/__bench__/baseline.json`);
  console.error(`[bench-gate] and commit a fresh baseline (rebaseline).`);
  process.exit(1);
}

console.log(`\n[bench-gate] PASS — ${rows.length} bench(es) within ${MAX_REGRESSION_RATIO}x of baseline.`);
