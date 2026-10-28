const RESET = '\x1b[0m';
const VIOLETS = [183, 177, 171, 141, 135, 99, 98, 97, 63, 62, 61, 60, 60, 60];

// True when the stream is a terminal, NO_COLOR is unset and TERM is not dumb.
export function colorEnabled(options) {
  return options.stream.isTTY === true && !options.env.NO_COLOR && options.env.TERM !== 'dumb';
}

// True when single keys can be read from input while output is a terminal.
export function canReadKeys(options) {
  return options.input.isTTY === true
    && typeof options.input.setRawMode === 'function'
    && options.output.isTTY === true
    && options.env.TERM !== 'dumb';
}

// ANSI wrappers that return the text unchanged when colour is off.
export function createStyle(options) {
  const enabled = Boolean(options.enabled);
  const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}${RESET}` : text);
  return {
    enabled,
    bold: wrap('1'),
    dim: wrap('2'),
    cyan: wrap('36'),
    boldCyan: wrap('1;36'),
    blue: wrap('1;34'),
    green: wrap('32'),
    boldGreen: wrap('1;32'),
    yellow: wrap('33'),
    red: wrap('31'),
    violet: (level, text) => (enabled ? `\x1b[38;5;${VIOLETS[level]}m${text}${RESET}` : text),
  };
}

const MAX_ROW = 100;

// The style a line's leading ✓, ⚠, ✗ or "Setup stopped" calls for, or null.
function toneOf(body) {
  if (body.startsWith('✓')) return 'green';
  if (body.startsWith('⚠')) return 'yellow';
  if (body.startsWith('✗') || body.startsWith('Setup stopped')) return 'red';
  return null;
}

// Colours a line by its leading ✓, ⚠, ✗, "Setup stopped" or "==> ", keeping its leading whitespace.
export function paint(style, line) {
  const body = line.replace(/^\s+/, '');
  const lead = line.slice(0, line.length - body.length);
  const tone = toneOf(body);
  if (tone !== null) return lead + style[tone](body);
  if (body.startsWith('==> ')) return `${lead}${style.blue('==>')}${body.slice(3)}`;
  return line;
}

// Rows of at most min(columns − 1, 100) characters, broken at spaces: later rows keep the line's indent plus 2; a word longer than a row stays whole.
export function wrapLines(line, columns) {
  const room = Math.min(Math.max((columns || 80) - 1, 20), MAX_ROW);
  if (Array.from(line).length <= room) return [line];
  const body = line.replace(/^\s+/, '');
  const lead = line.slice(0, line.length - body.length);
  const hang = `${lead}  `;
  const rows = [];
  let row = '';
  body.split(' ').forEach((word) => {
    const prefix = rows.length === 0 ? lead : hang;
    if (row === '') {
      row = word;
    } else if (Array.from(`${prefix}${row} ${word}`).length > room) {
      rows.push(prefix + row);
      row = word;
    } else {
      row = `${row} ${word}`;
    }
  });
  rows.push((rows.length === 0 ? lead : hang) + row);
  return rows;
}

// Wrapped rows joined with \n: the first painted as paint() does, every later one in the first row's tone.
export function paintRows(style, rows) {
  const tone = toneOf(rows[0].replace(/^\s+/, ''));
  return rows.map((row, i) => {
    if (i === 0) return paint(style, row);
    if (tone === null) return row;
    const rest = row.replace(/^\s+/, '');
    return row.slice(0, row.length - rest.length) + style[tone](rest);
  }).join('\n');
}

// One printed line wrapped to the terminal and painted; each \n-separated part wraps on its own.
export function formatLine(style, line, columns) {
  return String(line).split('\n').map((part) => paintRows(style, wrapLines(part, columns))).join('\n');
}
