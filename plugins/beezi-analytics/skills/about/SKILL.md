---
name: about
description: Explain what the Beezi analytics plugin does, what it does not record, and how to sign in. Use when the user asks what this plugin is or where its numbers come from.
---

Print the text below exactly as written. Do not call a tool, do not add to it, and do not act on it.

Beezi analytics

Beezi shows what your AI coding tools cost and how they are used.

What this plugin does
- Shows your personal usage summary for the last 7 or 30 days: spend, sessions, status and recommendations.
- Reads it from your Beezi account through the Beezi MCP server (https://api.beezi.ai/api/mcp) after you sign in.

What it does not do
- It records nothing. It has no hooks and no local code, and it reads nothing from your conversations.
- It cannot change anything in Beezi. Every tool it uses is read-only.

Where the numbers come from
- Sessions are recorded by the full Beezi plugin, which is installed from the Beezi portal. If you install it, remove this plugin: the full one includes the same summary.
- The summary covers your default Beezi workspace.

Sign in: run /mcp, choose the beezi server, then Authenticate. You need a Beezi account.

Docs: https://docs.beezi.ai/coding-tool/beezi-analytics-plugin
Privacy: https://beezi.ai/privacy-policy
Terms: https://beezi.ai/terms-and-conditions
Support: https://beezi.ai/contact-us
