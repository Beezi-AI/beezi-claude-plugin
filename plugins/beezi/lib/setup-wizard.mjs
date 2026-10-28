import { chooseAccount } from './setup-account.mjs';
import { askMachineSettings, offerDefault, uploadHistory } from './setup-finish.mjs';
import { capturePlan } from './setup-plan.mjs';
import { askNewFolders, reviewJoined, reviewRoutes } from './setup-routing.mjs';

export const MACHINE_LABEL = 'Checking this machine…';
export const WORKSPACES_LABEL = 'Checking your workspaces…';
export const PLAN_LABEL = 'Checking your plan…';
export const SESSIONS_LABEL = 'Looking at your past sessions…';
export const SETTINGS_LABEL = 'Saving your settings…';

// The terminal setup flow; 0 when done, 1 when no account was chosen or signed in. Each phase names the activity line its runs show.
export async function runSetup(ctx) {
  ctx.progress(MACHINE_LABEL);
  const account = await chooseAccount(ctx);
  if (account === null) return 1;
  ctx.progress(WORKSPACES_LABEL);
  await askNewFolders(ctx, account.key);
  ctx.progress(PLAN_LABEL);
  await capturePlan(ctx, account.key);
  ctx.progress(SESSIONS_LABEL);
  await reviewJoined(ctx, account.key);
  await reviewRoutes(ctx, account.key);
  await uploadHistory(ctx, account.key);
  ctx.progress(SETTINGS_LABEL);
  await offerDefault(ctx, account);
  await askMachineSettings(ctx);
  return 0;
}
