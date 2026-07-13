---
name: create-ticket
description: Draft and create a Beezi ticket (Task / Bug / Story). Use when the user wants to create a ticket, draft a ticket, file a bug, or add a task/story to their board (Jira, Azure DevOps) or Beezi. The full drafting workflow is provided by the Beezi MCP server.
---

# Beezi: Create Ticket

This skill is a launcher. The drafting workflow lives on the `beezi` MCP server, so it is always current — do not improvise your own flow.

1. Call the `get_drafting_instructions` tool on the `beezi` MCP server.
2. Follow the returned instructions exactly. They orchestrate the other beezi tools: `resolve_project`, `list_projects`, `get_ticket_template`, `create_ticket`.
3. Never create a ticket before the user has explicitly approved the draft.

If any `beezi` tool fails with an authentication error, stop and tell the user to reconnect the Beezi connector: open **Settings → Connectors → Beezi** and sign in to Beezi again (the connection uses their own Beezi account via OAuth, so they must already be a Beezi user). Do not continue without a working connection.
