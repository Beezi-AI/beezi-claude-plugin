# Beezi plugins for Claude

Official Beezi plugins for Claude — track the cost of AI-assisted work per task and create
tickets on your board without leaving the conversation.

| Plugin | Platform | What you get |
| --- | --- | --- |
| `beezi` | Claude Code (terminal) | Automatic session analytics per Beezi task branch + ticket drafting |
| `beezi-web` | Claude on claude.ai | Ticket drafting |

Both plugins sign in with your own Beezi account — you must already be a Beezi user, and
everything happens as you, on your tenant.

## Claude Code — `beezi`

### 1. Install

```
/plugin marketplace add https://github.com/Beezi-AI/beezi-claude-code
/plugin install beezi@beezi
```

### 2. Link your machine

```
/beezi:login
```

Approve the sign-in in your browser. That's it — from now on, work on Beezi task branches
is tracked automatically; you don't need to run anything else.

### Commands

| Command | Purpose |
| --- | --- |
| `/beezi:login` | Link this machine via browser sign-in; the token is kept in your OS secret store. |
| `/beezi:me` | Show whether this machine is linked, and as whom. |
| `/beezi:logout` | Unlink this machine — revokes its access and removes the stored credentials. |
| `/beezi:track` | Force-save this session's analytics mid-session. |
| `/beezi:refresh` | Re-capture your Claude subscription plan for accurate cost reporting. |

### Ticket drafting

Ask Claude to draft or create a ticket — the bundled `create-ticket` skill connects to the
Beezi server, drafts a ticket grounded in the repo you're working in, and creates it on
your board (Jira / Azure DevOps) or in Beezi once you approve the draft. Ticket drafting
uses the same machine link as analytics — once you've run `/beezi:login`, there is
nothing extra to authorize.

### Optional configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BEEZI_API_URL` | `https://beezi-api-staging.azurewebsites.net/api` | Beezi API base URL. |
| `BEEZI_MCP_URL` | `https://beezi-api-staging.azurewebsites.net/api/mcp` | Beezi server for ticket drafting. |
| `BEEZI_HOME` | `~/.beezi` | Local state root (queue, cursors, credentials). |

## Claude on claude.ai — `beezi-web`

1. Open **Customize → Plugins**.
2. Add this marketplace, then install **beezi-web**.
3. Sign in with your Beezi account when the `beezi` connector asks (it appears under
   **Settings → Connectors**).

Then ask Claude to draft or create a ticket, the same as above.

## Privacy

The analytics plugin reports token counts, tool-call counts, durations, branch and task
ids, the sanitized origin remote, and the session name. Your auth token and the contents
of `~/.claude.json` never leave the machine. Full details, including credential storage
per OS: [`plugins/beezi/README.md`](plugins/beezi/README.md).
