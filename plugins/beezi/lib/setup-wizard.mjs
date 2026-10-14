import { chooseAccount } from './setup-account.mjs';
import { askMachineSettings, offerDefault, uploadHistory } from './setup-finish.mjs';
import { capturePlan } from './setup-plan.mjs';
import { askNewFolders, reviewJoined, reviewRoutes } from './setup-routing.mjs';

export const PLAN_PROGRESS = '==> Checking your plan…';
export const SESSIONS_PROGRESS = '==> Looking at your past sessions…';

// The terminal setup flow; 0 when done, 1 when no account was chosen or signed in.
export async function runSetup(ctx) {
  const account = await chooseAccount(ctx);
  if (account === null) return 1;
  await askNewFolders(ctx, account.key);
  ctx.print(PLAN_PROGRESS);
  await capturePlan(ctx, account.key);
  ctx.print(SESSIONS_PROGRESS);
  await reviewJoined(ctx, account.key);
  await reviewRoutes(ctx, account.key);
  await uploadHistory(ctx, account.key);
  await offerDefault(ctx, account);
  await askMachineSettings(ctx);
  return 0;
}
