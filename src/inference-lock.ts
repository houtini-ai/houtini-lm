/**
 * Cross-process inference lock.
 *
 * The in-process promise-chain semaphore in index.ts only serialises calls
 * within a single houtini-lm process. Under the multi-agent deployment (several
 * MCP client connections, each its own process) they all hit one loaded model
 * in parallel, stacking prefill/timeout. This advisory file lock serialises
 * inference across processes on the same machine.
 *
 * Design:
 * - Atomic exclusive create (`wx`) of the lock file is the acquire primitive.
 * - Each acquisition writes a UNIQUE token. Every destructive op (release, steal,
 *   exit cleanup) first re-reads the file and only unlinks when the on-disk token
 *   still matches, so a process can NEVER delete a lock it doesn't own — which is
 *   what previously let a steal race cascade into extra concurrent holders.
 * - Staleness is AGE-FIRST (past the threshold → steal regardless), then same-host
 *   dead-PID (`kill(pid,0)` → ESRCH → steal). Age-first means a reused PID can't
 *   pin a dead holder's lock forever.
 * - FAIL-OPEN: any fs error, or waiting past the cap, proceeds WITHOUT the lock
 *   rather than hanging a tool call. Serialisation is a throughput optimisation,
 *   never a correctness dependency.
 *
 * Residual: if a holder is hard-killed and several waiters race to steal in the
 * same sub-millisecond window, a transient double-acquire is possible (two
 * inferences run in parallel briefly, i.e. the un-optimised behaviour). It is
 * self-healing and, thanks to token-checked release, never cascades. Acceptable
 * for a best-effort optimisation.
 */

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

const LOCK_DIR = join(homedir(), '.houtini-lm');
const LOCK_PATH = join(LOCK_DIR, 'inference.lock');
const HOST = hostname();

const ENABLED = process.env.HOUTINI_LM_CROSS_PROCESS_LOCK !== '0';
const POLL_MS = 150;
// Stale-by-time threshold must exceed the inference soft-timeout (5 min) so we
// never steal a lock from a genuinely long-running inference on time alone.
const STALE_MS = 7 * 60_000;
// Default cap on how long we'll wait before giving up and proceeding unlocked.
const DEFAULT_MAX_WAIT_MS = 6 * 60_000;

interface LockInfo { pid?: number; host?: string; at?: number; token?: string }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The token of the lock this process currently holds (null when not holding).
// Every unlink is gated on the on-disk token still equalling this, so we only
// ever delete our own lock.
let myToken: string | null = null;

process.on('exit', () => {
  if (myToken && readLock()?.token === myToken) {
    try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
  }
});

function readLock(): LockInfo | null {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as LockInfo;
  } catch {
    return null; // missing or garbled
  }
}

/** Should the given on-disk lock be stolen? Age first (covers PID reuse and
 *  wedged holders), then same-host dead-PID. */
function shouldSteal(info: LockInfo | null): boolean {
  if (!info) return true; // unreadable/garbled → stealable
  if (typeof info.at === 'number' && Date.now() - info.at > STALE_MS) return true;
  if (info.host === HOST && typeof info.pid === 'number') {
    try { process.kill(info.pid, 0); } // probe existence; no signal sent
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return true; }
    // EPERM (exists, not ours to signal) → alive → not stale
  }
  return false;
}

/** Remove the lock only if it STILL holds the exact token we deemed stale, so we
 *  don't clobber a fresh lock another waiter created in the meantime. */
function stealIfUnchanged(expectedToken: string | undefined): void {
  const cur = readLock();
  if (cur && cur.token === expectedToken) {
    try { unlinkSync(LOCK_PATH); } catch { /* another waiter beat us to it */ }
  }
}

/**
 * Acquire the cross-process inference lock. Returns a release function (safe to
 * call more than once; only unlinks if we still own the file). `onWait` is
 * invoked periodically while blocked so the caller can emit keepalive progress.
 * `maxWaitMs` caps the wait before failing open — pass a value under the client
 * request timeout when the caller cannot emit keepalives.
 */
export async function acquireInferenceLock(
  opts: { onWait?: (waitedMs: number) => void; maxWaitMs?: number } = {},
): Promise<() => void> {
  if (!ENABLED) return () => { /* disabled */ };
  const { onWait, maxWaitMs = DEFAULT_MAX_WAIT_MS } = opts;

  try { mkdirSync(LOCK_DIR, { recursive: true }); } catch { /* ignore */ }

  const start = Date.now();
  let lastTick = 0;
  for (;;) {
    try {
      const token = `${process.pid}-${HOST}-${randomUUID()}`;
      const fd = openSync(LOCK_PATH, 'wx'); // atomic: EEXIST if already held
      writeSync(fd, JSON.stringify({ pid: process.pid, host: HOST, at: Date.now(), token }));
      closeSync(fd);
      myToken = token;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Only unlink if the file still carries OUR token — never delete a lock
        // that was stolen from us and re-created by someone else.
        if (readLock()?.token === token) {
          try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
        }
        if (myToken === token) myToken = null;
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return () => { /* fail open — run unlocked rather than block */ };
      }
      const info = readLock();
      if (shouldSteal(info)) {
        stealIfUnchanged(info?.token);
        continue; // retry acquire immediately
      }
      const waited = Date.now() - start;
      if (waited > maxWaitMs) return () => { /* gave up waiting; run unlocked */ };
      if (onWait && waited - lastTick >= 2000) { lastTick = waited; onWait(waited); }
      await sleep(POLL_MS);
    }
  }
}
