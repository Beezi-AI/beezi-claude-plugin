import { isMultiTenant, joinTenantNames, newFoldersOf, resolveTargets, tenantsOf } from './workspace.mjs';
import { createRouteContext, displayPath, routeForDir, routeKeyForDir, rulesOf, shortLabel } from './workspace-rules.mjs';
import { normPath, resolveRepoForRouting } from './repo-map.mjs';

// Where a directory is, as every screen names it: { key, short, kind, path, remote }; null without a directory.
// `path` is the repo root or folder (~ for home), `remote` the repo's canonical remote; both null outside a project.
export function placeOfDir(dir, ctx) {
  const context = ctx == null ? createRouteContext() : ctx;
  const key = routeKeyForDir(dir, context);
  if (key == null) return null;
  const place = { key, short: shortLabel(key), kind: key.kind, path: null, remote: null };
  if (key.kind === 'folder') place.path = key.label;
  if (key.kind === 'repo') {
    const found = resolveRepoForRouting(dir, context.map());
    place.path = found.root == null ? null : displayPath(normPath(found.root));
    place.remote = key.match;
  }
  return place;
}

// "a git repo", "a folder" or null (outside a project), for "labacus-suite, a git repo".
export function kindWords(place) {
  if (place == null) return null;
  if (place.kind === 'repo') return 'a git repo';
  return place.kind === 'folder' ? 'a folder' : null;
}

function sameKey(rule, key) {
  if (rule == null || key == null || rule.kind !== key.kind) return false;
  if (rule.kind === 'outside') return true;
  if (rule.kind === 'repo') return String(rule.match).toLowerCase() === String(key.match).toLowerCase();
  return normPath(rule.match) === normPath(key.match);
}

// The route of a place with no rule of its own: the one workspace, else New folders (send, don't send, or ask).
export function defaultRoute(row) {
  const tenants = tenantsOf(row);
  if (tenants == null || tenants.length === 0) return { ids: [], reason: { kind: 'unknown' } };
  if (!isMultiTenant(row)) return { ids: [tenants[0].id], reason: { kind: 'default' } };
  const newFolders = newFoldersOf(row);
  if (newFolders.mode === 'send') return { ids: newFolders.tenantIds, reason: { kind: 'default' } };
  if (newFolders.mode === 'none') return { ids: [], reason: { kind: 'default' } };
  return { ids: [], reason: { kind: 'pending' } };
}

// Where a directory's analytics go under the stored rules: { ids, reason }.
// reason: { kind: 'rule', index, own, short } (own: the rule is for this very place, not a parent folder),
// { kind: 'default' }, { kind: 'pending' } (Ask me, no rule yet) or { kind: 'unknown' } (workspaces not known).
export function routeOfDir(row, dir, ctx) {
  const context = ctx == null ? createRouteContext() : ctx;
  const rule = routeForDir(row, dir, context);
  if (rule == null) return defaultRoute(row);
  const key = routeKeyForDir(dir, context);
  return { ids: rule.tenantIds, reason: { kind: 'rule', index: rule.index, own: sameKey(rule, key), short: shortLabel(rule) } };
}

// Where a running session's analytics go, from the route bound to it; `place` (placeOfDir) tells whether a rule is its own.
export function routeOfSession(row, state, place = null) {
  const resolved = resolveTargets(row, state);
  if (resolved.source === 'rule') {
    const stored = rulesOf(row).find((r) => sameKey(r, resolved.rule));
    return {
      ids: resolved.targets,
      reason: {
        kind: 'rule',
        index: stored == null ? null : stored.index,
        own: place == null ? null : sameKey(resolved.rule, place.key),
        short: shortLabel(resolved.rule),
      },
    };
  }
  return defaultRoute(row);
}

// Where the analytics go, in words: "Acme and Northwind", "not tracked", "no rule yet".
export function routeTarget(row, route) {
  if (route.reason.kind === 'pending') return 'no rule yet';
  if (route.reason.kind === 'unknown') return 'workspaces not known yet';
  return route.ids.length === 0 ? 'not tracked' : joinTenantNames(row, route.ids);
}

// Why: "default", "rule R1", "rule R2 for scratch"; null when there is nothing to name.
export function routeReason(route) {
  const reason = route.reason;
  if (reason.kind === 'default') return 'default';
  if (reason.kind !== 'rule') return null;
  const name = reason.index == null ? 'rule' : `rule R${reason.index}`;
  return reason.own === false ? `${name} for ${reason.short}` : name;
}

// "→ Acme (default)", "→ not tracked (rule R1)", "→ Acme and Northwind (rule R2 for scratch)", "→ no rule yet".
export function routeText(row, route) {
  const why = routeReason(route);
  return `→ ${routeTarget(row, route)}${why == null ? '' : ` (${why})`}`;
}
