import fs from 'fs';
import readline from 'readline';
import stream from 'stream';
import tty from 'tty';
import { createStyle } from './setup-style.mjs';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const HINT_CHOOSE = '↑/↓ move · Enter select';
const HINT_SKIP = '↑/↓ move · Enter select · Esc skip';
const HINT_MANY = '↑/↓ move · Space select · Enter confirm (nothing selected = skip)';

function openDevTty() {
  return new tty.ReadStream(fs.openSync('/dev/tty', 'r'));
}

// stdin when it is a terminal, else /dev/tty off Windows, else null.
export function openTerminal(deps) {
  const d = deps || {};
  const stdin = d.stdin || process.stdin;
  const platform = d.platform || process.platform;
  const openTty = d.openTty || openDevTty;
  if (stdin.isTTY) return stdin;
  if (platform === 'win32') return null;
  try {
    return openTty();
  } catch (error) {
    return null;
  }
}

// "1, 3" → [0, 2]; null when any part is not an option number.
export function parseNumbers(answer, count) {
  const picked = [];
  const parts = answer.split(',').map((part) => part.trim()).filter((part) => part !== '');
  for (let i = 0; i < parts.length; i += 1) {
    if (!/^\d+$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n < 1 || n > count) return null;
    if (picked.indexOf(n - 1) === -1) picked.push(n - 1);
  }
  return picked;
}

// Numbered option rows with the default mark and the descriptions dimmed.
function styledOptions(options, defaultIndex, style) {
  return options.map((option, i) => {
    const mark = i === defaultIndex ? style.dim(' (default)') : '';
    const description = option.description ? style.dim(` — ${option.description}`) : '';
    return `  ${i + 1}) ${option.label}${mark}${description}`;
  });
}

export function renderOptions(options, defaultIndex) {
  return styledOptions(options, defaultIndex, createStyle({ enabled: false }));
}

const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1faff], [0x20000, 0x3fffd],
];

// Terminal columns one character takes: 2 for East Asian Wide and Fullwidth, else 1.
function columnsOf(char) {
  const code = char.codePointAt(0);
  return WIDE_RANGES.some((range) => code >= range[0] && code <= range[1]) ? 2 : 1;
}

function width(text) {
  return Array.from(text).reduce((sum, char) => sum + columnsOf(char), 0);
}

// Cuts text to room columns, ending a cut with ….
function fit(text, room) {
  if (width(text) <= room) return text;
  if (room <= 0) return '';
  let kept = '';
  let used = 0;
  for (const char of Array.from(text)) {
    if (used + columnsOf(char) > room - 1) break;
    kept += char;
    used += columnsOf(char);
  }
  return `${kept}…`;
}

// Moves the cursor up over rows lines and clears everything below it.
function erase(rows) {
  return `\x1b[${rows}A\x1b[0J`;
}

function isSubmit(key) {
  return key.name === 'return' || key.name === 'enter';
}

// Highlight after ↑/↓ or k/j, wrapping around; unchanged for any other key.
function step(str, key, cursor, count) {
  if (key.name === 'up' || str === 'k') return (cursor + count - 1) % count;
  if (key.name === 'down' || str === 'j') return (cursor + 1) % count;
  return cursor;
}

// 0-based option for a typed digit 1-9 within range, else -1.
function digitOption(str, count) {
  if (typeof str !== 'string' || !/^[1-9]$/.test(str)) return -1;
  const n = Number(str);
  return n <= count ? n - 1 : -1;
}

function isDigit(str) {
  return typeof str === 'string' && /^[0-9]$/.test(str);
}

// Digit run after typing str: run+str when that is an option number, else str alone, else ''.
function nextRun(run, str, count) {
  const combined = `${run}${str}`;
  if (run !== '' && Number(combined) <= count) return combined;
  return digitOption(str, count) === -1 ? '' : str;
}

// Feeds the line reader only the chunks that arrive while no key question is open.
function gateLines(input, keyOpen) {
  const lines = new stream.PassThrough();
  const onData = (chunk) => {
    if (!keyOpen()) lines.write(chunk);
  };
  input.prependListener('data', onData);
  input.on('end', () => lines.end());
  input.resume();
  return { lines, detach: () => input.removeListener('data', onData) };
}

