# The standard agent run

Given verbatim to a fresh agent session in an empty project folder, with the GoatCAD MCP server
connected. It goes from a product brief to a board ready for fab export with no follow-up from
the person, so the run measures the op surface rather than the conversation.

**Setup.** Each attempt gets its own folder beside the earlier ones (`phone-omenal/v1`, `v2`, …),
and the prompt's last line keeps the agent out of them. Record the GoatCAD version and commit in
the run file. The agent writes its feedback to `goatcad-feedback-run-NN.md` in the project folder (a new
file each run); the run file triages it ([the loop](./README.md#the-loop)).

```text
/mcp__goatcad__init Designing a VoIP device for connecting a landline. The idea is kids can use retro landline phones and call friends. It exposes a phone jack and connects to your Wi-Fi at home. An external power supply powers it.

PCBA device, ideally manufactured by CircuitHub. 5x initial prototype run.

Unclear which VoIP service we will use, but it should be reliable for calls in the USA. We may add features that limit calling to approved friends only.

Phone calls should be low latency with decent call quality. The device should be pretty low maintenance from a firmware-update perspective.

--

Goal of this exercise is to test abilities of GoatCAD https://goatcad.com. It is in-development PCB software designed for agentic and human use. Collect feedback on bugs or modificaitons that would enable the agent to design a board more effecitvely or efficiently. Complete the entire process from part selection to PCB design ready for export. I don't care about specific details so no need to ask follow up questions unless there is an issue.

DO NOT LOOK AT NEIGHBORING DIRECTORIES those are previous attempts and this one should be independent.
```

`/mcp__goatcad__init` runs the GoatCAD MCP server's `init` prompt (`main/partsMcpPrompts.ts`).
Claude Code's `/` menu lists it as `/goatcad:init (MCP)`, but the form you type is
`/mcp__<server>__<prompt>` ([Claude Code docs](https://code.claude.com/docs/en/mcp), "Use MCP prompts
as commands"). Claude Code splits the rest of the line on spaces, so the prompt's `about` argument
gets only the first word. The prompt reads the whole brief from the typed message instead. Run 11
was given the `/goatcad:init` spelling; when the agent later read `project.context`'s offer to
run `/goatcad:init`, it looked for a skill of that name and found none.
