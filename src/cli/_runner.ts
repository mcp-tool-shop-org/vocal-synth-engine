/**
 * Shared CLI runner — TB-001 closer.
 *
 * Every user-facing CLI in src/cli/ ended its file with
 *   `main().catch(console.error);`
 * which PRINTS the rejection to stderr but exits 0 (Node's default for an
 * unhandled-then-handled promise rejection). CI / `set -e` shells / `&&`
 * chains treated a thrown asset-corruption / Zod-validation / missing-file
 * error as success — exactly the silent-failure class Stage A's defensive
 * Zod schemas were supposed to surface.
 *
 * `runCli('name', main)` wraps the main-promise so:
 *   - the error message is prefixed with the command name (so users grepping
 *     `[analyze]` find their own errors immediately),
 *   - the error's optional `.hint` is printed after the message (use it to
 *     tell the user how to recover — e.g. "run with --help"),
 *   - the optional `.code` is shown if present (matches the loader's
 *     `UNSUPPORTED_PRESET_VERSION` / `ASSET_INTEGRITY_MISMATCH` style),
 *   - `process.exitCode = 1` so the process really exits non-zero.
 *
 * Future CLIs in this directory MUST use runCli() so this bug class can't
 * reintroduce itself one file at a time.
 */

/** Optional hint shape — throw new Error(msg) with .hint added, OR throw a
 *  custom error object whose shape matches this interface. */
export interface CliError extends Error {
  hint?: string;
  code?: string;
}

/**
 * Standard CLI bootstrap. Pass the command name (used in error prefixes) and
 * the main() async function. On rejection, prints a structured error and
 * sets `process.exitCode = 1`. Returns the original promise for testability.
 */
export function runCli(cmd: string, mainFn: () => Promise<unknown>): Promise<unknown> {
  return mainFn().catch((err: unknown) => {
    const e = err as CliError;
    const code = e?.code ? ` (${e.code})` : '';
    const msg = e?.message ?? String(err);
    console.error(`[${cmd}] error${code}: ${msg}`);
    if (e?.hint) console.error(`[${cmd}] hint: ${e.hint}`);
    process.exitCode = 1;
  });
}

/**
 * Parse a finite number from a CLI argument. Closes TB-005's parseFloat-NaN
 * silent-acceptance class: `parseFloat('abc')` returns NaN which then
 * propagates into render() and writes silent or NaN audio.
 *
 * Throws a CliError with .hint pointing at the offending argument name.
 */
export function parseFiniteNumber(value: string, argName: string): number {
  if (value === undefined || value === null || value === '') {
    const err: CliError = new Error(`missing value for <${argName}>`);
    err.hint = `pass a finite number, e.g. '<${argName}>=440'`;
    throw err;
  }
  const n = parseFloat(value);
  if (!Number.isFinite(n)) {
    const err: CliError = new Error(
      `invalid <${argName}>: expected a finite number, got '${value}'`
    );
    err.hint = `pass a real number like 220 or 4.5 (no NaN/Infinity/text)`;
    throw err;
  }
  return n;
}

/**
 * Cheap argv flag parser for the few flags every CLI cares about. Returns
 * {help, json} and the residual positional args. Anything we don't recognise
 * is kept in `positionals` — so a CLI can layer its own --out / --verbose on
 * top of this without conflict.
 *
 * Doesn't try to be a full getopt. Each CLI's USAGE still owns the truth.
 */
export function parseCommonFlags(args: string[]): {
  help: boolean;
  json: boolean;
  positionals: string[];
} {
  let help = false;
  let json = false;
  const positionals: string[] = [];
  for (const a of args) {
    if (a === '-h' || a === '--help') help = true;
    else if (a === '--json' || a === '--format=json') json = true;
    else positionals.push(a);
  }
  return { help, json, positionals };
}
