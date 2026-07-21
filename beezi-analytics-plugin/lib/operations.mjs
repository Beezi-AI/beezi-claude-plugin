// Bucket each tool_use in a segment into one of seven operation categories and estimate the
// token cost of its result. The API bills tokens per assistant MESSAGE, not per tool, so a
// tool's real cost — its result text, which lands in the NEXT message's input — is never
// labelled per tool. We approximate it as (matched tool_result payload bytes / 4). Counts are
// exact; est_tokens is an estimate (cache tiering and cross-segment result splits are ignored).
//
// Beyond the flat category counts, two dimensions carry finer identity for the analytics
// donut/breakdowns: mcp keeps a per-server tally (by_server), skill keeps a per-skill tally
// (by_skill), and `plugins` is a cross-cut that re-groups skill/MCP calls by the owning plugin
// (skill-id namespace; MCP has none in the transcript → 'unknown'). Because `plugins` overlaps
// the mcp/skill category buckets it is a separate view, never summed alongside them.

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'ToolSearch']);
const INTERNET_TOOLS = new Set(['WebFetch', 'WebSearch']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const CATEGORIES = ['file', 'search', 'internet', 'mcp', 'shell', 'skill', 'other'];

// Tool name → category. MCP is matched by the mcp__<server>__<tool> prefix first, then the
// Skill tool, then the fixed tool sets; anything else falls through to 'other'.
function categoryOf(name) {
  if (typeof name === 'string' && name.startsWith('mcp__')) return 'mcp';
  if (name === 'Skill') return 'skill';
  if (FILE_TOOLS.has(name)) return 'file';
  if (SEARCH_TOOLS.has(name)) return 'search';
  if (INTERNET_TOOLS.has(name)) return 'internet';
  if (SHELL_TOOLS.has(name)) return 'shell';
  return 'other';
}

// Server segment of an mcp__<server>__<tool> name (substring between the 1st and 2nd '__').
// A blank segment (malformed name) falls back to 'unknown' so subtype tallies stay keyed.
function mcpServer(name) {
  const rest = name.slice('mcp__'.length);
  const i = rest.indexOf('__');
  const server = i === -1 ? rest : rest.slice(0, i);
  return server === '' ? 'unknown' : server;
}

// Plugin that owns a skill id: 'superpowers:tdd' → 'superpowers'. A namespaceless id is a
// built-in Claude Code skill ('builtin'); a missing/blank id is 'unknown'.
function skillPlugin(skillId) {
  if (typeof skillId !== 'string' || skillId === '') return 'unknown';
  const i = skillId.indexOf(':');
  return i === -1 ? 'builtin' : skillId.slice(0, i);
}

// Byte length of a tool_result's content, tolerating both the string and text-block-array forms.
function resultBytes(content) {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf-8');
  if (Array.isArray(content)) {
    let bytes = 0;
    for (const block of content) {
      const text = typeof block?.text === 'string' ? block.text : null;
      bytes += Buffer.byteLength(text ?? JSON.stringify(block ?? ''), 'utf-8');
    }
    return bytes;
  }
  return 0;
}

// Per-category { count, est_tokens } over a segment's transcript lines, plus finer maps
// (mcp.by_server, skill.by_skill) and the `plugins` cross-cut. tool_use blocks live on assistant
// lines; their tool_result (matched by tool_use_id) lands on a later user line within the same
// segment, so a two-pass walk resolves the result size for each call.
export function computeOperations(lines) {
  const bytesById = new Map();
  for (const line of lines) {
    const content = line?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
      bytesById.set(block.tool_use_id, resultBytes(block.content));
    }
  }

  const totals = {};
  for (const cat of CATEGORIES) totals[cat] = { count: 0, est_tokens: 0 };
  totals.mcp.by_server = {};
  totals.skill.by_skill = {};
  const plugins = {};

  const addPlugin = (name, est) => {
    const p = (plugins[name] ??= { count: 0, est_tokens: 0 });
    p.count += 1;
    p.est_tokens += est;
  };

  for (const line of lines) {
    const content = line?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const category = categoryOf(block.name);
      const est = Math.round((bytesById.get(block.id) || 0) / 4);
      const cat = totals[category];
      cat.count += 1;
      cat.est_tokens += est;

      if (category === 'mcp') {
        const server = mcpServer(block.name);
        const s = (cat.by_server[server] ??= { count: 0, est_tokens: 0 });
        s.count += 1;
        s.est_tokens += est;
        addPlugin('unknown', est); // MCP server → plugin is not knowable from the transcript
      } else if (category === 'skill') {
        const skillId = typeof block.input?.skill === 'string' ? block.input.skill : 'unknown';
        const s = (cat.by_skill[skillId] ??= { count: 0, est_tokens: 0 });
        s.count += 1;
        s.est_tokens += est;
        addPlugin(skillPlugin(skillId), est);
      }
    }
  }

  return { ...totals, plugins };
}
