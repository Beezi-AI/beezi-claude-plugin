// The startup card: Beezi's sign-in and where this folder's sessions go, drawn in the band above the prompt.
import { LOGO_LINES, changeTarget, dotColor, optionsFor, placeLine, placeText, question, updateSteps, updateText, versionText } from '../lib/card-view.mjs';
import { finishingText, isFinishing, spinnerFrame } from '../lib/upload-phase.mjs';

const VIOLET = '#8F75F8';
const CARD = { mode: 'card', account: null };
const STRIP = { mode: 'strip', account: null };
const UPDATE = { mode: 'update', account: null };
// Surfaces that draw the card; scripts and hooks see BEEZI_CARD only there.
const CARD_SURFACES = ['terminal', 'desktop', 'mobile'];
const POLL_MS = 1000;
// Mirrors isLive's limit in lib/upload-progress.mjs, which needs Node and so can't load here.
const STALE_MS = 120_000;

// Module variables, not $.state: variants rename the plugin, and state refs must name it literally.
let facts = null;
let view = CARD;
let markSvg = null;
// Finished uploads stay listed for the session after card.mjs stops listing them.
let uploads = [];
let poller = null;
// Advances on each poll, so the finishing row's spinner moves.
let tick = 0;
// The folder the card loads for; null where no card draws.
let cardCwd = null;

// A $ method an older engine lacks (the desktop app's has no process.hookEnv) gives the fallback instead of throwing.
async function guard(call, fallback) {
  try {
    return await call();
  } catch {
    return fallback;
  }
}

function redraw($) {
  return guard(() => $.ui.invalidate('ui.render'));
}

