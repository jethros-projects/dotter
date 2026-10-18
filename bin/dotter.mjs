#!/usr/bin/env node
import { CliError, run, stripTerminalControls } from '../src/cli.mjs';
import { DotError } from '../src/errors.mjs';

const args = process.argv.slice(2);
const optionEnd = args.indexOf('--');
const jsonErrors = (optionEnd === -1 ? args : args.slice(0, optionEnd)).includes('--json');

try {
  const result = await run(args);
  if (result?.status === 'unavailable') process.exitCode = 3;
} catch (error) {
  const known = error instanceof CliError || error instanceof DotError;
  const message = known ? stripTerminalControls(error.message) : 'Unexpected failure. Run dotter --help or retry.';
  if (jsonErrors) {
    process.stdout.write(`${JSON.stringify(error instanceof DotError ? error.toJSON() : { error: { code: known ? error.code : 'UNEXPECTED', message } })}\n`);
  } else {
    process.stderr.write(`Dotter: ${message}\n`);
    if (error instanceof DotError && error.details.idempotencyKey) process.stderr.write(`Delivery: ${error.details.delivery}. Request key: ${error.details.idempotencyKey}\n`);
  }
  const code = known ? String(error.code ?? '') : '';
  process.exitCode = error instanceof CliError && error.code === 'USAGE_ERROR' ? 2
    : /AUTH|LOGIN/.test(code) ? 3
    : /DENIED|FORBIDDEN|EDGE/.test(code) ? 4
    : /NETWORK|TIMEOUT/.test(code) ? 5
    : 1;
}
