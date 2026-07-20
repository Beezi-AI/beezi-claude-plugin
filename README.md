# Beezi plugins for Claude

A plugin marketplace with two plugins, one per platform. Both connect Claude to the Beezi MCP server to draft tickets and create them on your board (Jira / Azure DevOps) or in Beezi.

| Plugin | Platform | Install |
| --- | --- | --- |
| [`beezi-code`](plugins/beezi-code) | Claude Code (terminal) | `/plugin install beezi-code@beezi` |
| [`beezi-web`](plugins/beezi-web) | Claude on claude.ai | **Customize → Plugins**, then install **beezi-web** |

Add the marketplace first:

```
/plugin marketplace add <org>/beezi-claude-plugins
```

Both authenticate with **OAuth** against your own Beezi account — tickets are created as you, on your tenant. You must already be a Beezi user.

## Layout

```
.claude-plugin/marketplace.json   both plugins are listed here
plugins/beezi-code/               Claude Code plugin
plugins/beezi-web/                claude.ai plugin
scripts/                          GitHub mirror scripts
azure-pipelines-github-sync.yml   release pipeline
```

Each plugin is self-contained — its own `.claude-plugin/plugin.json`, `.mcp.json`, `skills/`, and README. The two `create-ticket` skills are deliberately near-identical copies rather than a shared file: a plugin has to stand alone once installed, and the remediation steps differ per platform (`/mcp` vs **Settings → Connectors**).

The plugins are thin launchers. The drafting methodology, question flow, and field rules are served by the Beezi MCP server at call time via `get_drafting_instructions`, so updates ship server-side with no plugin reinstall — and any other MCP client gets the identical workflow from the same endpoint.

## Branches

`dev` is the integration branch; `main` is prod. Merging a release PR into `main` triggers `azure-pipelines-github-sync.yml`, which mirrors `main` to the public GitHub repo that users add with `/plugin marketplace add`.

## Releasing

The mirror refuses to publish while any `.mcp.json` points at a dev tunnel or localhost, because the GitHub repo is public and the URL would persist in the commit log. Point the connector at the production Beezi API before releasing, or set `ALLOW_NON_PROD=true` to override deliberately.

To run the mirror by hand:

```bash
GITHUB_PAT=... GITHUB_REPO=owner/name DRY_RUN=true scripts/sync-to-github.sh
```

```powershell
./scripts/sync-to-github.ps1 -GithubRepo owner/name -DryRun
```
