/**
 * Suppress ONLY Node's "SQLite is an experimental feature" ExperimentalWarning,
 * emitted by `node:sqlite` (used by the model cache) at import time on Node 22.x.
 * Every other process warning is printed as usual.
 *
 * This module must be imported before any module that imports `node:sqlite`,
 * because the warning fires when `node:sqlite` is first loaded — which, thanks to
 * ES-module import hoisting, happens before the body of the importing module runs.
 */
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});
