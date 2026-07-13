# Beezi plugin for Claude Code

Draft and create Beezi tickets from your terminal. The plugin connects Claude Code to the Beezi MCP server: it fetches your project's ticket template, drafts every field grounded in the repository you're working in, asks clarifying questions when the request is unclear, and - after you approve the draft - creates the ticket on your board (Jira / Azure DevOps) or in Beezi.

## Installation

1. Add the marketplace and install the plugin:

   ```
   /plugin marketplace add <org>/beezi-claude-plugin
   /plugin install beezi@beezi
   ```

2. Create a Personal Access Token in **Beezi → Settings → Personal Access Tokens** and export it:

   ```bash
   export BEEZI_PAT="bzi_..."
   ```

   Add the export to your shell profile so it survives new terminals.

3. Restart Claude Code. Check the connection with `/mcp` - the `beezi` server should be connected.

To point the plugin at a non-production Beezi instance, set `BEEZI_MCP_URL` (defaults to the production API):

```bash
export BEEZI_MCP_URL="http://localhost:5001/api/mcp"
```

## Usage

Ask naturally, or invoke the skill directly:

```
/beezi:create-ticket the retry logic in the sync worker gives up too early on 429s
```

Claude resolves the Beezi project from your git remote, explores the repo, asks questions only when something is genuinely unclear, shows you the full draft for validation, and creates the ticket where you choose.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `get_drafting_instructions` | The complete drafting workflow — always fetched fresh from Beezi |
| `list_projects` | Projects your token can create tickets in |
| `resolve_project` | Match a git remote URL to a Beezi project |
| `get_ticket_template` | Enabled ticket fields + generation rules for a project/issue type |
| `create_ticket` | Create the validated ticket on the board or in Beezi |

The plugin itself is a thin launcher: the drafting methodology, question flow and field rules are served by the Beezi MCP server at call time. Updates ship server-side — no plugin reinstall — and any other MCP client (Cursor, VS Code, Codex, ChatGPT) gets the identical workflow by connecting to the same endpoint.