function parseFacts(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstLine(text) {
  const line = (text || '').split('\n').map((one) => one.trim()).find((one) => one !== '');
  return line == null ? null : line.replace(/^✗\s*/, '');
}

async function runNode($, cwd, argv) {
  const env = (await guard(() => $.process.hookEnv(), null))
    || (await guard(async () => ({ CLAUDE_CODE_SESSION_ID: await $.session.id() }), {}));
  return $.process.run(['node', ...argv], { cwd, env, timeoutMs: 30_000 });
}

async function loadFacts($, cwd) {
  if (markSvg == null) markSvg = await guard(() => $.fs.read(`${$.plugin.root}/assets/beezi_mark.svg`), null);
  const ran = await guard(() => runNode($, cwd, [`${$.plugin.root}/scripts/card.mjs`]), null);
  const loaded = ran != null && ran.exitCode === 0 ? parseFacts(ran.stdout) : null;
  if (loaded == null) {
    const why = ran == null ? 'node did not run' : ran.stderr || `exit ${ran.exitCode}`;
    await guard(() => $.ui.log(`beezi card: scripts/card.mjs gave no card: ${why}`, { to: 'debug' }));
  }
  facts = loaded == null ? null : { ...loaded, cwd };
  if (loaded != null) await takeUploads($, cwd, loaded.uploads || []);
  await redraw($);
}

async function takeUploads($, cwd, loaded) {
  const paths = loaded.map((upload) => upload.path);
  uploads = [...uploads.filter((upload) => upload.finished && !paths.includes(upload.path)), ...loaded];
  for (const upload of loaded) {
    if (upload.finished) await guard(() => runNode($, cwd, [`${$.plugin.root}/scripts/card.mjs`, '--reported', upload.key, upload.tenantId]), null);
  }
  if (poller == null && uploads.some((upload) => !upload.finished)) {
    poller = await guard(() => $.clock.every(POLL_MS, () => void guard(() => poll($))), null);
  }
}

function isStale(record, nowMs) {
  return record.finishedAt == null && nowMs - Date.parse(record.updatedAt) > STALE_MS;
}

// Re-reads each running upload's record; a finished one reloads the facts for its done line.
async function poll($) {
  tick += 1;
  const nowMs = await $.clock.now();
  const next = [];
  let finished = false;
  for (const upload of uploads) {
    if (upload.finished) {
      next.push(upload);
      continue;
    }
    const record = parseFacts(await guard(() => $.fs.read(upload.path), null));
    if (record == null || isStale(record, nowMs)) continue;
    finished = finished || record.finishedAt != null;
    next.push({ ...upload, processed: record.processed, total: record.total, sent: record.sent });
  }
  uploads = next;
  if (!uploads.some((upload) => !upload.finished) || finished) stopPolling();
  if (finished) await loadFacts($, facts.cwd);
  else await redraw($);
}

function stopPolling() {
  if (poller != null) poller.cancel();
  poller = null;
}

// A desktop spare session starts with no surface and draws the card once it attaches.
function drawsCard(surface) {
  return surface == null || CARD_SURFACES.includes(surface);
}

// An upload started after the card loaded (a worker, "Upload now") gets its row on the next prompt or turn end.
function reloadForUploads($) {
  if (cardCwd != null && poller == null) void loadFacts($, cardCwd);
}

async function flagCard($, surface) {
  if (CARD_SURFACES.includes(surface)) await guard(async () => $.env.set('BEEZI_CARD', await $.session.id()));
}

function uploadRows({ Box, Text, Progress }) {
  return uploads.map((upload) => {
    if (upload.finished) return <Text>{upload.line}</Text>;
    if (isFinishing(upload)) {
      return (
        <Box gap={1}>
          <Text color={VIOLET}>↑</Text>
          <Text>{`${spinnerFrame(tick)} ${finishingText(upload.workspace)}`}</Text>
        </Box>
      );
    }
    return (
      <Box gap={1}>
        <Text color={VIOLET}>↑</Text>
        {Progress != null ? (
          <Progress
            label={`Uploading past sessions to ${upload.workspace}`}
            value={upload.processed}
            max={upload.total}
            valueText={`${upload.processed}/${upload.total}`}
          />
        ) : (
          <Text>{`Uploading past sessions to ${upload.workspace}  ${upload.processed}/${upload.total}`}</Text>
        )}
      </Box>
    );
  });
}

async function save($, option) {
  if (facts == null) return;
  const cwd = facts.cwd;
  const ran = await guard(() => runNode($, cwd, [`${$.plugin.root}/scripts/workspace.mjs`, ...option.argv]), null);
  if (ran == null || ran.exitCode !== 0) {
    const why = firstLine(ran && ran.stderr) || firstLine(ran && ran.stdout) || 'The command did not run.';
    await guard(() => $.ui.toast(`Beezi: couldn't save. ${why}`));
    return;
  }
  view = CARD;
  await loadFacts($, cwd);
  await guard(() => $.ui.toast(`Beezi: ${option.done}. Undo with /beezi:settings undo`));
}

function show($, next) {
  view = next;
  return redraw($);
}

export const register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e);
    view = CARD;
    uploads = [];
    tick = 0;
    stopPolling();
    cardCwd = null;
    if (e.isInteractive) {
      await flagCard($, e.surface);
      if (drawsCard(e.surface)) {
        cardCwd = e.cwd;
        void loadFacts($, e.cwd);
      }
    }
    return started;
  });

  // The desktop app starts a spare session before it knows the folder, then attaches it to the real one.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e);
    await flagCard($, e.surface);
    cardCwd = drawsCard(e.surface) ? await guard(() => $.session.cwd(), null) : null;
    if (cardCwd != null) void loadFacts($, cardCwd);
    return attached;
  });

  on('prompt.submit', async ($, e, next) => {
    if (view.mode !== 'strip') await show($, STRIP);
    reloadForUploads($);
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const done = await next(e);
    if (e.agentId == null) reloadForUploads($);
    return done;
  });

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.props.hasSurvey || facts == null) return next(e);
    const { Box, Text, Button, Svg, Progress } = $.ui.resolve(e);
    const rows = uploadRows({ Box, Text, Progress });
    const isTerminal = e.surface === 'terminal';
    const where = placeText(facts);
    let logo = null;
    if (isTerminal) {
      logo = (
        <Box flexDirection="column">
          {LOGO_LINES.map((line) => <Text color={VIOLET}>{line}</Text>)}
        </Box>
      );
    } else if (markSvg != null) {
      logo = <Svg source={markSvg} alt="Beezi" width={26} height={30} />;
    }

    if (view.mode === 'strip') {
      return (
        <Box flexDirection="column">
          <Box gap={1}>
            {facts.accounts.map((a) => (
              <Box gap={1}>
                <Text color={dotColor(a)}>●</Text>
                <Text dimColor>Beezi {facts.accounts.length > 1 ? `${a.label} ` : ''}→ {a.route.target}</Text>
                {a.anonymized && <Text dimColor>· anonymized</Text>}
              </Box>
            ))}
            <Button key="open" label="details" hotkey="b" plain dimColor onPress={() => show($, CARD)} />
          </Box>
          {rows}
        </Box>
      );
    }

    const picking = view.mode === 'pick' ? facts.accounts.find((a) => a.key === view.account) : undefined;
    if (picking != null) {
      const options = optionsFor(facts, picking);
      const asking = picking.route.kind === 'pending';
      const line = placeLine(facts);
      return (
        <Box borderStyle="round" borderColor={VIOLET} paddingX={1} gap={2}>
          {logo}
          <Box flexDirection="column">
            <Box gap={1}>
              <Text weight="bold" color={VIOLET}>Beezi</Text>
              <Text>{question(facts, asking)}</Text>
            </Box>
            {line != null && <Text dimColor>{line}</Text>}
            <Box gap={1}>
              <Text dimColor>Now</Text>
              <Text color={dotColor(picking)}>●</Text>
              <Text>→ {picking.route.target}</Text>
              {picking.route.reason != null && <Text dimColor>({picking.route.reason})</Text>}
              <Text dimColor>· {picking.label}</Text>
            </Box>
            <Box flexDirection="column" marginTop={1}>
              {options.map((option, i) => (
                <Box gap={2}>
                  <Button
                    key={`pick-${i}`}
                    label={option.isCurrent ? `${option.label} ✓` : option.label}
                    {...(i < 9 ? { hotkey: String(i + 1) } : {})}
                    plain
                    onPress={() => save($, option)}
                  />
                  {option.hint !== '' && <Text dimColor>{option.hint}</Text>}
                </Box>
              ))}
              <Box gap={2}>
                <Button key="later" label={asking ? 'Later' : 'Cancel'} hotkey="l" plain dimColor onPress={() => show($, CARD)} />
                {isTerminal && <Text dimColor>Press a number while the prompt is empty</Text>}
              </Box>
            </Box>
          </Box>
        </Box>
      );
    }

    if (view.mode === 'update' && facts.update != null) {
      return (
        <Box borderStyle="round" borderColor={VIOLET} paddingX={1} gap={2}>
          {logo}
          <Box flexDirection="column">
            <Box gap={1}>
              <Text weight="bold" color={VIOLET}>Beezi</Text>
              <Text>Update Beezi {versionText(facts)} → v{facts.update.latest}</Text>
            </Box>
            {updateSteps(facts).map((step) => <Text>{step}</Text>)}
            <Box marginTop={1}>
              <Button key="back" label="Back" hotkey="l" plain dimColor onPress={() => show($, CARD)} />
            </Box>
          </Box>
        </Box>
      );
    }

    const target = changeTarget(facts);
    const single = facts.accounts.length === 1 ? facts.accounts[0] : null;
    const version = versionText(facts);
    const update = updateText(facts);
    return (
      <Box borderStyle="round" borderColor={VIOLET} paddingX={1} gap={2}>
        {logo}
        <Box flexDirection="column">
          <Box gap={2}>
            <Text weight="bold" color={VIOLET}>Beezi</Text>
            <Text dimColor>{single != null ? single.label : `${facts.accounts.length} accounts`}</Text>
            {version != null && <Text dimColor>{version}</Text>}
            {update != null && <Text color="warning">· {update}</Text>}
          </Box>
          {facts.accounts.map((a) => (
            <Box gap={1}>
              <Text color={dotColor(a)}>●</Text>
              <Text>{single != null ? where : a.label} → {a.route.target}</Text>
              {a.route.reason != null && <Text dimColor>({a.route.reason})</Text>}
              {a.note != null && <Text color="warning">· {a.note}</Text>}
              {a.anonymized && <Text dimColor>· anonymized</Text>}
            </Box>
          ))}
          {rows}
          <Box gap={2}>
            {target != null && (
              <Button
                key="change"
                label={target.route.kind === 'pending' ? 'Choose where this goes' : 'Change where this goes'}
                hotkey="1"
                plain
                onPress={() => show($, { mode: 'pick', account: target.key })}
              />
            )}
            <Button key="hide" label="Hide" hotkey="2" plain dimColor onPress={() => show($, STRIP)} />
            {update != null && <Button key="update" label="How to update" hotkey="3" plain onPress={() => show($, UPDATE)} />}
          </Box>
        </Box>
      </Box>
    );
  });
};
