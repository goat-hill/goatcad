# Agent runs

One file per real design run over MCP, named `YYYY-MM-DD-run-NN-<project>.md`: what was asked,
what came back, and what each finding becomes. The rules a verdict is held to are
[agent-api.md](../agent-api.md) ("How the API is designed") and the
milestone's scope ([MILESTONES.md](../MILESTONES.md)). A finding the rules turn down is recorded
with the reason, so the next run that hits it does not argue it again. Accepted items go to the
doc that owns their area (a workstream, MILESTONES.md or BACKLOG.md); the run file keeps the
evidence.

The standard run is [PROMPT.md](./PROMPT.md), given verbatim to a fresh agent. A run file records
the GoatCAD version and commit it ran against (≈ when only the date is known: the last tag
before the run), because findings go stale as the ops change: before
acting on an old run's verdict, check it against the code.

**Verdicts:** **bug** (breaks a stated rule), **open** (worth building; goes to the doc that owns it),
**check** (not reproduced yet), **fixed** (since the run, with where), **declined** (with the
rule), **out of alpha**, **not ours**.

## The loop

Every run is triaged the same way.

1. **Run.** Use [PROMPT.md](./PROMPT.md) or an ad hoc ask, in a project folder of the run's own.
   The agent writes its report to `goatcad-feedback-run-NN.md`, a new file each run, so no
   earlier report is overwritten.
2. **Add the person's own review.** It covers what the agent can't judge about its own work: how
   the sheets and board look, and what it skipped. Keep it apart from the agent's report (the
   agent's file has a section for it), because the two are triaged differently (step 4).
3. **Verify against the code.** Check each finding at the current commit, one reader per area
   (routing, reads and ids, checks, rendering, schematic), and record `file:line`.
4. **Triage the two sources differently.**
   <br>• **The person's requests are the spec.** Build what the person asked for. Raise a concern
   only when there is something they need to know for a sound technical decision: a conflict with
   KiCad or the GUI, a cost or risk they may not see, or a code fact that changes the picture.
   State it on the card and still propose their change, unless they decide otherwise. Don't
   swap in a cleverer alternative, and don't re-argue a request against the rules below.
   <br>• **The agent's asks get product skepticism.** The report is GoatCAD's self-evaluation. An
   ask is evidence of a need, not a design. The solution comes from agent-api.md's rules:
   <br>• deterministic, no heuristics;
   <br>• records first;
   <br>• facts, not judgments;
   <br>• parity with the GUI and KiCad;
   <br>• answers sized for context.
   <br>An agent ask the rules turn down is recorded with the rule.
5. **Write the run file** and its row below. Accepted items go to the doc that owns their area.
6. **Review.** Publish a page of issues, each with its proposed solution and risk. The person
   decides each one. Each card says whose item it is: "You asked" cards propose the person's
   change as asked, with any concern beside it, and "The agent asked" cards propose what the
   rules support. Write each card in plain terms, with what a reader needs to follow it, and
   put file and op names under a collapsed technical note. Each card offers:
   <br>• **Approve**, as proposed;
   <br>• **Approve with changes**, with a required note;
   <br>• **Decline**, with a required reason;
   <br>• **Defer**;
   <br>• **Discuss**, a question back before deciding.
   <br>The decisions must reach the session on their own. Store them with the page's shared
   database, not the browser, so they can be read back without the person pasting anything.
   The page says when they have been sent.
7. **Build** what was approved. Record what landed under the run's "Since the run", and re-check
   the earlier runs' open verdicts on the next run.

## Runs

| Run | Date | GoatCAD | Project | Prompt | Reached |
|-----|------|---------|---------|--------|---------|
| 1–9 | 2026-09-07 to 09-21 | ≤ v0.1.5 | schematic capture, then the first board syncs | ad hoc | `git show 59a446e^:.agents/agent-api-field-notes.md` §15–§23 |
| 10–14 | 2026-09-28 to 10-09 | ≈ v0.1.11 to `goatherd-dev` ≈ `04cba626` | `medium-complex`, then `phone-omenal/v2` | PROMPT.md (11), else ad hoc | `git show b188021d:docs/agent-runs/` (the run files) |
| [15](./2026-10-09-run-15-phone-omenal-v2-redesign-again.md) | 2026-10-09 | `goatherd-dev` ≈ `ac1c1052` | `phone-omenal/v2`, PCB redesigned again from the schematic, with a time-lapse | ad hoc | routed, DRC errors in a stock footprint only |
