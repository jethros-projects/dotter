#!/usr/bin/env node
let CliError, DotError, DotterError, stripTerminalControls;

try {
  await import('../src/runtime.mjs');
  const { run, ...cli } = await import('../src/cli.mjs');
  ({ CliError, stripTerminalControls } = cli);
  ({ DotError } = await import('../src/errors.mjs'));
  ({ DotterError } = await import('../src/sdk-error.mjs'));
  const args = process.argv.slice(2);
  const result = await run(args);
  if (result?.status === 'unavailable') process.exitCode = 3;
} catch (error) {
  const args = process.argv.slice(2), optionEnd = args.indexOf('--');
  const jsonErrors = (optionEnd === -1 ? args : args.slice(0, optionEnd)).includes('--json');
  const unsupported = error?.code === 'UNSUPPORTED_NODE_VERSION';
  const domainError = DotError && error instanceof DotError || DotterError && error instanceof DotterError;
  const usageError = CliError && error instanceof CliError;
  const known = unsupported || usageError || domainError;
  const message = unsupported ? error.message : known ? stripTerminalControls(error.message) : 'Unexpected failure. Run dotter --help or retry.';
  if (jsonErrors) {
    process.stdout.write(`${JSON.stringify(domainError ? error.toJSON() : { error: { code: known ? error.code : 'UNEXPECTED', message } })}\n`);
  } else {
    process.stderr.write(`Dotter: ${message}\n`);
    if (DotError && error instanceof DotError && error.details.idempotencyKey) process.stderr.write(`Delivery: ${error.details.delivery}. Request key: ${error.details.idempotencyKey}\n`);
  }
  const code = known ? String(error.code ?? '') : '';
  process.exitCode = usageError && error.code === 'USAGE_ERROR' ? 2
    : /AUTH|LOGIN/.test(code) ? 3
    : /DENIED|FORBIDDEN|EDGE/.test(code) ? 4
    : /NETWORK|TIMEOUT/.test(code) ? 5
    : 1;
}
