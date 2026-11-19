// How long a hook may spend on an inline queue flush. Claude Code kills a hook at 10 s; 7 s
// leaves room for the work after the flush and for process exit.
export const HOOK_FLUSH_BUDGET_MS = 7000;

// Absolute deadline (epoch ms) for a hook's network work. Measured from process start, not from
// this call, because Claude Code's 10 s clock starts when it spawns the hook: module loading,
// credential reads and the transcript parse have already used part of it.
export function hookDeadline(budgetMs = HOOK_FLUSH_BUDGET_MS, deps = {}) {
  const now = deps.now == null ? Date.now : deps.now;
  const uptime = deps.uptime == null ? process.uptime : deps.uptime;
  return now() - uptime() * 1000 + budgetMs;
}
