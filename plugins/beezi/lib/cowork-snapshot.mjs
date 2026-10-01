// The server replaces cumulative model rows unconditionally. Retain the last accepted
// complete snapshot if an older/partial cache would remove a model or reduce any counter.
export function nonRegressingSnapshot(next, previous) {
  if (previous == null || !Array.isArray(previous.models)) return next;
  if (next.total_cost_usd < previous.total_cost_usd) return previous;
  const models = new Map(next.models.map((model) => [model.model, model]));
  const counters = ['token_input', 'token_output', 'token_cache_read', 'token_cache_creation', 'cost_usd', 'thinking_tokens'];
  for (const prior of previous.models) {
    const candidate = models.get(prior.model);
    if (candidate == null) return previous;
    for (const key of counters) {
      if (typeof prior[key] === 'number' && (!(typeof candidate[key] === 'number') || candidate[key] < prior[key])) return previous;
    }
  }
  return next;
}

export function sameCumulativeUsage(a, b) {
  if (!a || !b) return false;
  const signature = (item) => JSON.stringify([item.total_cost_usd, item.has_unknown_model_cost,
    [...item.models].sort((x, y) => x.model.localeCompare(y.model))]);
  return signature(a) === signature(b);
}
