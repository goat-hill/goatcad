---
title: Connecting an agent
description: Run Claude Code or Codex inside GoatCAD, or connect one running elsewhere through GoatCAD's local MCP server.
order: 5
---

GoatCAD does not ship a model. It works with the coding agent you already use, Claude Code
or Codex, on your own subscription. The agent talks to the open design through a local
MCP server that GoatCAD runs while it is open.

## Inside GoatCAD

1. Install the agent's CLI:
   [Claude Code](https://code.claude.com/docs/en/quickstart) or
   [Codex](https://learn.chatgpt.com/docs/codex/cli).
2. In **Settings ▸ AI integrations ▸ Agent**, choose Claude Code or Codex.
3. Click the agent button in the activity bar.

The agent opens in a tab, already connected to GoatCAD; there is nothing to configure.
The button resumes the folder's last session when there is one, and each window has one
agent tab.

If the CLI is not installed, the tab says so, links the install page, and works as a plain
shell. Install the CLI, then close the tab and open it again.

## From a terminal outside GoatCAD

**Settings ▸ AI integrations ▸ MCP server** shows the server's address, by default
`http://127.0.0.1:8788/mcp`, and a line to copy for each agent:

- **Claude Code**: a `claude mcp add` command to run once in a terminal.
- **Codex**: a table to add to `~/.codex/config.toml`.

Both carry a token. **Replace token** issues a new one, after which the old lines stop
working and need copying again. The server only listens on your own machine, and only
while GoatCAD is open.

## What the agent can do

The same panel lists the server's tools and prompts. They cover reading and editing
schematics, updating the board from the schematic, symbol and footprint libraries, the
BOM, schematic checks, reading datasheets, and searching parts at DigiKey and Mouser (see
[Part search](/docs/part-search)). In Claude Code they appear as `mcp__goatcad__*`. Type a
prompt as `/mcp__goatcad__<name>`, such as `/mcp__goatcad__init`; the `/` menu lists it as
`/goatcad:<name> (MCP)`.

Edits the agent makes land in the open editor, not straight on disk. Each is undoable,
and nothing is saved until you save.
