---
name: create-ticket
description: Draft and create a Beezi ticket (Task / Bug / Story) from the terminal. Use when the user wants to create a ticket, draft a ticket, file a bug, or add a task/story to their board (Jira, Azure DevOps) or Beezi. The drafting workflow itself is served by the Beezi MCP server.
---

# Beezi: Create Ticket

This skill is a launcher. The drafting workflow lives on the `beezi` MCP server so it stays current — **do not improvise your own flow and do not restate the workflow from memory.**

## Start here

1. Call `get_drafting_instructions` on the `beezi` MCP server.
2. Follow the returned instructions exactly. They orchestrate every other tool.
3. **Never call `create_ticket` until the user has explicitly approved the draft.**

If the user wants to estimate a ticket, check an estimation, answer estimation questions, or start work on an existing ticket, call `get_estimation_instructions` instead — that is a separate workflow with its own rules.

## Tool map

Listed so you know what exists. The instructions you fetch decide when each is called — don't invent a sequence from this table.

| Tool | Purpose |
| --- | --- |
| `get_drafting_instructions` | The drafting workflow. Call first. |
| `get_estimation_instructions` | The estimation / start-work workflow. Call first for those. |
| `list_projects` | Beezi projects the user can create tickets in |
| `resolve_project` | Resolve a project from context, optionally a git remote |
| `list_repositories` | Repositories connected to a chosen project |
| `get_ticket_template` | Enabled fields and generation rules for a project + issue type |
| `create_ticket` | Create the approved ticket |
| `list_directory`, `search_files`, `search_code`, `read_file` | Explore a Beezi-connected repository. These read the repo as Beezi has it connected, which is not necessarily the working tree you are in — prefer your own file tools for the local checkout. |
| `list_my_tickets` | Tickets assigned to the user, by lane |
| `estimate_task`, `get_estimation` | Trigger an estimation and read its result |
| `start_ticket` | Queue a ticket for the Beezi agent |

## When something fails

Stop and tell the user. Do not retry blindly, and do not fall back to writing the ticket yourself — a draft that never reached Beezi is worse than no draft, because the user will assume it was filed.

**No `beezi` tools available at all.** Either the server isn't connected, or ticket drafting is switched off for this Beezi deployment (the server advertises an empty tool list when disabled). Ask the user to run `/mcp` and check that `beezi` is connected. If it is connected and the tools still aren't there, drafting is disabled server-side and only their Beezi admin can turn it on.

**Authentication error.** Tell the user to run `/mcp`, select the `beezi` server, and complete the browser sign-in to re-authenticate. Don't continue without a working connection.

**`feature_disabled`.** Ticket drafting is turned off for this deployment. Nothing the user can fix themselves — their Beezi admin must enable it.

**`invalid_arguments`.** Your call was malformed. Correct the arguments and retry once, then stop.

**Anything else.** Report the message, plus the `correlationId` if the result carries one, and stop.
