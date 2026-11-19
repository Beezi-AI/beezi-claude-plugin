const RESET = '\x1b[0m';
const ACCENT_TRUE = '38;2;135;91;247';
const ACCENT_256 = '38;5;99';
const MARK_FROM = [111, 141, 255];
const MARK_TO = [105, 56, 239];
const MARK_RAMP = [69, 63, 63, 99, 99];

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

// One mark column's colour on the #6F8DFF → #6938EF gradient.
function gradientCode(column, columns) {
  const at = columns > 1 ? column / (columns - 1) : 0;
  const rgb = MARK_FROM.map((from, i) => Math.round(from + (MARK_TO[i] - from) * at));
  return `38;2;${rgb.join(';')}`;
}

// ANSI wrappers that return the text unchanged when colour is off; truecolor picks the 24-bit accent and mark gradient.
export function createStyle(options) {
  const enabled = Boolean(options.enabled);
  const truecolor = Boolean(options.truecolor);
  const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}${RESET}` : text);
  function mark(row, text) {
    if (!enabled) return text;
    if (!truecolor) return `\x1b[38;5;${MARK_RAMP[row]}m${text}${RESET}`;
    const chars = Array.from(text);
    return chars.map((char, i) => (char === ' ' ? char : `\x1b[${gradientCode(i, chars.length)}m${char}${RESET}`)).join('');
  }
  return {
    enabled,
    bold: wrap('1'),
    dim: wrap('2'),
    blue: wrap('1;34'),
    red: wrap('31'),
    accent: wrap(truecolor ? ACCENT_TRUE : ACCENT_256),
    mark,
  };
}

// The style for a terminal stream: colour per colorEnabled, truecolor when COLORTERM says so.
export function terminalStyle(options) {
  return createStyle({
    enabled: colorEnabled(options),
    truecolor: options.env.COLORTERM === 'truecolor' || options.env.COLORTERM === '24bit',
  });
}

const MAX_ROW = 100;
const SGR = /\x1b\[[0-9;]*m/g;
const OFFER_H1 = /^(Beezi found \d+ past .+ sessions?) (\(.+\))$/;
const OFFER_H2 = /^ {2}in (.+?)( \+\d+ more)?$/;
const OFFER_ITEM = /^ {4}([✓◆✕]) (.+)$/;
const OFFER_HIDDEN = '  Hidden by your workspace';
const OFFER_HIDDEN_NOTE = ' — Beezi gets made-up names';
const OFFER_ALWAYS = /^ {2}Always sent: /;
// A combined checklist's workspace line: "<name> · " and one of hidesPhrase's three forms.
const OFFER_WORKSPACE = /^ {2}(.+) (· (?:made-up names for |names as they are|names and titles as they are).*)$/;
// A leading mark's glyph style; ✗ also makes the rest of its line bold.
const MARK_STYLES = { '✓': 'accent', '⚠': 'accent', '✗': 'red', '–': 'dim' };
const BOLD_REST = '✗';

// Visible characters, with SGR colour codes not counted.
function visible(text) {
  return Array.from(text.replace(SGR, '')).length;
}

// Colours a line's leading ✓, ⚠, ✗, – or "==> ", keeping its leading whitespace.
export function paint(style, line) {
  const body = line.replace(/^\s+/, '');
  const lead = line.slice(0, line.length - body.length);
  const glyph = body.charAt(0);
  if (MARK_STYLES[glyph] !== undefined) {
    const rest = body.slice(1);
    return `${lead}${style[MARK_STYLES[glyph]](glyph)}${glyph === BOLD_REST ? style.bold(rest) : rest}`;
  }
  if (body.startsWith('==> ')) return `${lead}${style.blue('==>')}${body.slice(3)}`;
  return line;
}

// Styles one past-sessions checklist line by its exact shape (H1, H2, Sent, Hidden, Never sent, ✓/◆/✕ items, Always sent, workspace); any other line comes back unchanged.
export function offerLine(style, line) {
  const head = OFFER_H1.exec(line);
  if (head !== null) return `${style.bold(head[1])} ${style.dim(head[2])}`;
  const item = OFFER_ITEM.exec(line);
  if (item !== null && item[1] !== '✕') return `    ${style.accent(item[1])} ${item[2]}`;
  if (item !== null) return `    ${style.dim('✕')} ${style.dim(item[2])}`;
  if (line === `${OFFER_HIDDEN}${OFFER_HIDDEN_NOTE}`) return `${OFFER_HIDDEN}${style.dim(OFFER_HIDDEN_NOTE)}`;
  if (line === '  Never sent') return `  ${style.dim('Never sent')}`;
  const folders = OFFER_H2.exec(line);
  if (folders !== null) return `  ${style.dim('in')} ${folders[1]}${folders[2] === undefined ? '' : ` ${style.dim(folders[2].trim())}`}`;
  if (OFFER_ALWAYS.test(line)) return `  ${style.dim(line.slice(2))}`;
  const workspace = OFFER_WORKSPACE.exec(line);
  if (workspace !== null) return `  ${workspace[1]} ${style.dim(workspace[2])}`;
  return line;
}

// Rows of at most min(columns − 1, 100) visible characters, broken at spaces: later rows keep the line's indent plus 2; a word longer than a row stays whole.
export function wrapLines(line, columns) {
  const room = Math.min(Math.max((columns || 80) - 1, 20), MAX_ROW);
  if (visible(line) <= room) return [line];
  const body = line.replace(/^\s+/, '');
  const lead = line.slice(0, line.length - body.length);
  const hang = `${lead}  `;
  const rows = [];
  let row = '';
  body.split(' ').forEach((word) => {
    const prefix = rows.length === 0 ? lead : hang;
    if (row === '') {
      row = word;
    } else if (visible(`${prefix}${row} ${word}`) > room) {
      rows.push(prefix + row);
      row = word;
    } else {
      row = `${row} ${word}`;
    }
  });
  rows.push((rows.length === 0 ? lead : hang) + row);
  return rows;
}

// Wrapped rows joined with \n: the first painted as paint() does; later rows of a ✗ line stay bold.
export function paintRows(style, rows) {
  const bold = rows[0].replace(/^\s+/, '').charAt(0) === BOLD_REST;
  return rows.map((row, i) => {
    if (i === 0) return paint(style, row);
    if (!bold) return row;
    const rest = row.replace(/^\s+/, '');
    return row.slice(0, row.length - rest.length) + style.bold(rest);
  }).join('\n');
}

// One printed line wrapped to the terminal and painted; each \n-separated part wraps on its own.
export function formatLine(style, line, columns) {
  return String(line).split('\n').map((part) => paintRows(style, wrapLines(part, columns))).join('\n');
}
