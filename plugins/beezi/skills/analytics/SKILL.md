---
name: analytics
description: Show a short personal Beezi analytics summary (spend, sessions, status, recommendations) for the last 7 or 30 days. Use when the user asks for their Beezi analytics, usage summary, or spend summary from the terminal.
argument-hint: "7d | 30d [workspace]"
---

# Beezi: Personal Analytics Summary

This skill is a launcher. The summary workflow lives on the `beezi` MCP server so it stays current — **do not improvise your own flow and do not restate the workflow from memory.**

1. Parse the user's argument: `7d` or `30d` is the period (none → `7d`); any other words name a workspace.
2. Only when a workspace is named, run EXACTLY `node ${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs read "<workspace>"` and write its first line verbatim (an error line too; on an error, stop there).
3. Call the `get_analytics_instructions` tool on the `beezi` MCP server.
4. Follow the returned instructions exactly, passing the period from step 1.

In the summary, mention the workspace named by the tool's `Beezi: reading from …` line (only an account in several workspaces gets one).

If the MCP server is not connected or authentication fails, reply exactly: `Sign in to Beezi first.`
