import fs from 'node:fs';
import os from 'node:os';
import { configCandidates } from './claude-account.mjs';

// Claude Code caches its /usage data (subscription-limit utilization) in `~/.claude.json` under
// `cachedUsageUtilization` — the same token-free file the plan capture reads. It refreshes on the
// CLI's own schedule and can be days stale; fetchedAtMs is the truth about when it was true, and
// a cache without it is unusable (no dedupe key). Absent on machines that never fetched usage.
export function readUsageUtilization(deps = {}) {
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf-8'));
  const exists = deps.exists ?? ((p) => fs.existsSync(p));
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? os.homedir();

  for (const p of configCandidates(env, homedir)) {
    if (!exists(p)) continue;
    let cached;
    try {
      cached = JSON.parse(readFile(p)).cachedUsageUtilization;
    } catch {
      continue;
    }
    if (!cached || typeof cached !== 'object') continue;
    if (typeof cached.fetchedAtMs !== 'number') continue;
    const u = cached.utilization ?? {};
    return {
      fetchedAtMs: cached.fetchedAtMs,
      accountUuid: typeof cached.accountUuid === 'string' ? cached.accountUuid : null,
      fiveHourPct: u.five_hour?.utilization ?? null,
      fiveHourResetsAt: u.five_hour?.resets_at ?? null,
      sevenDayPct: u.seven_day?.utilization ?? null,
      sevenDayResetsAt: u.seven_day?.resets_at ?? null,
      limits: Array.isArray(u.limits) ? u.limits : null,
      raw: u,
    };
  }
  return null;
}
