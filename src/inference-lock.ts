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
 * - Atomic exclusive create (`wx`) of a lock file is the acquire primitive.
 * - The holder writes {pid, host, at}. A waiter decides stale vs busy: same-host
 *   PID liveness (`kill(pid, 0)`) is authoritative; a dead holder's lock is
 *   stolen immediately. A cross-host or unreadable lock falls back to a
 *   timestamp age well beyond the inference soft-timeout.
 * - FAIL-OPEN: any unexpected error, or waiting past the cap, proceeds WITHOUT
 *   the lock rather than hanging a tool call. Serialisation is a throughput
 *   optimisation, not a correctness guarantee — never block inference on it.
 */

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';

const LOCK_DIR = join(homedir(), '.houtini-lm');
const LOCK_PATH = join(LOCK_DIR, 'inference.lock');
const HOST = hostname();

const ENABLED = process.env.HOUTINI_LM_CROSS_PROCESS_LOCK !== '0';
const POLL_MS = 150;
// Stale-by-time threshold must exceed the inference soft-timeout (5 min) so we
// never steal a lock from a genuinely long-running inference on time alone.
const STALE_MS = 7 * 60_000;
// Cap on how long we'll wait for the lock before giving up and proceeding
// unlocked, so a wedged holder can't hang every other process forever.
const MAX_WAIT_MS = 6 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Track our own held lock so a normal process exit cleans it up. A hard kill
// leaves the file behind, but the next waiter detects the dead PID and steals it.
let holding = false;
process.on('exit', () => {
  if (holding) { try { unlinkSync(LOCK_PATH); } catch { /* ignore */ } }
});

function readLock(): { pid?: number; host?: string; at?: number } | null {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as { pid?: number; host?: string; at?: number };
  } catch {
    return null;
  }
}

function isStale(): boolean {
  const info = readLock();
  if (!info) return true; // unreadable/garbled → treat as stale
  if (info.host === HOST && typeof info.pid === 'number') {
    try {
      process.kill(info.pid, 0); // no signal sent; just probes existence
      return false;              // holder alive
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return true; // no such process → dead
      // EPERM: exists but not signalable by us → alive, not stale
    }
  }
  // Cross-host, or same-host-but-signalable: fall back to age.
  return typeof info.at === 'number' && Date.now() - info.at > STALE_MS;
}

/**
 * Acquire the cross-process inference lock. Returns a release function (safe to
 * call more than once). `onWait` is invoked periodically while blocked so the
 * caller can emit keepalive progress and avoid tripping the MCP client timeout.
 */
export async function acquireInferenceLock(onWait?: (waitedMs: number) => void): Promise<() => void> {
  if (!ENABLED) return () => { /* disabled */ };

  try { mkdirSync(LOCK_DIR, { recursive: true }); } catch { /* ignore */ }

  const start = Date.now();
  let lastTick = 0;
  for (;;) {
    try {
      const fd = openSync(LOCK_PATH, 'wx'); // atomic: fails with EEXIST if held
      writeSync(fd, JSON.stringify({ pid: process.pid, host: HOST, at: Date.now() }));
      closeSync(fd);
      holding = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holding = false;
        try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Unexpected fs error — fail open, run unlocked rather than block.
        return () => { /* no-op */ };
      }
      if (isStale()) {
        try { unlinkSync(LOCK_PATH); } catch { /* ignore — another waiter may have taken it */ }
        continue; // retry acquire immediately
      }
      const waited = Date.now() - start;
      if (waited > MAX_WAIT_MS) return () => { /* gave up waiting; run unlocked */ };
      if (onWait && waited - lastTick >= 2000) { lastTick = waited; onWait(waited); }
      await sleep(POLL_MS);
    }
  }
}
