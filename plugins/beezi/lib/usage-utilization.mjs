import fs from 'fs';
import os from 'os';
import { configCandidates } from './claude-account.mjs';

// Claude Code caches its /usage data (subscription-limit utilization) in `~/.claude.json` under
// `cachedUsageUtilization` — the same token-free file the plan capture reads. It refreshes on the
// CLI's own schedule and can be days stale; fetchedAtMs is the truth about when it was true, and
// a cache without it is unusable (no dedupe key). Absent on machines that never fetched usage.
export function readUsageUtilization(deps = {}) {
  const readFile = deps.readFile == null ? (p) => fs.readFileSync(p, 'utf-8') : deps.readFile;
  const exists = deps.exists == null ? (p) => fs.existsSync(p) : deps.exists;
  const env = deps.env == null ? process.env : deps.env;
  const homedir = deps.homedir == null ? os.homedir() : deps.homedir;

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
    const u = cached.utilization == null ? {} : cached.utilization;
    const fiveHour = u.five_hour;
    const sevenDay = u.seven_day;
    return {
      fetchedAtMs: cached.fetchedAtMs,
      accountUuid: typeof cached.accountUuid === 'string' ? cached.accountUuid : null,
      fiveHourPct: fiveHour == null || fiveHour.utilization == null ? null : fiveHour.utilization,
      fiveHourResetsAt: fiveHour == null || fiveHour.resets_at == null ? null : fiveHour.resets_at,
      sevenDayPct: sevenDay == null || sevenDay.utilization == null ? null : sevenDay.utilization,
      sevenDayResetsAt: sevenDay == null || sevenDay.resets_at == null ? null : sevenDay.resets_at,
      limits: Array.isArray(u.limits) ? u.limits : null,
      raw: u,
    };
  }
  return null;
}
