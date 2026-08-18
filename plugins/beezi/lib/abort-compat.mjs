// AbortController shim for Node < 15, which has no global `AbortController`.
// `resolveAbortController()` is what call sites use; it hands back the real global when
// present so behavior on Node 15+ is untouched, and falls back to a minimal polyfill
// covering only the surface this codebase exercises: `controller.abort()`,
// `signal.aborted`, and `signal.addEventListener('abort', fn, { once })` /
// `removeEventListener` — exactly what `fetch-compat.mjs`'s `sendOnce()` consumes.
// It is not a spec-complete AbortController polyfill (no `reason`, no `throwIfAborted`,
// no EventTarget inheritance, no `onabort` property).

class AbortSignalShim {
  constructor() {
    this.aborted = false;
    // Map fn -> { once } so removeEventListener can match by function identity, and a
    // long-lived signal shared across calls does not accumulate one-shot listeners.
    this._listeners = new Map();
  }

  addEventListener(type, fn, options) {
    if (type !== 'abort') return;
    this._listeners.set(fn, { once: Boolean(options && options.once) });
  }

  removeEventListener(type, fn) {
    if (type !== 'abort') return;
    this._listeners.delete(fn);
  }
}

class AbortControllerShim {
  constructor() {
    this.signal = new AbortSignalShim();
  }

  abort() {
    const signal = this.signal;
    if (signal.aborted) return;
    signal.aborted = true;
    // Snapshot before firing so a listener that mutates the map mid-dispatch (e.g. by
    // removing itself) cannot skip or double-fire its neighbors.
    const entries = Array.from(signal._listeners.entries());
    for (const [fn, opts] of entries) {
      if (opts.once) signal._listeners.delete(fn);
      fn({ type: 'abort' });
    }
  }
}

export function resolveAbortController() {
  return typeof globalThis.AbortController === 'function'
    ? globalThis.AbortController
    : AbortControllerShim;
}
