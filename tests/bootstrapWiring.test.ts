import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from './testHarness';

const run = promisify(execFile);

// The composition root is 800-odd lines of wiring that nothing else exercises:
// it is not imported by any unit test, and the first thing that runs it is the
// server itself. So a mistake in it — a module that no longer resolves, a
// constructor handed the wrong shape, a const referenced from a closure before
// the line that declares it — surfaces as a server that will not start.
//
// `tsc` sees the first two and not the third. This does, by evaluating the whole
// thing in a clean process. It has to be a separate process: createRuntime
// claims module-level singletons (the sendspin group controller refuses to be
// initialised twice), so it cannot run after the rest of the suite.

test('the whole server can be wired', async () => {
  const script = path.resolve(__dirname, 'bootstrapSmoke.ts');
  const { stdout } = await run(
    process.execPath,
    [require.resolve('ts-node/dist/bin.js'), '--transpile-only', script],
    { cwd: path.resolve(__dirname, '..'), timeout: 120_000 },
  );
  const verdict = stdout.trim().split('\n').pop() ?? '';
  assert.equal(verdict, 'WIRED', stdout);
});