export function createPrompt(io) {
  const input = io.input;
  const output = io.output;
  const style = io.style || createStyle({ enabled: false });
  const onInterrupt = io.onInterrupt || null;
  let keys = Boolean(io.interactive);
  let cancelKeys = null;
  const gate = keys ? gateLines(input, () => cancelKeys !== null) : null;
  const rl = readline.createInterface({ input: gate === null ? input : gate.lines, terminal: false });
  let waiting = null;
  let closed = false;
  if (keys) readline.emitKeypressEvents(input);

  function settle(value) {
    const resolve = waiting;
    waiting = null;
    resolve(value);
  }

  rl.on('line', (line) => {
    if (waiting !== null) settle(line.trim());
  });
  rl.on('close', () => {
    closed = true;
    if (waiting !== null) settle(null);
    if (cancelKeys !== null) cancelKeys();
  });

  function ask(query) {
    if (closed) return Promise.resolve(null);
    output.write(query);
    return new Promise((resolve) => { waiting = resolve; });
  }

  function showMenu(question, options, defaultIndex) {
    output.write(`\n${style.bold(question)}\n${styledOptions(options, defaultIndex, style).join('\n')}\n`);
  }

  // Turns raw mode on for one key question; false, and typed prompts from then on, when keys are off or it throws.
  function rawOn() {
    if (!keys) return false;
    try {
      input.setRawMode(true);
      return true;
    } catch (error) {
      keys = false;
      return false;
    }
  }

  // True when count menu rows fit above the terminal's last row, or its height is unknown.
  function fitsScreen(count) {
    return !output.rows || count < output.rows;
  }

  // Shows rows() with the cursor hidden, redraws it after each key onKey reports as a change, and resolves via finish.
  function keyQuestion(question, rows, onKey) {
    return new Promise((resolve, reject) => {
      let drawn = 0;
      function draw() {
        const lines = rows();
        output.write(`${drawn > 0 ? erase(drawn) : ''}${lines.join('\n')}\n`);
        drawn = lines.length;
      }
      function stop() {
        input.removeListener('keypress', onKeypress);
        input.setRawMode(false);
        cancelKeys = null;
        output.write(SHOW_CURSOR);
      }
      function finish(value, answer) {
        output.write(`${erase(drawn)}${style.green('✔')} ${style.bold(question)} ${answer}\n`);
        stop();
        resolve(value);
      }
      // Restores the terminal if this question is still open, then rejects with error.
      function fail(error) {
        if (cancelKeys !== null) stop();
        reject(error);
      }
      function onKeypress(str, key) {
        if (key.ctrl && key.name === 'c') {
          stop();
          if (onInterrupt !== null) onInterrupt();
          resolve(null);
          return;
        }
        try {
          if (onKey(str, key, finish)) draw();
        } catch (error) {
          fail(error);
        }
      }
      cancelKeys = () => {
        stop();
        resolve(null);
      };
      output.write(HIDE_CURSOR);
      try {
        draw();
      } catch (error) {
        fail(error);
        return;
      }
      input.on('keypress', onKeypress);
    });
  }

  // The question, one row per option and the hint, each cut to fit one terminal row.
  function menuRows(question, options, cursor, picked, hint) {
    const room = (output.columns || 80) - 1;
    const optionRoom = room - (picked === null ? 2 : 4);
    const rows = [`${style.boldCyan('?')} ${style.bold(fit(question, room - 2))}`];
    options.forEach((option, i) => {
      const active = i === cursor;
      const pointer = active ? style.cyan('❯') : ' ';
      const box = picked === null ? '' : `${picked.indexOf(i) === -1 ? style.dim('◯') : style.green('◉')} `;
      const label = fit(option.label, optionRoom);
      const description = option.description ? fit(` — ${option.description}`, optionRoom - width(label)) : '';
      rows.push(`${pointer} ${box}${active ? style.cyan(label) : label}${description ? style.dim(description) : ''}`);
    });
    rows.push(style.dim(`  ${fit(hint, room - 2)}`));
    return rows;
  }

  function keyChoose(question, options, defaultIndex) {
    let cursor = defaultIndex === -1 ? 0 : defaultIndex;
    let run = '';
    const hint = defaultIndex === -1 ? HINT_SKIP : HINT_CHOOSE;
    return keyQuestion(question, () => menuRows(question, options, cursor, null, hint), (str, key, finish) => {
      if (isSubmit(key)) {
        finish(cursor, style.cyan(options[cursor].label));
        return false;
      }
      if (key.name === 'escape' && defaultIndex === -1) {
        finish(null, style.dim('skipped'));
        return false;
      }
      run = isDigit(str) ? nextRun(run, str, options.length) : '';
      let next = step(str, key, cursor, options.length);
      if (isDigit(str)) next = run === '' ? cursor : Number(run) - 1;
      if (next === cursor) return false;
      cursor = next;
      return true;
    });
  }

  function keyChooseMany(question, options) {
    let cursor = 0;
    let run = '';
    const picked = [];
    const toggle = (i) => {
      const at = picked.indexOf(i);
      if (at === -1) picked.push(i);
      else picked.splice(at, 1);
    };
    return keyQuestion(question, () => menuRows(question, options, cursor, picked, HINT_MANY), (str, key, finish) => {
      if (isSubmit(key)) {
        const chosen = picked.slice().sort((a, b) => a - b);
        const labels = chosen.map((i) => options[i].label).join(', ');
        finish(chosen, chosen.length > 0 ? style.cyan(labels) : style.dim('skipped'));
        return false;
      }
      if (key.name === 'escape') {
        finish([], style.dim('skipped'));
        return false;
      }
      if (isDigit(str)) {
        const previous = run === '' ? -1 : Number(run) - 1;
        run = nextRun(run, str, options.length);
        if (run === '') return false;
        // A longer run undoes the toggle its shorter prefix applied.
        if (run.length > 1) toggle(previous);
        toggle(Number(run) - 1);
        return true;
      }
      run = '';
      if (key.name === 'space') {
        toggle(cursor);
        return true;
      }
      const next = step(str, key, cursor, options.length);
      if (next === cursor) return false;
      cursor = next;
      return true;
    });
  }

  function keyConfirm(question, defaultYes) {
    const choices = defaultYes ? '[Y/n]' : '[y/N]';
    let answer = null;
    const row = () => {
      const room = (output.columns || 80) - 1;
      const typed = answer === null ? '' : ` ${style.cyan(answer ? 'y' : 'n')}`;
      return [`${style.boldCyan('?')} ${style.bold(fit(question, room - 10))} ${style.boldCyan(choices)}${typed}`];
    };
    return keyQuestion(question, row, (str, key, finish) => {
      if (isSubmit(key)) {
        const value = answer === null ? defaultYes : answer;
        finish(value, style.cyan(value ? 'Yes' : 'No'));
        return false;
      }
      let next = answer;
      if (str === 'y' || str === 'Y') next = true;
      if (str === 'n' || str === 'N') next = false;
      if (next === answer) return false;
      answer = next;
      return true;
    });
  }

  async function choose(question, options, opts) {
    if (closed) return null;
    const defaultIndex = opts && typeof opts.defaultIndex === 'number' ? opts.defaultIndex : -1;
    if (fitsScreen(options.length + 2) && rawOn()) return keyChoose(question, options, defaultIndex);
    showMenu(question, options, defaultIndex);
    const range = `1-${options.length}`;
    const query = defaultIndex === -1 ? `Choose ${range}, or press Enter to skip:` : `Choose ${range} [${defaultIndex + 1}]:`;
    for (;;) {
      const answer = await ask(`${style.boldCyan(query)} `);
      if (answer === null) return null;
      if (answer === '') return defaultIndex === -1 ? null : defaultIndex;
      const picked = parseNumbers(answer, options.length);
      if (picked !== null && picked.length === 1) return picked[0];
      output.write(`${style.yellow(`Enter one number from 1 to ${options.length}.`)}\n`);
    }
  }

  async function chooseMany(question, options) {
    if (closed) return null;
    if (options.length === 0) return [];
    if (fitsScreen(options.length + 2) && rawOn()) return keyChooseMany(question, options);
    showMenu(question, options, -1);
    for (;;) {
      const answer = await ask(`${style.boldCyan('Choose one or more (for example 1,3), or press Enter to skip:')} `);
      if (answer === null) return null;
      const picked = parseNumbers(answer, options.length);
      if (picked !== null) return picked;
      output.write(`${style.yellow(`Enter numbers from 1 to ${options.length}, separated by commas.`)}\n`);
    }
  }

  async function confirm(question, defaultYes) {
    if (closed) return null;
    if (rawOn()) return keyConfirm(question, defaultYes);
    const query = `\n${style.bold(question)} ${style.boldCyan(defaultYes ? '[Y/n]' : '[y/N]')} `;
    for (;;) {
      const answer = await ask(query);
      if (answer === null) return null;
      if (answer === '') return defaultYes;
      if (/^(y|yes)$/i.test(answer)) return true;
      if (/^(n|no)$/i.test(answer)) return false;
      output.write(`${style.yellow('Answer y or n.')}\n`);
    }
  }

  // Reads one line in both modes.
  async function text(question) {
    const answer = await ask(`\n${style.bold(question)} `);
    return answer === null || answer === '' ? null : answer;
  }

  // Dismisses an open key question, closes the line reader and, in key mode, stops reading the terminal.
  function close() {
    if (cancelKeys !== null) cancelKeys();
    rl.close();
    if (gate !== null) {
      gate.detach();
      input.pause();
    }
  }

  return { choose, chooseMany, confirm, text, close };
}
