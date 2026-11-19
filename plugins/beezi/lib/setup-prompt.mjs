import fs from 'fs';
import readline from 'readline';
import stream from 'stream';
import tty from 'tty';
import { createStyle } from './setup-style.mjs';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const HINT_CHOOSE = '↑↓ to move, Enter to choose';
const HINT_TICK = '↑↓ to move, Space to tick, Enter to confirm';
const QUESTION_INDENT = '  ';
const OPTION_INDENT = '    ';
const WINDOW_ROWS = 10;
const LABEL_GAP = 3;

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

// Unticks a picked row, else ticks it.
export function togglePick(picked, i) {
  return picked.indexOf(i) !== -1 ? picked.filter((p) => p !== i) : picked.concat(i);
}

// The first option row shown, moved only as far as keeps the pointer inside the window.
function windowTop(top, cursor) {
  if (cursor < top) return cursor;
  if (cursor >= top + WINDOW_ROWS) return cursor - WINDOW_ROWS + 1;
  return top;
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

// The label column: the widest label plus the gap, narrowed for the descriptions but never below half the room.
function labelColumn(options, room) {
  const labels = Math.max(...options.map((option) => width(option.label)));
  const descriptions = Math.max(...options.map((option) => (option.description ? width(option.description) : 0)));
  return Math.min(labels + LABEL_GAP, Math.max(room - descriptions, Math.floor(room / 2)));
}

// An option's label padded to the column and its description cut to what is left of the room.
function optionCells(option, column, room) {
  if (!option.description) return { label: fit(option.label, room), description: '' };
  const label = fit(option.label, column - LABEL_GAP);
  return { label: label + ' '.repeat(column - width(label)), description: fit(option.description, room - column) };
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

// io.format renders each lead line (the lines shown above a question) as one or more \n-joined terminal rows.
export function createPrompt(io) {
  const input = io.input;
  const output = io.output;
  const style = io.style || createStyle({ enabled: false });
  const format = io.format || ((line) => line);
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

  function leadRows(lead) {
    const rows = [];
    lead.forEach((line) => { rows.push(...format(line).split('\n')); });
    return rows.length ? [''].concat(rows) : rows;
  }

  function questionRow(question) {
    return `${QUESTION_INDENT}${style.accent('◆')} ${style.bold(question)}`;
  }

  function showMenu(question, options, lead) {
    const rows = options.map((option, i) => {
      const description = option.description ? style.dim(`  ${option.description}`) : '';
      return `${OPTION_INDENT}${i + 1}) ${option.label}${description}`;
    });
    output.write(`${leadRows(lead).concat('', questionRow(question), rows).join('\n')}\n`);
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

  // True when count rows fit above the terminal's last row, or its height is unknown.
  function fitsScreen(count) {
    return !output.rows || count < output.rows;
  }

  // Shows rows() with the cursor hidden, redraws it after each key onKey reports as a change, and erases it all on finish.
  function keyQuestion(rows, onKey) {
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
      function finish(value) {
        output.write(erase(drawn));
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

  // The lead, the question, a window of option rows and the hint, each option row cut to one terminal row.
  function menuRows(menu, cursor, picked, top) {
    const room = (output.columns || 80) - 1;
    const optionRoom = room - OPTION_INDENT.length - (picked === null ? 2 : 4);
    const column = labelColumn(menu.options, optionRoom);
    const rows = leadRows(menu.lead).concat('', questionRow(fit(menu.question, room - QUESTION_INDENT.length - 2)));
    menu.options.slice(top, top + WINDOW_ROWS).forEach((option, k) => {
      const i = top + k;
      const ticked = picked !== null && picked.indexOf(i) !== -1;
      const cells = optionCells(option, column, optionRoom);
      let tone = style.dim;
      if (i === cursor) tone = style.bold;
      else if (ticked) tone = (text) => text;
      const pointer = i === cursor ? style.accent('❯') : ' ';
      let box = '';
      if (picked !== null) box = `${ticked ? style.accent('◉') : style.dim('◯')} `;
      rows.push(`${OPTION_INDENT}${pointer} ${box}${tone(cells.label)}${cells.description ? style.dim(cells.description) : ''}`);
    });
    rows.push(`${OPTION_INDENT}${style.dim(fit(picked === null ? HINT_CHOOSE : HINT_TICK, room - OPTION_INDENT.length))}`);
    return rows;
  }

  function keyChoose(menu) {
    let cursor = 0;
    let top = 0;
    let run = '';
    return keyQuestion(() => menuRows(menu, cursor, null, top), (str, key, finish) => {
      if (isSubmit(key)) {
        finish(cursor);
        return false;
      }
      run = isDigit(str) ? nextRun(run, str, menu.options.length) : '';
      let next = step(str, key, cursor, menu.options.length);
      if (isDigit(str)) next = run === '' ? cursor : Number(run) - 1;
      if (next === cursor) return false;
      cursor = next;
      top = windowTop(top, cursor);
      return true;
    });
  }

  function keyChooseMany(menu, initial) {
    let cursor = 0;
    let top = 0;
    let run = '';
    let before = [];
    let picked = initial.slice();
    return keyQuestion(() => menuRows(menu, cursor, picked, top), (str, key, finish) => {
      if (isSubmit(key)) {
        finish(picked.slice().sort((a, b) => a - b));
        return false;
      }
      if (isDigit(str)) {
        run = nextRun(run, str, menu.options.length);
        if (run === '') return false;
        // A fresh run remembers the ticks before it; a longer run starts over from them, so it undoes its prefix's toggle.
        if (run.length === 1) before = picked.slice();
        picked = togglePick(before, Number(run) - 1);
        return true;
      }
      run = '';
      if (key.name === 'space') {
        picked = togglePick(picked, cursor);
        return true;
      }
      const next = step(str, key, cursor, menu.options.length);
      if (next === cursor) return false;
      cursor = next;
      top = windowTop(top, cursor);
      return true;
    });
  }

  // Answers the 0-based option; Enter picks the first. Esc does nothing: the question cannot be dismissed. opts.lead lines show above it and fold away with it.
  async function choose(question, options, opts) {
    if (closed) return null;
    const menu = { question, options, lead: opts && Array.isArray(opts.lead) ? opts.lead : [] };
    if (fitsScreen(menuRows(menu, 0, null, 0).length) && rawOn()) return keyChoose(menu);
    showMenu(question, options, menu.lead);
    for (;;) {
      const answer = await ask(`${QUESTION_INDENT}${style.bold(`Choose 1-${options.length} [1]:`)} `);
      if (answer === null) return null;
      if (answer === '') return 0;
      const picked = parseNumbers(answer, options.length);
      if (picked !== null && picked.length === 1) return picked[0];
      output.write(`${QUESTION_INDENT}Enter one number from 1 to ${options.length}.\n`);
    }
  }

  // Answers the ticked rows, sorted; opts.initial rows start ticked, a typed Enter keeps them and `none` ticks nothing. Esc does nothing.
  async function chooseMany(question, options, opts) {
    if (closed) return null;
    if (options.length === 0) return [];
    const initial = opts && Array.isArray(opts.initial) ? opts.initial : [];
    const menu = { question, options, lead: [] };
    if (fitsScreen(menuRows(menu, 0, initial, 0).length) && rawOn()) return keyChooseMany(menu, initial);
    showMenu(question, options, []);
    const query = initial.length === 0
      ? 'Choose one or more (for example 1,2), or press Enter for none:'
      : `Choose one or more (for example 1,2), or type none [${initial.map((i) => i + 1).join(',')}]:`;
    for (;;) {
      const answer = await ask(`${QUESTION_INDENT}${style.bold(query)} `);
      if (answer === null) return null;
      if (answer === '') return initial.slice();
      if (answer.trim().toLowerCase() === 'none') return [];
      const picked = parseNumbers(answer, options.length);
      if (picked !== null) return picked;
      output.write(`${QUESTION_INDENT}Enter numbers from 1 to ${options.length}, separated by commas.\n`);
    }
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

  return { choose, chooseMany, close };
}
