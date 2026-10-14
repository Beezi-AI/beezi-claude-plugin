// Wraps a git(args, cwd) function so each distinct (cwd, args) runs once; a throw is remembered and rethrown.
export function memoizeGit(gitImpl) {
  const memo = new Map();
  return function memoizedGit(args, cwd) {
    const key = [cwd].concat(args).join('\0'); // NUL cannot occur in a path or an argv entry
    if (memo.has(key)) {
      const hit = memo.get(key);
      if (hit.threw) throw hit.value;
      return hit.value;
    }
    let value;
    try {
      value = gitImpl(args, cwd);
    } catch (err) {
      memo.set(key, { threw: true, value: err });
      throw err;
    }
    memo.set(key, { threw: false, value });
    return value;
  };
}
