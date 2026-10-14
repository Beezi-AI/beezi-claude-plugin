import childProcess from 'child_process';
import path from 'path';

export function childEnv(env, sessionKeys) {
  const out = {};
  Object.keys(env).forEach((name) => {
    if (sessionKeys.indexOf(name) === -1) out[name] = env[name];
  });
  out.BEEZI_SETUP = '1';
  return out;
}

// Writes complete lines through paint as they arrive, skipping the ones matching hide.
function lineEcho(write, hide, paint) {
  let pending = '';
  const emit = (line) => {
    if (hide === null || !hide.test(line)) write(`${paint(line)}\n`);
  };
  return {
    push(chunk) {
      const parts = (pending + chunk).split('\n');
      pending = parts.pop();
      parts.forEach(emit);
    },
    flush() {
      if (pending !== '') emit(pending);
      pending = '';
    },
  };
}

export function createRunner(options) {
  const spawn = options.spawn || childProcess.spawn;
  const execPath = options.execPath || process.execPath;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const env = childEnv(options.env, options.sessionKeys);
  const paint = options.paint || ((line) => line);

  return function run(script, argv, opts) {
    const stream = Boolean(opts && opts.stream);
    const hide = opts && opts.hide ? opts.hide : null;
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      const echoOut = lineEcho((s) => stdout.write(s), hide, paint);
      const echoErr = lineEcho((s) => stderr.write(s), null, paint);
      const child = spawn(execPath, [path.join(options.root, 'scripts', script)].concat(argv), {
        cwd: options.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        out += chunk;
        if (stream) echoOut.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        err += chunk;
        if (stream) echoErr.push(chunk);
      });
      child.on('error', (error) => resolve({ code: 127, stdout: out, stderr: err + error.message }));
      child.on('close', (code) => {
        if (stream) {
          echoOut.flush();
          echoErr.flush();
        }
        resolve({ code: code === null ? 1 : code, stdout: out, stderr: err });
      });
    });
  };
}
