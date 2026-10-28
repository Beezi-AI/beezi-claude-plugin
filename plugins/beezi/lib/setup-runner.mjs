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

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// Conhost's default font draws braille as boxes.
const ASCII_FRAMES = ['|', '/', '-', '\\'];
const FIRST_DRAW_MS = 150;
const FRAME_MS = 80;
const CLEAR_LINE = '\r\x1b[2K';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// Writes complete lines through paint as they arrive, skipping the ones matching hide; a line matching live goes to onLive instead, and the activity line, when given, is cleared before each write and redrawn after.
function lineEcho(write, hide, paint, activity, live, onLive) {
  let pending = '';
  const emit = (line) => {
    if (hide !== null && hide.test(line)) return;
    const found = live === null ? null : live.exec(line);
    if (found !== null) {
      onLive(found);
      return;
    }
    if (activity !== null) activity.hide();
    write(`${paint(line)}\n`);
    if (activity !== null) activity.show();
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

// "<frame> <text>" on one terminal row while a child runs: first drawn after FIRST_DRAW_MS, then every FRAME_MS.
function createActivity(output, frames, timers) {
  let text = '';
  let frame = 0;
  let shown = false;
  let delay = null;
  let ticker = null;
  function fitted() {
    const room = (output.columns || 80) - 3;
    const chars = Array.from(text);
    return chars.length <= room ? text : `${chars.slice(0, room - 1).join('')}…`;
  }
  function draw() {
    output.write(`${shown ? '' : HIDE_CURSOR}${CLEAR_LINE}${frames[frame % frames.length]} ${fitted()}`);
    shown = true;
    frame += 1;
  }
  return {
    start(label) {
      text = label;
      frame = 0;
      delay = timers.setTimeout(() => {
        delay = null;
        draw();
        ticker = timers.setInterval(draw, FRAME_MS);
      }, FIRST_DRAW_MS);
    },
    setText(label) {
      text = label;
      if (shown) draw();
    },
    hide() {
      if (shown) output.write(CLEAR_LINE);
    },
    show() {
      if (shown) draw();
    },
    stop() {
      if (delay !== null) timers.clearTimeout(delay);
      if (ticker !== null) timers.clearInterval(ticker);
      delay = null;
      ticker = null;
      if (shown) output.write(`${CLEAR_LINE}${SHOW_CURSOR}`);
      shown = false;
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
  const frames = (options.platform || process.platform) === 'win32' ? ASCII_FRAMES : FRAMES;
  const timers = options.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
  const activity = options.activity ? createActivity(options.output || stdout, frames, timers) : null;
  let label = null;

  function run(script, argv, opts) {
    const stream = Boolean(opts && opts.stream);
    const hide = opts && opts.hide ? opts.hide : null;
    const text = opts && opts.label ? opts.label : label;
    const busy = activity !== null && text !== null ? activity : null;
    const live = busy !== null && opts && opts.live ? opts.live : null;
    const onLive = (found) => { busy.setText(`${text} ${found[1]}/${found[2]}`); };
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      const echoOut = lineEcho((s) => stdout.write(s), hide, paint, busy, live, onLive);
      const echoErr = lineEcho((s) => stderr.write(s), null, paint, busy, null, onLive);
      const finish = (result) => {
        if (busy !== null) busy.stop();
        resolve(result);
      };
      const child = spawn(execPath, [path.join(options.root, 'scripts', script)].concat(argv), {
        cwd: options.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (busy !== null) busy.start(text);
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
      child.on('error', (error) => finish({ code: 127, stdout: out, stderr: err + error.message }));
      child.on('close', (code) => {
        if (stream) {
          echoOut.flush();
          echoErr.flush();
        }
        finish({ code: code === null ? 1 : code, stdout: out, stderr: err });
      });
    });
  }
  run.setLabel = (text) => { label = typeof text === 'string' && text !== '' ? text : null; };
  run.clearActivity = () => { if (activity !== null) activity.stop(); };
  return run;
}
