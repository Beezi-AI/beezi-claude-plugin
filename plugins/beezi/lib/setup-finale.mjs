const MARK = [
  '   ▄▄█',
  '▄███▀▀ ▄▄██▄',
  '▀▀ ▄▄███▀▀',
  '▄███▀▀ ▄▄███',
  '      █▀▀▀',
];

const MARK_WIDTH = 12;
const MARK_GAP = '   ';
const WORD_ROW = 1;
const AGENT_ROW = 2;
const SETTINGS = '(/beezi:settings)';
export const NO_PLAN = "Beezi couldn't detect this machine's plan. Set it in /beezi:settings.";
const PAST_FAILED = "Beezi couldn't check past sessions. Run /beezi:login to choose what to track.";

// The setup's header: the mark with "beezi" and "for <agent>" beside it, or the plain "Beezi for <agent>" line when colour is off.
export function headerLines(options) {
  const style = options.style;
  if (!style.enabled) return [`Beezi for ${options.agent}`, ''];
  const side = { [WORD_ROW]: style.bold('beezi'), [AGENT_ROW]: style.dim(`for ${options.agent}`) };
  const rows = MARK.map((row, i) => {
    const art = style.mark(i, row.padEnd(MARK_WIDTH));
    return side[i] === undefined ? `  ${art}` : `  ${art}${MARK_GAP}${side[i]}`;
  });
  return [''].concat(rows, ['']);
}

// What is on after the run, for the closing dim line; null when neither is.
function onPhrase(crash, statusline) {
  if (crash && statusline) return 'Crash reports and the status line are on';
  if (crash) return 'Crash reports are on';
  return statusline ? 'The status line is on' : null;
}

// The closing block: the Ready line, then dim lines for what is on, a plan that was not found and past sessions not checked.
export function closingLines(options) {
  const style = options.style;
  const on = onPhrase(options.crash, options.statusline);
  const lines = ['', `${style.bold('Ready.')} Restart ${options.agent} and keep working.`];
  if (on !== null) lines.push(style.dim(`${on} ${SETTINGS}`));
  if (!options.planFound) lines.push(style.dim(NO_PLAN));
  if (options.pastFailed) lines.push(style.dim(PAST_FAILED));
  return lines;
}
