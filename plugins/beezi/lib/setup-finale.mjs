export const MARK = [
  '           ▄▄',
  '       ▄▄████',
  '    ▄▄███████',
  '▄▄██████████▀      ▄▄███▄',
  '█████████▀▀     ▄█████████',
  '█████▀▀     ▄▄█████████▀▀',
  '▀▀▀      ▄▄█████████▀▀',
  '      ▄██████████▀      ▄▄',
  '  ▄▄█████████▀▀      ▄████',
  '▄█████████▀▀     ▄▄███████',
  '▀██████▀     ▄▄██████████▀',
  '   ▀▀        █████████▀',
  '             █████▀▀',
  '             █▀▀',
];

export const WORDMARK = [
  '██████╗ ███████╗███████╗███████╗██╗',
  '██╔══██╗██╔════╝██╔════╝╚══███╔╝██║',
  '██████╔╝█████╗  █████╗    ███╔╝ ██║',
  '██╔══██╗██╔══╝  ██╔══╝   ███╔╝  ██║',
  '██████╔╝███████╗███████╗███████╗██║',
  '╚═════╝ ╚══════╝╚══════╝╚══════╝╚═╝',
];

export const FUN_LINES = [
  'The hive is counting your tokens now. You just write the code.',
  'Bee-lieve in yourself. And in your cache hit rate.',
  'A bee visits about 2 million flowers for a pound of honey. Your agent will read fewer files. Probably.',
  'Go ship something. We will keep the receipts.',
  'Buzzing quietly in the background. You will not even notice us.',
  'Pro tip: the cheapest token is the one you never send.',
  'Fresh hive, zero stings. Happy building.',
];

const MARK_WIDTH = 27;
const WIDE_COLUMNS = 72;
const WORDMARK_FIRST_ROW = 3;
const AGENT_ROW = 10;

// Mark rows in the violet ramp, with the wordmark beside rows 3-8 and "× <agent>" beside row 10.
function banner(agent, style) {
  return MARK.map((row, i) => {
    const left = style.violet(i, row.padEnd(MARK_WIDTH));
    const word = WORDMARK[i - WORDMARK_FIRST_ROW];
    if (word !== undefined) return `  ${left}  ${style.bold(word)}`;
    if (i === AGENT_ROW) return `  ${left}  ${style.dim('×')} ${style.bold(agent)}`;
    return `  ${left}`;
  });
}

// The closing block: the art (one ▰ line under 72 columns), the done line, the restart line and a random fun line.
export function finaleLines(options) {
  const agent = options.agent;
  const style = options.style;
  const fun = FUN_LINES[Math.floor(options.random() * FUN_LINES.length)];
  const head = options.columns >= WIDE_COLUMNS ? banner(agent, style) : [`  ${style.violet(3, '▰')} beezi × ${agent}`];
  return [''].concat(head, [
    '',
    `  ${style.boldGreen('✔ Everything is set up. Happy hacking! =)')}`,
    `  Open ${agent} and keep working — restart it first if it was already open.`,
    `  ${style.dim(`🐝 ${fun}`)}`,
    '',
  ]);
}
