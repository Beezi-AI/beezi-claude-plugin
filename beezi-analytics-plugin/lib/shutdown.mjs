// Gracefully drain undici's keep-alive pool before a forced exit. On Windows,
// process.exit() while undici still holds its async handle trips the libuv
// assertion (!(handle->flags & UV_HANDLE_CLOSING), async.c). close() releases
// those handles first, then a setImmediate tick lets libuv run the sockets'
// close callbacks so no handle is still mid-close when process.exit() forces
// teardown. Falls back to plain exit if the internal dispatcher symbol ever
// goes away. Deps are injectable for tests.
export async function exitClean(code = 0, deps = {}) {
  const getDispatcher =
    deps.getDispatcher ?? (() => globalThis[Symbol.for('undici.globalDispatcher.1')]);
  const exit = deps.exit ?? ((c) => process.exit(c));

  const dispatcher = getDispatcher();
  if (dispatcher) {
    try { await dispatcher.close(); }
    catch { try { await dispatcher.destroy(); } catch { /* exit anyway */ } }
  }
  // One loop tick so libuv flushes the closed sockets' async callbacks before the forced exit.
  await new Promise((resolve) => setImmediate(resolve));
  exit(code);
}
