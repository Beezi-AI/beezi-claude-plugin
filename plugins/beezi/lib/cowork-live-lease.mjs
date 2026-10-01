import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { beeziHome } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { acquireLock, releaseLock } from './single-instance-lock.mjs';

// The existing empty-directory lock provides atomic acquisition and stale recovery.
// A separate nonce prevents an old owner releasing/heartbeating a replacement lease.
export function acquireCoworkLease() {
  const name = 'cowork-live', dir = path.join(beeziHome(), name + '.lock');
  const ownerFile = path.join(beeziHome(), 'cowork-live-owner.json');
  if (!acquireLock(name)) return null;
  const token = crypto.randomBytes(16).toString('hex');
  try { writeJsonSecure(ownerFile, { token, pid: process.pid }); }
  catch { releaseLock(name); return null; }
  const owns = () => { const current = readJson(ownerFile, null); return current != null && current.token === token; };
  return {
    owns,
    heartbeat: () => {
      if (!owns()) return false;
      try { const now = new Date(); fs.utimesSync(dir, now, now); return true; } catch { return false; }
    },
    release: () => {
      if (!owns()) return;
      try { fs.unlinkSync(ownerFile); } catch { return; }
      releaseLock(name);
    },
  };
}
