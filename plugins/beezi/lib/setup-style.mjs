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

// Colours a line by its leading ✓, ⚠, ✗, "Setup stopped" or "==> ", keeping its leading whitespace.
export function paint(style, line) {
  const body = line.replace(/^\s+/, '');
  const lead = line.slice(0, line.length - body.length);
  if (body.startsWith('✓')) return lead + style.green(body);
  if (body.startsWith('⚠')) return lead + style.yellow(body);
  if (body.startsWith('✗') || body.startsWith('Setup stopped')) return lead + style.red(body);
  if (body.startsWith('==> ')) return `${lead}${style.blue('==>')}${body.slice(3)}`;
  return line;
}
