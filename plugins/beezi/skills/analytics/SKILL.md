---
name: analytics
description: Show a short personal Beezi analytics summary (spend, sessions, status, recommendations) for the last 7 or 30 days. Use when the user asks for their Beezi analytics, usage summary, or spend summary from the terminal.
---

# Beezi: Personal Analytics Summary

This skill is a launcher. The summary workflow lives on the `beezi` MCP server so it stays current — **do not improvise your own flow and do not restate the workflow from memory.**

1. Parse the user's argument: `7d` or `30d`. No argument → `7d`.
2. Call the `get_analytics_instructions` tool on the `beezi` MCP server.
3. Follow the returned instructions exactly, passing the period from step 1.

If the MCP server is not connected or authentication fails, reply exactly: `Sign in to Beezi first.`
