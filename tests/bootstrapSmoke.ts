/**
 * Wire the whole server in a clean process, and report whether it held.
 *
 * Not a unit test and deliberately not part of `run-tests`: `createRuntime`
 * touches module-level singletons (the sendspin group controller refuses a
 * second initialisation), so it can only run in a process where nothing else
 * has run first. `bootstrapWiring.test.ts` spawns this and reads the last line.
 *
 * What it proves is small but nothing else proves it: that the composition root
 * can be evaluated at all — every module resolves, every constructor accepts
 * what it is handed, and no reference is used before the const that holds it.
 * That last one is the failure a split of this file would cause, and the one
 * `tsc` cannot see through a closure.
 */
import 'tsconfig-paths/register';
import { createRuntime } from '../src/runtime/bootstrap';

try {
  const runtime = createRuntime();
  if (typeof runtime.start !== 'function' || typeof runtime.stop !== 'function') {
    throw new Error('createRuntime did not return a startable runtime');
  }
  process.stdout.write('WIRED\n');
  process.exit(0);
} catch (error) {
  process.stdout.write(`FAILED ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
