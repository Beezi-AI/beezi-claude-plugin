import { readBillingConfig } from './billing-config.mjs';
import { BillingSource } from './billing.mjs';
import { isCorrelationGranted, isTelemetryGranted, readConsent } from './telemetry-consent.mjs';

const PLAN_LABELS = { pro: 'Pro', max_5x: 'Max 5x', max_20x: 'Max 20x', team: 'Team', enterprise: 'Enterprise', api_key: 'API key', gateway: 'Billed by your gateway' };

// correlate, on (correlation never answered), anonymous (correlation declined) or off.
export function crashMode() {
  if (!isTelemetryGranted()) return 'off';
  if (isCorrelationGranted()) return 'correlate';
  const consent = readConsent();
  return consent != null && consent.correlation === 'denied' ? 'anonymous' : 'on';
}

// This machine's Claude plan as the settings screens name it.
export function claudePlan() {
  const config = readBillingConfig();
  if (config == null) return 'not captured yet — /beezi:settings refresh';
  if (config.source === BillingSource.ANTHROPIC_API_KEY) return 'API key';
  if (config.source === BillingSource.THIRD_PARTY) return 'Third-party provider';
  if (config.plan != null && PLAN_LABELS[config.plan] != null) return PLAN_LABELS[config.plan];
  return config.plan ? String(config.plan) : 'unknown — /beezi:settings refresh';
}
