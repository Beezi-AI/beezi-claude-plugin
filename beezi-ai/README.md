# Beezi plugin for Claude (claude.ai)

Draft and create Beezi tickets inside Claude. The plugin connects Claude to the Beezi MCP server: it fetches your project's ticket template, drafts every field, asks clarifying questions when the request is unclear, and — after you approve the draft — creates the ticket on your board (Jira / Azure DevOps) or in Beezi.

Authentication is **OAuth**: on first use Claude opens a **"Sign in with Beezi"** window, and every ticket you create is created as **you**, on your own tenant. You must already be a Beezi user.

## Install

1. In Claude, open **Customize → Plugins → Add marketplace** and add this repository's URL.
2. Install the **beezi-ai** plugin.
3. Ask naturally ("file a bug: the sync worker retries too aggressively on 429s") or run the skill directly. On first use, complete the **Sign in with Beezi** consent. The `beezi` connector then appears under **Settings → Connectors**.

## Quick test without installing the plugin

Add the MCP server as a **custom connector** instead: **Settings → Connectors → Add custom connector**, URL:

```
<your Beezi API base>/api/mcp/sse
```

Complete the OAuth consent, then use the `create-ticket` skill (upload it under **Settings → Capabilities → Skills**).

## Configuration

The connector URL lives in `.mcp.json`. It points at the stateful MCP endpoint (`/api/mcp/sse`) so the interactive project / board / assignee pickers render in Claude. Point it at your production Beezi API for distribution.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `get_drafting_instructions` | The complete drafting workflow — always fetched fresh from Beezi |
| `list_projects` | Projects your account can create tickets in |
| `resolve_project` | Match context to a Beezi project |
| `get_ticket_template` | Enabled ticket fields + generation rules for a project/issue type |
| `create_ticket` | Create the validated ticket on the board or in Beezi |

The plugin is a thin launcher: the drafting methodology, question flow, and field rules are served by the Beezi MCP server at call time, so updates ship server-side with no plugin reinstall.
