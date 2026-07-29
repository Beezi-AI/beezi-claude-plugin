// Never force a hook process to exit. On Windows, process.exit() tears the event loop down
// while a handle is still mid-close, and libuv aborts the process:
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
// The abort is what Claude Code reports as "Stop hook error" — the hook's work had already
// finished and its stdout was already written, so nothing was actually broken except the
// exit. Reproduced 4/4 with process.exit() and 0/4 without it, same workload.
//
// So: drain undici's keep-alive pool (that pool is the only thing that would otherwise hold
// the loop open for keepAliveTimeout), record the exit code, and let the process end on its
// own. The unref'd timer is a last resort for the case where some other handle stays open —
// being unref'd, it can never keep the process alive itself, and force-exiting late still
// beats blowing the hook's 10s budget. Deps are injectable for tests.
const FORCE_EXIT_MS = 2000;

export async function exitClean(code = 0, deps = {}) {
  const getDispatcher =
    deps.getDispatcher ?? (() => globalThis[Symbol.for('undici.globalDispatcher.1')]);
  const exit = deps.exit ?? ((c) => process.exit(c));
  const setExitCode = deps.setExitCode ?? ((c) => { process.exitCode = c; });
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms).unref());

  const dispatcher = getDispatcher();
  if (dispatcher) {
    try { await dispatcher.close(); }
    catch { try { await dispatcher.destroy(); } catch { /* exit anyway */ } }
  }

  setExitCode(code);
  schedule(() => exit(code), deps.forceExitAfterMs ?? FORCE_EXIT_MS);
}
