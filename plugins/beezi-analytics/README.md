# Beezi analytics for Claude Code

This plugin shows your own Beezi usage analytics inside Claude Code: spend, sessions, top model, a status and up to three recommendations, for the last 7 or 30 days. It is read-only. It records nothing and changes nothing in Beezi.

## Requirements

A Beezi account. The plugin signs in as you, and the summary covers your default Beezi workspace.

## Install

From Beezi's marketplace:

```
/plugin marketplace add Beezi-AI/beezi-claude-plugin
/plugin install beezi-analytics@beezi
```

## Sign in

Run `/mcp`, choose the `beezi` server, then Authenticate. A browser window opens for your Beezi sign-in. Until you have signed in, the summary replies with the same instruction.

## Usage

```
/beezi-analytics:analytics 7d
/beezi-analytics:analytics 30d
/beezi-analytics:about
```

`analytics` prints the summary for the period you give; with no period it uses 7 days. `about` explains what the plugin does and where the numbers come from.

## What it connects to

The plugin declares one MCP server, `beezi`, at `https://api.beezi.ai/api/mcp`. Its requests carry the header `X-Beezi-Plugin: light`, so Beezi offers it only your personal summary. Sign-in goes through `https://clerk.beezi.ai`. The plugin has no hooks, scripts, commands or local code, and it uploads no conversation transcripts; only that header and the arguments of the tools Claude calls reach Beezi. It can read only your personal summary; questions about other people are declined.

## The full Beezi plugin

Sessions come from the full Beezi plugin, which records Claude Code usage and is installed from the Beezi portal. It includes this summary, so install one or the other.

## Links

- Documentation: https://docs.beezi.ai/coding-tool/beezi-analytics-plugin
- Privacy policy: https://beezi.ai/privacy-policy
- Terms: https://beezi.ai/terms-and-conditions
- Support: https://beezi.ai/contact-us

## License

Apache License 2.0. See `LICENSE`.
