import { chooseAccount, signedInLine } from './setup-account.mjs';
import { closingLines } from './setup-finale.mjs';
import { applyDefaults, uploadPast } from './setup-finish.mjs';
import { capturePlan } from './setup-plan.mjs';
import { askTracking } from './setup-routing.mjs';

const MACHINE_LABEL = 'Checking this machine';
const SESSIONS_LABEL = 'Checking past sessions';
export const AGENT = 'Claude Code';

// Account, plan, tracking, upload, machine defaults, closing block (ctx.notices just before it); 1 when no account signed in.
export async function runSetup(ctx) {
  ctx.progress(MACHINE_LABEL);
  const account = await chooseAccount(ctx);
  if (account === null) return 1;
  ctx.print(await signedInLine(ctx, account));
  const plan = await capturePlan(ctx, account.key);
  if (plan !== null) ctx.print(`✓ Plan found: ${plan}`);
  ctx.progress(SESSIONS_LABEL);
  const tracking = await askTracking(ctx, account.key);
  if (tracking !== null && tracking.tracked) await uploadPast(ctx, account.key);
  if (tracking !== null) tracking.trailer.forEach((line) => ctx.print(line));
  ctx.progress(MACHINE_LABEL);
  const on = await applyDefaults(ctx);
  ctx.notices.forEach((line) => ctx.print(line));
  const pastFailed = tracking !== null && tracking.failed === true;
  closingLines({ agent: AGENT, style: ctx.style, crash: on.crash, statusline: on.statusline, planFound: plan !== null, pastFailed })
    .forEach((line) => ctx.print(line));
  return 0;
}
