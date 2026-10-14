# Interactive router: behavior

How the board's interactive router behaves: routing a track, dragging one, and what happens to
other copper in the way. It is the specification the engine (`lib/board/router/`) and the route
tool's state machine (`lib/board/routeController.ts`, which the editor and an agent's routing
session share) are built and tested against. Each numbered case says what the person sees, and the tests in
`lib/board/router/__tests__/` cite the cases they check. Where the engine does not do a case yet,
**Status** at the end says so.

KiCad's router is the spec: it is battle-tested, so a case does what KiCad does unless ours is
clearly better — it adds what KiCad lacks without changing what KiCad does, or it gives the same
answer on every machine where KiCad's does not. A preference is not enough. Every such case says
so in a **Differs from KiCad:** note — what KiCad does, and why ours is better — so anything not
marked follows KiCad, and a mismatch found there is a bug. Cases KiCad has no counterpart for are ours and say so. KiCad's source is read as a reference
for its behavior, never copied (RULES.md §7).

## What good routing means

In order of how much each one decides the feel:

1. **Follows the cursor.** The head reaches the cursor by the shortest clean way there is, as
   KiCad's does.
2. **Stable.** A small mouse movement gives a small change, except where the other way round
   becomes the shorter. The same input always gives the same result.
3. **Legal.** The router never commits copper that breaks clearance, except in Highlight with
   *Allow DRC violations* on.
4. **Clean.** Few, gentle corners, then short; at clearance where it touches what it passes, no
   leftover or looping copper.
5. **Leaves work alone.** Pushed or dragged copper moves only where and as far as it has to.
6. **Fast.** Every mouse move is answered before the next frame, on a dense board.
7. **Explains itself.** When the route stops, bends or turns red, the reason is visible.

## Terms

- **Head**: the part of the route that follows the cursor, from the last click to the cursor.
- **Tail**: the committed clicks of the route in progress. They are not on the board until the
  route finishes.
- **Pin**: a point a gesture must not move: the start of a route, a click, a pad a track ends on, a
  via, the far ends of a dragged span.
- **Obstacle**: copper of another net on the routed layer, anything drilled (holes, vias,
  through-hole pads) on any layer, the board edge, and keepouts that forbid tracks. Copper of the
  routed net is never an obstacle.
- **Clearance**: what the rules resolver gives for this net against that item. The same value DRC
  checks.
- **Side**: which way round an obstacle the route passes, left or right.
- **Corner mode**: 45° (the default), rounded 45°, 90° or rounded 90°; a route is free angle
  only in Highlight with *Free angle mode* on (R3).

## Collision modes

The mode says what happens to *other* copper. It is a user preference, shared by routing and
dragging, picked from the router pill's menu, and cycled with `Alt+R`. KiCad's three modes, Avoid
(its Walkaround) the default; a stored choice is kept. **Differs from KiCad:** KiCad binds no key
to the mode; `Alt+R` is ours, since a drag reads the mode too and the pill is not always in reach.

| Mode | Other copper | When the head meets an obstacle |
|---|---|---|
| **Push** | tracks and vias move aside | the head pushes it; what cannot move, the head goes round |
| **Avoid** (default) | never moves | the head goes round it, hugging it |
| **Highlight** | never moves | the head goes straight through, ending on the obstacle's clearance outline when the cursor is within half a track width of it (in 90° mode, of its bounding box), as KiCad's mark-obstacles mode snaps; the violation is marked, and a click on it is refused |

Highlight's own settings sit under it in the menu, as KiCad's dialog enables them only there:
*Allow DRC violations* (off) makes a click commit the violating copper, and *Free angle mode*
(off) draws the head free angle (R3). Highlight with violations allowed is the only state that can
put a clearance error on the board, so the router pill turns gold in it alone. Push and Avoid
propose no violating copper to begin with (R14).

There is no hidden fallback between modes. Push never quietly becomes Avoid for the whole
route because one push failed (see P5).

## Routing

### Starting

- **R1.** A route starts on a pad, via or track end, and takes that item's net. Started on a
  track, it takes the track's width while *Use starting track width* is on (the size list's first
  row, S6; on, as KiCad's `board.auto_track_width` defaults); started on a pad or via, the width
  of a track leaving it — on the start layer, the one whose far end is nearest the pointer, else
  the narrowest — and with none, the size in force (S1). A width picked mid-route leaves it (S5).
  The switch is kept per project, in the `.kicad_prl`, as KiCad keeps it. Started on copper that is not on the active layer — a track
  on another layer, an SMD pad on the other side — it switches to that copper's layer; a through
  pad or via already on the active layer keeps it. The switch lasts the route, as a via's does
  (R24). Started in empty space, it has no net and every other net's copper is an obstacle; in
  Highlight it may then end on copper of any net, and takes that net. Started on the
  middle of a track, the track is split there, so the junction is a real end of both (R32).
- **R2.** A route may start inside another net's clearance area (fine-pitch pads can be closer
  than clearance plus half the track width). The head may leave that area by the shortest way out
  without being blocked. It is marked as a violation only if the copper it commits actually
  violates. The pass lasts only the way out: once the head has left that area, what it started in
  is an obstacle like any other, and a head that would leave through its copper leaves by the
  shortest way out instead. In Push, what the head starts beside and can move is pushed, not
  passed. **Differs from KiCad:** KiCad has no such pass — a head starting inside another net's
  clearance cannot walk out, and the start blocks the commit; fine-pitch pads make that start
  common, and the pass costs nothing once the head is out.

### Following the cursor

- **R3.** With nothing in the way, the head is a single bend from the tail to the cursor in the
  corner mode: one or two segments at 0°, 45° or 90° in 45° mode, only 0° and 90° in 90° mode,
  and one straight segment in Highlight with *Free angle mode* on, whatever the corner mode (KiCad
  reads it in no other mode, nor in a drag). The rounded modes (KiCad's Arc 45 and Arc 90) draw the
  same bend with its corner a tangent arc as large as its legs allow — a leg between two corners
  shared between them — so the bend from the tail is a straight run and one arc; walked or pushed,
  every corner of the head is rounded so. An arc that would break clearance is tried smaller,
  else the corner stays sharp, and the corner a pad exit makes (R38) is never rounded. `Ctrl+/`
  steps 45°, rounded 45°, 90°, rounded 90° (KiCad's Track Corner Mode Switch), a user preference
  kept as KiCad keeps it; a rounded corner lands as a track arc. `Shift+Space` is the graphics
  tools' line mode, apart from it, as KiCad's.
- **R4. Posture.** In 45° mode, whether the diagonal comes first or last follows the way the mouse
  went from the last click: of the two bends, the one its trail has kept nearer. A first wobble
  does not decide it; once the cursor is well clear of the click the posture holds, and it is read
  afresh if the cursor comes back. `/` flips it, and the flip holds until the next click. Leaving
  a click, the head carries straight on where one posture lets it, and where the mouse's posture
  would turn a right angle or sharper and the other turns less, the other is taken (KiCad's
  mouse-trail posture).
- **R5.** The head ends at the cursor whenever the cursor is somewhere the track may legally be.
  In Highlight it ends at the cursor wherever that is, except within half a track width
  of the clearance outline of something it runs into, where it ends on the outline (the mode table).

- **R38. Pad exits.** A route leaves a pad, and arrives at one, by one of the pad's exits: from its
  anchor straight out along one of its axes to its edge, or, from an oblong pad, along its long
  axis and out at 45° through a corner (turned with the pad). The bend as R3 draws it, or as the
  walk bends it, goes on from there. Drawn straight to the cursor, the head takes the axis pointing
  most nearly where the route goes — toward the cursor leaving, toward the route's other end
  arriving — the long axis on a near tie, kept until another is clearly nearer. Walked or pushed
  round something, it takes the exit that leaves the route with the fewest, gentlest corners (R6),
  legal and passing everything on the side it did; on a tie the one it had, then the longer. A
  round pad, and a square one turned by a multiple of 45°, set no direction: any leg leaves them
  squarely. With the other end inside the pad there is no exit. Obstacles, pushing and the walk
  apply to the whole path, exit included (KiCad's optimize pad connections). Exits are taken only
  in the 45° modes (rounded 45° too): in 90° and free mode, and once the posture is forced with `/`
  until the next click, any bend leaves the pad, as KiCad turns its smart pads off there.

### Targets and snapping

What the cursor means when it is on or near copper, to start a route and to end one.

- **R28. Under before near.** Copper under the cursor is the target, over any copper merely near
  it: inside a pad, that pad, whatever lies closer to the cursor. Only when the cursor is on no
  copper is copper near it a target: within a grid step of its outline, so a large pad captures
  as readily as a small one. Among several, layer first: the active layer's pad or via, then its
  track, then another layer's pad or via, then its track; within one of those, the nearest pad or
  via center, or track end (KiCad's pick).
- **R29. Where on it.** A pad or via is entered at its position (a pad's anchor, which is its
  hole where it has one). A track is entered at its end when the cursor is within the track's half
  width of it, otherwise at the point of its centerline (a track or an arc) where the grid crosses
  it nearest the cursor.
- **R30. Ending on the routed layer.** Mid-route, only copper of the route's net on the layer
  being routed is a target. Copper of the net on another layer is not arrived at; a via gets
  there (R24, K1).
- **R31. Shift** held turns off snapping to copper; the grid still applies.
- **R47. The start's axes.** Mid-route, a pointer off copper snaps to the grid point nearest it,
  except that each coordinate takes the route start's where that is nearer, so a route from an
  off-grid pad runs straight out along its axis (KiCad's aux axes at the start snap point, the
  anchor of the copper the route began on). Snapping to copper outranks it, as R28 says.

### Obstacles (Avoid, and Push when something cannot move)

- **R6. Hugging.** Going round an obstacle, the track touches it at exactly clearance and
  otherwise takes the fewest, gentlest corners: a 45° bend over a right angle, a right angle over
  an acute one, worth a few percent of length (KiCad's optimizer). It never follows an outline
  corner by corner where a cleaner bend clears it.
- **R7. The shorter side.** Every frame the head is walked round what it meets both ways,
  clockwise and anticlockwise, and takes the shorter that arrives, as KiCad's walkaround does
  (`LINE_PLACER::rhWalkBase`). No side is remembered from one frame to the next, so a route
  passing an obstacle changes sides where the other way becomes shorter.
- **R8. No side is kept.** Having passed an obstacle on one side does not hold the route there:
  the next frame chooses afresh (R7), and where neither way is short enough R39 decides.
- **R9. Head-on.** Moving straight into an obstacle is no different: the shorter way wins.
- **R10. Fast mouse.** A large jump between two frames is no different either: each frame is
  walked from the last click to where the cursor is.
- **R11. Cursor inside an obstacle.** The head stops at the obstacle's clearance boundary: each
  way round is cut where it comes nearest the cursor, and the head takes the one that ends nearer
  (KiCad's `cursorDistMinimum`). Moving the cursor about inside the obstacle slides the head along
  its outline.
- **R12. Coming out the far side.** If the cursor passes through an obstacle and out the other
  side, the route goes round whichever way is shorter to where the cursor now is (R7).
- **R39. The long way round.** Where the way round is more than three times the length of the
  plain bend, it is not where the person is heading: the head follows it only as far as 1.5 times
  that length, and stops at its point there nearest the cursor, at the obstacle, rather than going round
  (KiCad's walkaround hug). A click lays what is shown, and Finish (R23) goes on from there.
- **R13. Narrow gaps.** A gap narrower than the track width plus clearance on both sides is a wall.
  The head never squeezes through it and never shows copper in it, and never narrows to pass it
  (KiCad's): a narrower size is picked by hand (`Shift+W`, which K1 then teaches).
- **R14. Dead ends.** When the cursor cannot be reached (a closed pocket, a gap too narrow), the
  head goes as far as it legally can, to the reachable point nearest the cursor. It shows no
  violating copper; the gap to the cursor says it is blocked (F6).
- **R15. Other layers.** Copper on other layers is ignored. Drilled items (vias, through-hole pads,
  holes) are obstacles on every layer.
- **R16. Board edge and keepouts.** The board edge, at the routed net's own edge clearance (the
  rules' `edge_clearance`, as DRC holds it), and track keepouts are obstacles that never move. A
  route goes into a recess of the edge, a cutout or a keepout wherever it fits, as KiCad's walks
  their true outlines.
- **R17.** No proposed route crosses itself. A loop the head would form (routing back across its
  own tail) is cut out at the crossing.

### Clicks and finishing

- **R18. The preview is the commit.** A click commits exactly the route on screen. With *Fix all
  segments on click* off, it commits all but the segment nearest the cursor, which stays free and
  goes on following it. If the head is hugging short of the cursor, the click commits up to where
  the head is, and the next head starts there.
- **R19.** A click on a proposal that violates is refused, unless *Allow DRC violations* is on in
  Highlight. The violation stays marked, so the refusal is visible.
- **R20. Arriving.** When the head lands on copper of its own net that it did not start from (a
  pad, via or track), the route finishes on the click. A click with the cursor over its net's
  copper ends the route even where the head stopped short of it, leaving that end unconnected,
  as KiCad's does.
- **R32. Tees.** A route that ends on the middle of a track of its net splits that track at the
  junction, as a route started there does (R1): every junction is a track end.
- **R21. Ending.** A double-click, or `End` (KiCad's Finish), lays the head as a click does and
  ends the route there; a route that ends in a via keeps it. A click that lays nothing — on the
  route's current end, within the via placed there or the track's half width — does nothing, but
  for an armed via, which is placed there alone and ends the route: a via down to a plane is a
  whole route (KiCad's fix of an empty line). `Esc` ends the route at once, armed via or not: the
  head and the via are dropped, what was clicked stays as one undo step (R25), and what the head
  alone pushed springs back. With no route in progress `Esc` puts the tool away, as it does
  everywhere, and a via armed for the next route (R37) with it. Right-click, with the tool armed
  or mid-route, opens the router menu (KiCad's Interactive Router menu), each item showing its
  key: Cancel (`Esc`), Finish (`End`), Undo last segment, Route from the other end and Attempt
  finish (while the net has copper not yet joined), the vias (through, blind/buried, micro, and
  the two that pick the layer), Switch track posture, Track corner mode, Track and via sizes
  (S6's list) and Router mode. A press that shuts the menu is not also a click on the board.
  **Differs from KiCad:** KiCad's menu also holds the route and drag tools, Break Track, Clear
  Highlight, its router settings and the zoom and grid submenus; here those are the toolbar's,
  the router pill's and the canvas menu's, so the router menu holds only what acts on the route.
- **R22.** `Backspace`, and undo, remove the last click's segments and restore the pushed copper
  to how it was at that click. Redo does nothing mid-route.
- **R33. Leaving.** Picking another tool mid-route keeps what was clicked, as `Esc` does (R21).
  An agent's routing session ends the same way however it ends: a new `route_begin` on the
  board, its `cancel` gesture, its viewport closing (the person's × included) or ten idle
  minutes each land what it had clicked as one undo step, and the answer that ends it, or the
  agent's next call, lists what landed. Ours: KiCad has no agent.
- **R34. Holding still.** While a route is in progress the board does not change under it: a
  command that edits the board ends the route first, keeping what was clicked (R33), and a zone
  refill is held until the route ends. An edit from elsewhere (an agent's) that lands mid-route
  ends the route with nothing landed, its pushes sprung back: they were worked out on a board
  that is gone; a drag, pair or tune in hand ends the same way, its tool still armed. An agent's
  session meets the person's edit by replaying its gestures over the new board; only one that no
  longer replays ends with nothing landed. Ours: KiCad has no second writer. **Differs from KiCad:** KiCad refuses a zone refill while
  routing; ours refills on its own after edits, so it waits rather than being dropped.
- **R23. Attempt finish (`F`).** Routes the rest of the way to the copper of the net the route
  has not yet joined nearest the head's end (where the lead line to it points), as if the mouse moved there, following every
  rule above (KiCad measures from the line's end). If it cannot get all the way,
  the progress is kept and the route stays open. It goes on from where a long way round stops
  short (R39), round by round, and where a round comes back onto copper an earlier one laid, the
  stretch between is cut out (R26). An armed via rides the head and is placed where
  it arrives, as KiCad's Finish lays the via its head carries; stopping short, it stays armed.
  `Ctrl`+click is a plain click, as KiCad's: it
  neither finishes nor lands a violation (R19; Highlight with *Allow DRC violations* does that).
- **R24. Via.** `V`, or a layer key, arms a via at the head's end, bound for where `V` goes
  (R35) or that layer (a layer key); it rides the head and draws in the via color, not a
  layer's copper. The next click lays the head and places the via where it ends, and the route
  continues on the new layer; a head that cannot land refuses the via with it. Arming again for the
  same layer, or `Backspace`, disarms it; `Esc` ends the route (R21). The via must be legal on
  every layer it spans, and its
  hole keeps the rules' hole-to-hole spacing from every other hole, of any net, and the hole
  clearance from other nets' copper: in Push it pushes what it hits (holes never move). In Avoid, and in Push where what it hits cannot move, no violating
  via is shown (R14): it goes to the legal spot nearest the cursor, the head walked to it, or
  else back along the head to the last place it fits. In Highlight it is marked and the click
  refused, unless violations are allowed. Vias reach
  any copper pair the board has. When the route ends, finished or abandoned, the active layer goes
  back to the one active before the route began, as KiCad's does, whatever the route started on.
- **R35. Where `V` goes.** `V` places a through via, bound for the layer of the copper the route
  is headed for (the net's nearest unconnected copper, F7) when that copper is not on every layer
  and this is not its layer; otherwise across the layer pair (R40): from one of its layers to the
  other, from any other layer to its top (KiCad's).
- **R40. The layer pair.** Two copper layers, the board's outer two to begin with, set from the
  layer pair chip beside the Width and Via chips (its glyph alone, the pair in its tooltip; the
  list shows each layer's color): what `V` crosses and what a blind via spans. The pair is the
  editor's, for this session, as KiCad's is.
- **R41. Blind, buried and micro vias.** `Alt+Shift+V` arms a blind via, `Ctrl+V` mid-route a
  microvia (paste waits for the route to end): across the layer pair from one of its layers, else
  from the routed layer to the pair's top. The via spans only the layers between its two ends —
  it is judged on those alone, and its hole is held to the rules there — and is written `blind`
  where it reaches an outer layer, `buried` where it does not, `micro` for a microvia, at the net
  class's microvia size. One that would join the two outer layers is a through via.
- **R42. Layer pair presets.** The project keeps saved pairs (`board.layer_pairs` in the
  `.kicad_pro`, KiCad's Set Layer Pair presets); the chip's list picks one, saves the current pair,
  removes it, or turns a preset on or off, and `Shift+V` steps through those that are on.
- **R43. Picking the layer.** `<` (through) and `Alt+<` (blind) list the board's copper at the
  pointer, and the via goes to the layer picked, as a layer key's does (R24).
- **R36. A layer with nothing to via.** A layer key before anything is laid, on a through pad or
  a via, changes the route's layer and arms no via: the copper it starts on already reaches it.
- **R37. Starting with a via.** `V` with the route tool armed and no route in progress arms a via
  for the next route: it is placed where that route starts, which then runs on the via's far
  layer. A via that cannot stand there refuses the start, still armed, with what it violates
  marked for a moment (D9's).
- **R44. Route Selected.** `Shift+X` routes from each selected pad and via in turn — a selected
  footprint's pads among them — one interactive route after another: from the item itself, or,
  with `Shift+E`, from the nearest copper its net has not yet joined, back toward it. An item
  whose net is already joined is passed over. A route that arrives lands and starts the next;
  *Skip to the next selected item* (tool search) drops the current one; Esc ends the run, keeping
  what is clicked as it always does (R21). Each route is its own undo step (KiCad's Route
  Selected).
- **R45. Route From Other End.** `Ctrl+E` mid-route lands what is clicked and starts a new route at
  the nearest copper the net has not yet joined, heading back toward where this one ended.
- **R46. Attempt Finish Selected.** From the tool search: from each selected pad and via, one
  route along each ratsnest line that ends on it (on the item, or inside its copper), started at
  that end and finished as `F` finishes one (R23). The lines are gathered before the first
  route, and each is routed even where an earlier one has joined its far end since: it heads for
  what is left to join, so nothing is stranded (KiCad's `RouteSelected`). An item no line ends on
  is passed over. Each route that arrives lands as its own undo step,
  each that does not is dropped (KiCad's Autoroute Selected). Its finish heads for the copper
  nearest the start, and stays on the active layer where the start is a through pad, as KiCad's.
  **Differs from KiCad:** KiCad binds it to `Shift+F`, which is Fanout here, so it has no key.
- **R25. One undo step.** A finished route, with everything it pushed, is one undo step.

### After the commit

- **R26.** Committed copper is tidied as KiCad's line placer tidies a fixed line
  (`LINE_PLACER::simplifyNewLine`). Zero-length segments go. Where two straight tracks of one
  width meet end to end, off any pad or via, carrying straight on, and the route made or changed
  either, they become one: the route's clicks with each other, and the route with the old copper
  it continues, at either end and on along it (KiCad's `MERGE_COLINEAR` over the line through the
  new copper). A board track keeps its node through a merge. Where the route and an old track of
  its width meet at a point that is not a plain corner between the two, and one lies wholly along
  the other, the one whose far end leads nowhere goes: the stub of a track the route was started on
  short of its end and then ran over, or a piece of the route laid back over old copper to a dead
  end. A width change, a locked track or a track arc is never merged or removed so. **Differs from
  KiCad:** old copper the route lies over end to end, the same two places joined twice, goes too;
  KiCad leaves it where the route runs back along a track and turns off it rather than ending on an
  item, since it cuts a track only at the route's start and end.
- **R27.** A route that re-connects two points already joined by the same net makes the old
  connection redundant, and it is removed on commit, as KiCad and Altium both do by default
  (KiCad's `LINE_PLACER::removeLoops`). The old connection is a run of the net's tracks from the
  route's start to its end, a pad or via counting as one place wherever on it a track ends, with
  nothing joining the run between: no pad, via or branch. A piece of a track the route cut (R32)
  is old copper like any other. A run ends where its width changes, as a KiCad line does
  (`JOINT::IsLineCorner`), so a connection narrowed partway is two runs and stays. A run through a
  via stays, as KiCad's does, and so does one with a locked track or a piece of a cut arc. It goes
  in the route's undo step. While the head is down, the preview shows the board's copper as the
  landing would leave it: what the route merges into, cuts, lies over or makes redundant is drawn
  as it would be, as KiCad's router hides a loop it removes before the click. *Remove redundant
  tracks* off keeps the old connection; R26 still applies.

## Dragging

A drag (`D` over a track or via, or pressing and dragging a lone track or via already selected
with the select tool, or one of several tracks selected with nothing else, D14) changes an existing track the way routing would have drawn it. The same collision mode applies.

- **D1. Only the grabbed part moves.** Everything past the ends of the grabbed segment's two
  neighbours is pinned. Pads, vias and the rest of the line stay put.
- **D2. Segment drag.** The grabbed segment keeps its direction and moves sideways to pass through
  the cursor. Its two neighbours are re-drawn from their pinned far ends to meet it, in the corner
  mode, taking whichever bends give the shortest result.
- **D3. Collapse.** Dragged far enough that it would reverse (a 45° chamfer pulled past its
  corner), the segment disappears and its neighbours meet at a clean corner. The line never
  crosses itself or forms a bow tie. Dragging further holds the corner until a cursor gives a
  legal shape again.
- **D4. Segment at a line's end.** A segment whose end lands on a pad or via keeps that
  connection: a short stub is added at the pinned end so the connection keeps its direction.
- **D5. Corner drag.** Grabbing a corner re-draws both sides as bends, in the corner mode, from
  their pins to the cursor. With `G` the corner simply follows the cursor.
- **D6. Via drag.** A via follows the cursor; each track attached to it re-draws its last
  segments to follow, as in D2.
- **D7.** A drag that ends where it started writes nothing to the board.
- **D8. Collisions.** Avoid: the dragged part bends around what it meets, pins held. Push:
  as P1–P9. Highlight: the drag follows the cursor and the violation is marked.
  A push that cannot be settled refuses the drag where it stands, marked, for one line as for
  several (D14), as KiCad's dragger does.
- **D9. Releasing.** Releasing the mouse commits the drag, or `D` then a click does. A drop that
  violates lands, in Push and Avoid, where the drag last stood legal (KiCad's dragger); with no
  such place, `Ctrl` held at the drop commits it anyway (KiCad's commit of a drag fallen back to
  marking), else a release springs back, with the violation marked for a moment so the person
  sees why, and a click leaves the drag going. **Differs from KiCad:** KiCad's springs back
  unmarked; the mark is what explains the refusal (goal 7). In Highlight a violating drop is refused so,
  `Ctrl` or not, unless *Allow DRC violations* is on, when it lands. During a `D` drag, `Esc`
  drops it and right-click opens the router menu (R21): Cancel, Finish, the corner mode and the
  router mode; a press-drag offers no menu.
- **D10.** The tidy-up of R26 applies to the dragged line. With *Optimize entire dragged track*
  on, the whole line is smoothed as R6 smooths a route, on either side of the segment the cursor
  holds, never to the other side of anything, its ends kept.
- **D11. Smoothing.** With *Smooth dragged segments* on (the default), a dragged segment near the
  line of the segment beyond either neighbour, running the same way, snaps onto it, and the
  neighbour between closes up; a dragged corner near where two of its nearby segments' lines meet
  at 135° snaps onto that point. Near is within half the track's width in Push, a quarter in Avoid
  and Highlight, and a quarter in every mode for several tracks (D14) (KiCad's drag snapping).
- **D12. A free end.** Grabbed within half its width of an end nothing else of its net meets — no
  pad, via or other track — a line's end follows the cursor, its last bend re-drawn from the
  corner before it in the corner mode.
- **D13. A footprint.** `D` on a footprint, or with footprints selected, drags them with the
  cursor and brings their tracks along: a track ending in one of their pads has that end carried
  with the pad, its last bend re-drawn from the corner before in the corner mode; a track from one
  of their pads to another moves whole. Nothing is pushed or walked round, in any mode: what the
  moved pads and tracks come too near is marked, and a drop that violates is refused as D9 says
  (KiCad's footprint drag). A locked footprint does not drag. An agent's `items.update` with
  `tracks: "follow"` lands the same carry for a move (`carriedTracks`), never refused: its
  checks report what the moved copper comes near.
- **D14. Several tracks.** `D` with tracks of several lines selected, or a press-drag on one of
  them when only tracks are selected, drags them together: the line under the cursor leads, dragged as D2 drags a segment, and each other selected line whose
  selected segment runs parallel to it moves by the same amount, so a bus keeps its spacing; one
  running another way stays. Grabbed at a free end (D12), the lines' free ends move together
  instead, each keeping its offset across the leader's last segment. The mode applies to all of
  them together: Highlight marks, Avoid walks each round what it meets, the others included, and
  Push pushes for all of them at once, each keeping clear of the others; where that push cannot be
  done the drag is blocked, no line walked instead (KiCad's multi-drag).
- **D15. An arc.** `D` on a track arc changes its radius, the arc kept tangent to the lines either
  side: where a track of the same width meets it along its tangent, that track; else the arc's own
  tangent from its end. Its middle follows the cursor along the bisector of the corner they make,
  tighter nearer the corner. The tracks either side stretch or trim to the new tangent points; an
  end with no track along its tangent stays where it is, joined to the arc by a new straight run,
  so it only tightens. Pulled into the corner, the arc goes and the corner is sharp. An arc of 180°
  or more does not drag. The mode applies as to a segment drag (D8): Highlight marks what it comes
  too near and a drop that violates is refused; Push pushes it aside, the arc and its runs the
  head, their far ends held; Avoid walks the line round it. Where a push or walk bends the arc
  itself, the line lands as straight track, as a pushed arc does (P11) (KiCad's arc drag).

## Pushing

- **P1. What moves.** Tracks and vias of other nets. Pads, footprints, locked items, zones, the
  board edge and keepouts never move. Vias move unless a setting keeps them fixed.
- **P2. As little as needed.** Pushed copper moves only where the head presses on it, by only as
  much as clearance needs. The rest of the pushed track keeps its geometry, its ends stay where
  they were, and it stays in 45° shapes. Where the head presses it bulges in 45° shoulders that
  leave its run at the last corner before the press, smoothed as R6 smooths a route: a
  trapezoid ahead of the head's end, as KiCad's, never a box wrapped round it. Copper pushed by a
  track at another angle (a pushed line keeps its own slant) keeps clear of it along that angle,
  as KiCad's segment outline does.
- **P3. Chains.** Pushed copper pushes the copper beyond it in turn, up to a limit. What the
  head pushed settles before the head is judged again, so the nearest track goes first and the
  rest nest beyond it. A track is never pushed round behind where its pusher starts.
- **P4. Spring-back.** When the head backs off, pushed copper returns to where it was: all the way
  back when the head no longer presses on it at all.
- **P5. When a push is impossible.** The head is first walked round what can never move (pads,
  holes, keepouts) as in Avoid, then pushes the rest. If that push needs something that cannot
  move, or runs past the limit, the head is walked round everything for that frame, as in Avoid,
  and nothing is pushed (KiCad's `rhShoveOnly` falling back to `rhWalkOnly`).
- **P6.** Pushed copper also keeps clear of the route's committed clicks, not just the head.
- **P7. A pushed via** carries its attached tracks with it; their last segments re-draw to follow.
  On every layer it spans, what the via and those tracks then press on is pushed in turn, as the
  head's pushes are, keeping clear of the via too (KiCad's via fanout push). Its hole is held as a
  placed via's is (R24): where clearance would leave it too near another hole, it is not pushed,
  and the head goes round it (P5).
- **P8.** Pushed copper is tidied as in R26, within the part that moved.
- **P9.** A push commits with the route or drag that caused it, as one undo step.
- **P10. Meeting what cannot move.** A pushed track that would have to run into a pad, a locked
  item or anything else that cannot move reflects the push: it stays, and the head goes round it
  (P5, with R11 holding the head at its clearance while the cursor is still inside it, and R39
  stopping it short of a long way round). With *Jump over obstacles* on, it is pushed on round
  what it meets instead, behind it, and
  stays pushable (KiCad's setting of the same name).
- **P11. Arcs.** A track arc is pushed with its line: the line runs on through the arcs of its
  width, and an arc whose stretch the push leaves as it was is kept as that arc; one the push
  bends becomes straight track, smoothed as any pushed stretch is (KiCad's).

## Differential pairs

KiCad's Route Differential Pair (`6`): the two halves of a pair drawn as one line.

- **PR1. Starting.** `6` over a pad, via or track of a net whose name is a pair half
  (`USB_D+`/`USB_D-`, `CLK_P`/`CLK_N`, as DRC reads them) starts the pair there, with the other
  half's nearest copper of the same kind as its partner, however far and whatever footprint it is
  on: a pad or via on the same layers, a track by its loose end (one no other copper of its net
  meets), so a pair goes on from the end of an existing pair's tracks; a track with no loose end
  starts nothing (KiCad's). From the tool search, the next click on such copper starts it. Started
  on copper not on the active layer, it switches as R1 does.
- **PR2. Gateways.** A pair is built between gateways: two anchor points, one per half, at the
  pair's pitch, each reached from its copper by a short entry (KiCad's `DP_GATEWAY`). At the start
  every candidate is offered (`BuildFromPrimitivePair`, `BuildGeneric`): for pads, fan-outs on
  both sides that go straight out 1.5 times the pad's length and then converge at 45°, plus exits
  from the pads' midpoint, side by side and diagonally; for a track end or via, the anchors
  themselves. Gateways are offered at the cursor too, and at the target when arriving (PR4). Each
  start and end gateway pair is joined by a two-segment trace per half, in both postures, and a
  candidate is refused if a joint turns sharper than 45°, the gap is not held, a half crosses
  itself or the halves cross each other; the best of the rest is taken (`FitGateways`,
  `BuildInitial`); candidates are made and ties settled in KiCad's order. Near the line the pair
  runs on (within half a pitch of it) the head goes straight on rather than jogging. Before the
  head the cursor is moved out of what a circle as wide as the pair would hit (as wide as the via
  pair when fitting vias): everything in Avoid, what never moves in Push, nothing in Highlight
  (`propagateDpHeadForces`). Where no candidate fits, the last head that did stays (KiCad's
  `m_currentTrace`). The posture is the router's own: straight first to begin, after a click the
  one the last bend leaves, `/` flipping it; the mouse's trail (R4) does not set it.
- **PR3. Walking and pushing.** Avoid works on each half: one half is walked round what it meets
  the shorter way and the other pushed to the gap from it, in turn, both halves first; of those
  that arrive, the one with the least coupled length plus three times its skew is kept, as
  KiCad's score has it (`DIFF_PAIR_PLACER::tryWalkDp`). Where none arrives the head shows
  nothing and a click lays nothing. In Push the pair first walks so round what never moves, then
  pushes the rest with both halves (and its vias) as heads; a push that cannot be done leaves the
  head walked and marked. Each half is judged against the board, the clicks laid and the pushes,
  at clearance; the halves meet each other's gap only in the fit (PR2). After each walk the pair
  is tidied as one (KiCad's pair optimizer, `mergeDpSegments`), which may bring a half back as
  near the other as clearance allows. Corners are 45°: a pair has no free angle.
- **PR4. Arriving.** Over a pad, via or track end of the pair on the routed layer, with its
  partner beside it, that copper's gateways are offered as targets (PR2), each entered in reverse
  so the halves run in to their own copper; the click finishes the pair. Arriving with its halves
  on the wrong sides, no candidate fits without crossing: it does not arrive, and the last head
  that fitted stays, as KiCad's does.
- **PR5. Via pair.** `V` arms a via pair: the head ends in two vias, gateways spaced by the via
  diameter and the pair's via gap, entered at 45° (`BuildForCursor` with vias fitted): the via a
  route's click places (the size list's pick, else the pair's class's), through every copper
  layer (KiCad's default via type). The vias are part of the halves, checked and
  pushed out of what they meet as the head is (`propagateDpHeadForces`), and drawn in the preview
  as they will land. The next click lays them and the pair goes on across the layer pair from
  their gateway. The layer changes only through a via pair, or by starting on a via; a layer key
  mid-pair arms a via pair to that layer; going on from vias that span it, the layer simply
  changes (`SetLayer`).
- **PR6. Sizes and the rest.** The pair draws at the width and gap the rules give its halves on
  the layer being routed (S13: its net class's differential pair width and gap, or its tuning
  profile's, or a custom rule's), or at sizes typed into *Differential pair dimensions…* (tool search, router menu) for the
  session; each session starts at the net class, as KiCad's does. Typed sizes are the session's
  alone: nothing is written, as KiCad writes nothing. Clicks, Backspace (a via
  pair with its click), `End`, Esc and right-click behave as a route's (R18–R22); with *Fix all
  segments* off a click lays all but each half's last segment. Each click's last segments are the
  next head's start, so a turn at a click is mitred as any corner, up to 45°: a sharper turn, or
  a cursor that would have the inner half step back, fits no gateway. On landing both halves are
  simplified (KiCad's `FixRoute`); the pair lands as one undo step. A drag moves a pair together only with both halves selected, as KiCad's
  does (D14, its multi-drag): `D` on one half alone drags that half, as any track.
- **PR7. An agent's pair.** `route_begin` with `pair` drives the same tool (`pairRoute.ts`, which
  the editor calls too): it starts as `6` over its `start` or `at`, and `route_step`'s gestures
  are the tool's keys — a move, a click, `via` (`V`), `widthRow` (`W`, the pair size list),
  `posture`, `undo` (Backspace), `finish: "here"` (`End`), `cancel` (Esc). Typed sizes are the
  session's alone and join no project list. Ours: KiCad has no agent.

## Length tuning

KiCad's length tuners: `7` a single track, `8` a differential pair, `9` a pair's skew.

- **T1. Where.** The key arms the tuner, as KiCad's tool: the first click on a track (a straight
  one, else an arc) starts a pattern where it lands, on the whole line through it — its tracks
  and arcs of one width joined end to end, as far as a pad, a via or a branch (KiCad's
  `AssembleLine`). The meanders run along that line from the click to where the cursor lies along
  it, round its bends, each straight stretch's first bump on the cursor's side of it; arcs pass
  through, and an end that falls in an arc moves to the arc's end. Moves update them, the second
  click lays them and leaves the tuner armed for the next. A track already in a tuning pattern
  starts none (KiCad's). The tuned track's layer becomes the active one. Esc drops the pattern in
  hand, and with none leaves the tuner; undo does the same. While a pattern is in hand `1`/`2`
  step the spacing up/down and `3`/`4` the max amplitude, 0.05 mm at a time (KiCad's step), the
  amplitude never under the min and the spacing never under the track's width plus clearance;
  the steps last while the tuner is armed, and with no pattern in hand they say to click a track
  first. Right-click opens the router menu (R21): Cancel, Finish and *Length tuning settings…*,
  which `Ctrl+L` and `E` also open while a tuner is armed (KiCad's). The hint (bottom left, K1–K5)
  coaches the click order — where to click armed, move then click with a pattern in hand — and,
  for a few seconds, why a click or key did nothing (no track, no partner beside it, a track in a
  pattern, no pattern in hand). With a pattern in hand it teaches `1`/`2` spacing and `3`/`4`
  amplitude; short of the target, `2` tighter and `3` taller instead; they fit, so no `?` follows.
- **T2. How much.** The net is brought to its target: its length rule's (`(constraint length
  …)`, the opt, else its min); a length typed into *Length tuning settings…*
  (tool search) where the net has no rule, or with *Override custom rules* on (KiCad's), held to
  0.1 mm either side — but a typed length that is the rule's own opt keeps the rule's bounds, as
  KiCad's dialog does; else every bump as tall as it may be. Its length is what KiCad's length
  calculator counts (`tuneLength.ts`): its tracks and arcs, each via's height through the
  board's stackup (KiCad's default where the board has none) between the layers its tracks join,
  when the board counts via heights (`use_height_for_length_calcs`), and each pad's pad-to-die
  length. A rule with no opt aims at its min (a max alone sets no target), and what is measured
  is the tuned track's path between its two pads, as KiCad's tuner measures it: a track ending on
  a pad's anchor is read from the anchor to where it leaves the pad, and one ending inside a via
  from the via's center (`OptimiseTraceInPad`, `OptimiseTraceInVia`). A rule in ps (KiCad's time
  domain) is held through the net class's tuning profile: the path's delay now, and the profile's
  delay per mm on the tuned layer, turn its bounds (0.1 ps either side where open) into lengths
  (KiCad's `calculateTimeDomainTargets`), and the readout and the pattern keep them in ps; with
  no profile delay on the layer, the rule holds nothing.
- **T3. The meanders.** Bumps square to each straight stretch, each a spacing wide (never under
  the track's width plus clearance) and as tall as clearance lets it be up to the max amplitude,
  none under the min, starting at the stretch's start (in by a corner's radius, a pair's offset).
  A place no bump fits is passed by a spacing less its corners and a step, and the bumps start
  again beyond (KiCad's), never nearer the last bump than a spacing of flat track, so no corner
  rounds back over another (a pair's halves would cross). A bump also keeps the track's width and clearance from the rest of its
  own line and the bumps of its other stretches, where a bend would bring them together.
  Single-sided, each is a U on the one side that comes back to the track, a spacing of flat track
  between. Otherwise (KiCad's default) they touch, alternating sides, as one serpentine whose legs
  cross the track (KiCad's start, turn and finish shapes). Corners are rounded into arcs at
  KiCad's radius: the settings' share of half the spacing, no less than half the track width, and
  no more than half the spacing or half the bump's height. A rounded bump is at least a track
  width tall (KiCad's). Bumps are laid until the line would reach its target; a last one that
  overshoots even with every bump at its least is left out, and the overshoot is then taken off
  the bumps in turn, an even share of what is left each, none under the min (KiCad's
  `tuneLineLength`), so they stand alike rather than the last cut down alone.
- **T4. The result.** KiCad's tuning status rides beside the cursor (`TuneMeter.vue`), flipping
  at the viewport's edge: while a pattern is in hand, over a track while a tuner is armed (what a
  tune started there would read), and while a pattern's handles move. Properties keeps the
  selection. It names the tuner and the net and reads the current length (skew, for `9`; a pair's
  longer half, T5; a delay in ps where the rule is one, T2). With a target, a meter under it draws
  the min-to-max band, the opt ticked and the length a needle, the bar widening to take in a
  length far outside the band; the needle is green inside the band, amber outside it. With none,
  the length alone. **Differs from KiCad:** KiCad's popup is a table of the length and its
  bounds; a meter shows at a glance how near the length is and which way to go. The click
  rewrites the tracks the tune reaches with the meandered line and writes KiCad's tuning pattern
  (`(generated (type tuning_pattern) …)`) with the settings, the target, the status, the base
  line (its arcs kept, as KiCad writes them) and its meanders as members (the leads either side
  stay plain track), so KiCad reads and re-tunes it. A violating result is refused as a route is
  (R19). A pattern on the board, ours or KiCad's, is one item, as KiCad's: a click or a band on
  any of its tracks selects it, and it moves, turns and flips with them. Its Properties rows
  (target, override, amplitudes, spacing, first side, single-sided, rounded, corner radius) and
  its four handles, KiCad's (`PCB_TUNING_PATTERN::MakeEditPoints`), re-tune it as they change:
  its tracks go back to the run they replaced and the tuner lays it again there. Start and end
  slide along its base line (a pair's centerline); the third sets how far out and to which side
  the bumps reach, standing half a track width past the largest amplitude (a pair's, a width and
  the gap more); the fourth, 1.5 spacings along from it, sets the spacing. A handle sets only its
  own value, in hundredths of a millimeter, and a largest amplitude under the least carries the
  least down, as KiCad's setters do. **Differs from KiCad:** the amplitude handle stands halfway
  between the ends, where KiCad's stands beside the base line's first point, off the pattern
  when the line bends before the meanders. *Update all tuning patterns* (tool search, KiCad's)
  lays every pattern again where it lies, to the rules as they are now, as one step. Deleted
  alone, a pattern gives back that run; with anything else, or unrouted, its tracks go with it;
  and a pattern whose tracks are all deleted goes too. A copied pattern pastes as a pattern, as
  KiCad's does.
- **T5. Pairs and skew.** `8` over a half of a pair meanders the pair's centerline over each
  stretch of the line where the halves run coupled — parallel, at the pair's distance where it
  was clicked, KiCad's coupled segments — each half its offset, at a spacing of at least a track
  width, the clearance and twice the offset (KiCad's), so the halves of neighboring legs keep
  clear. Corners round as T3's, the centerline's radius no less than the offset and half a track
  width, and each half runs concentric with it, so the gap holds through every turn; where a low
  bump leaves no room, the inner half turns sharp, as KiCad's does. The pair's length is its
  longer half's (KiCad's), in the readout, the status and the target. `9` meanders the clicked
  half's line alone by what it is short of its partner, to the skew rule's target (else a skew of
  nothing, 0.1 mm either side, as KiCad's). A skew rule bounding one side leaves the other 0.1 mm
  from its opt, as KiCad's.
- **T6. Settings.** Each tuner keeps its own min and max amplitude, spacing, corner radius and
  single-sided, as KiCad does, with KiCad's defaults (a pair's spacing 1 mm, the others 0.6 mm):
  read from the project (`tuning_pattern_settings` in the `.kicad_pro`) on open and when it
  changes, and written back there, keys we do not model kept. Board Setup's *Length-tuning
  patterns* edits all three, as KiCad's page does, each under a fixed legend of the meander it
  lays (A, s, r), and an agent reads and writes them as `board_get_setup` / `board_update_setup`'s
  `tuningPatterns`. *Length tuning settings…* edits the armed (else last used) tuner's copy
  only, and forgets the target and its override when the tool is left, as KiCad's in-tool dialog
  does; Board Setup's page is what saves the defaults. A chamfered corner style (`corner_style` 0) is kept in the file but drawn rounded, so
  the page offers no corner style.
- **T7. An agent's tune.** `route_begin` with `tune` arms the tuner (`tuneTool.ts`, which the
  editor calls too) and starts a pattern on the line through the track at its `at` (as the first
  click) or its `start`, grabbed at that track's start; its target and meander settings are the
  settings form's, for the session alone, the project's defaults written nowhere. A move sets
  where the meanders end and on which side, a click (or `commit`, `finish: "here"`) lays them
  and answers `tuned`: the length (skew), the target and the status, and a time-domain tune's
  `delay` in ps beside them; `undo` or `cancel` drops the
  pattern, the tuner still armed. A pattern already on the board is re-tuned by `items_update`
  with its Properties rows and its `origin` and `end` (the handles), answering `tuned`, and every
  pattern by `board_update_tuning_patterns` (*Update all tuning patterns*), both through
  `patternRetune.ts`, which the editor's rows, handles and command call too.
  `board_describe`'s `lengths` reads a net's whole routed length, as KiCad's Net Inspector does,
  counted as T2 counts copper; the tuner alone measures one track's pad-to-pad path. Ours: KiCad
  has no agent.

## Settings

The router menu (the pill in the board's corner) holds KiCad's Interactive Router Settings, each
a user preference with KiCad's default, under the mode that alone reads it, as KiCad's dialog
enables it only there, the rest below the modes: under Push, *Push vias* (P1) and *Jump over
obstacles* (P10); under Highlight, *Allow DRC violations* (R19) and *Free angle mode* (R3); then
*Remove redundant tracks* (R27), *Optimize pad connections* (R38; off, any bend leaves a pad),
*Smooth dragged segments* (D11), *Optimize entire dragged track* (D10), *Use mouse path to set
posture* (R4; off, the posture is *Start diagonal*'s, `/` flipping it), *Fix all segments on
click* (R18). Each whose name does not say what it does explains itself on hover. The corner mode
(R3) is kept with them. Its *Suggest finish* is saved by KiCad but read by nothing, so it is not
offered.

## Width and via size

What a route draws with, and how the person changes it: KiCad's model, a row of a size list kept
until changed.

- **S1. The net's own.** The list's first row, the default: a route draws at the width the rules
  prefer for its net on its layer — the net class, its tuning profile (S12) or a custom rule
  (KiCad's "netclass width") —
  and the via the rules prefer. Started on a track, or on a pad or via a track leaves, it draws
  at that track's width instead while *Use starting track width* is on (R1). After a via, the
  first row is resolved again for the new layer; a width kept from a track survives the via only
  while it is within the new layer's rule.
- **S2. Kept.** A row picked, by key or from the list, before or during a route, is used by every
  route until another is picked, for this board and this session (KiCad's). **Differs from
  KiCad:** its chip is gold while it is not the first row, since a forgotten size is the setting
  that surprises; KiCad's toolbar only names it.
- **S3. Mid-route.** A size picked during a route applies from the last click onward. Width is
  kept per click, so a size changed partway is part of what commits.
- **S4. The list.** The net's own size first, then the project's extra sizes by size, each once:
  KiCad's `track_widths` / `via_dimensions` in the `.kicad_pro`, edited in Board Setup ▸ Net
  Classes below the class table; vias likewise as diameter / drill. A size outside the net's rule
  is listed with its reason (S7). While a pair is routed, the list is the pair's: its net class's
  width and gap, then the project's `diff_pair_dimensions`.
- **S5. Stepping.** `W` / `Shift+W` step to the next / previous row, wrapping, so `W` past the last
  comes back to the net's own (KiCad's); while a pair is routed they step the pair's list. On a
  width carried from a track (R1), the first press leaves it for the row already chosen rather
  than stepping. **Differs from KiCad:** KiCad's first press mid-route does nothing visible when
  the route started where no track was to carry; ours steps. `'` / `\` step the via the same way,
  including while a via is armed (R24), which then draws at the new size. A step leaves a custom
  size (S6) for the list.
- **S6. Editing sizes.** `Q` opens the custom size form at the cursor (KiCad's Custom Track/Via
  Size): a track width, via diameter and drill typed in, in force for both until a row is picked.
  The list is the chips' (S10) and, mid-route, the router menu's *Track and via sizes* (R21,
  KiCad's right-click width menu). It leads with *Use starting track width* (R1), then the widths
  (the pair's sizes while a pair is routed), then the vias, the rows in force ticked; below the
  sizes, *Custom size…* opens the same form, and the last row, *Edit sizes…*, opens Board Setup ▸
  Net Classes, where the classes' sizes and the extra sizes (Custom sizes) are edited.
- **S7. Out of rule.** A width outside the net's min or max is drawn and flagged, not clipped:
  the width pill (S11) turns to the warning color, the list's rows say which bound they break, and
  DRC reports it once committed. Stepping lands on it as on any row (KiCad's).
- **S8. No automatic neck-down.** The router never narrows a track on its own, as neither KiCad
  nor Altium does by gap; narrowing is a size picked by hand (S3). Altium narrows only on entering
  a room whose width rule says so, which is the model if this returns.
- **S9. Selection.** With no tool armed, `W` / `Shift+W` and `'` / `\` step the selected tracks'
  width and vias' size to the nearest size of the list past their own, stopping at its ends, as
  one undo step (KiCad's), the list's first row the Default class's size, as KiCad's. The toolbar chips never change a selection;
  Properties does, its width a plain field as KiCad's, warned only outside the rules' min and
  max, where DRC would flag it.
- **S12. Tuning profiles.** A net whose class names a KiCad 10 tuning profile draws, on each
  layer the profile gives a width, at that width: the net's own row (S1, S4) resolves to it. The
  rules resolve a size in KiCad's order, each overwriting the fields before it: the net class's,
  then the profile's (`tuning profile '<name>'`, exact: its min, preferred and max all that
  width), then custom rules (KiCad's `DRC_ENGINE::loadImplicitRules` adds class rules, then profile
  rules, before the `.kicad_dru`'s). The profile sizes the route whatever its DRC severity
  (`tuning_profile_track_geometries`, ignore unless raised): KiCad's router asks the same rules,
  and severity decides only what DRC reports. A layer the profile gives no width falls back to the
  class. A row picked or a size typed is kept across layers, drawn and flagged where the profile
  forbids it (S7). The Route group (S11) names the profile beside the width where it, not the
  class, sets it, and the list's first row names it. A size picked on an earlier route counts as
  explicit only on the route it was made on: with *Use starting track width* on, a via onto a
  layer whose profile forbids it replaces it with the profile's, as KiCad's
  (`ROUTER_TOOL::updateSizesAfterRouterEvent`).
- **S13. A pair's sizes per layer.** A pair's first row (S4) is what the rules give its halves on
  the layer being routed: the width from `track_width`, the gap and the via gap from
  `diff_pair_gap`, never under the board's minimum width and clearance (KiCad's `ImportSizes`).
  After a via pair (PR5) it is resolved again for the new layer, as a route's after a via (S1;
  KiCad's `updateSizesAfterRouterEvent`). While a pair is routed, a Pair group stands in for the
  selection in Properties as the Route group does (S11): the two nets, their class, the layer, and
  the width, gap and via gap in force, noted where not the class's.
- **S10. Controls.** A Width and a Via chip sit on the top bar in their own group after the route
  and via tools, always, as KiCad's toolbar's width and via lists: each reads the choice, its glyph
  alone for the net class's or the size picked or typed over its unit, never the routed net's,
  and opens the list. Corner mode and posture
  have no chips: the preview shows both, and their keys are taught (K1) and in the tool search.
- **S11. Readout.** The top bar's chips (S10) name the choice and never change with the net
  routed; while a route is in progress, the Properties panel says what that comes to on this net,
  as a Route group in place of the selection: the net, its class as a tag, and the layer; the width
  and the via in force, noted only where not the class's (continued, picked, custom), with a
  warning under the width outside its rule; the clearance, only against the obstacle the head hugs
  or is blocked by, naming it; and the length, only where a `length` rule bounds the net: its
  routed length plus the route's clicked copper, head and via heights (T2's reading), the rule's
  bounds beneath, a warning past its max. The bottom-left corner keeps only the keys' hint. KiCad's
  status panel lists the sizes the same way; Altium shows the length in its cursor HUD. A selected
  track or arc shows, read-only, as KiCad's track readout: its own length, its net's routed length
  (tracks and via heights), and where a pad sets a die length, the pad-to-die and full lengths.

## Learning the keys

Routing has more keys than any other tool. They are taught where and when they help, a few at a
time.

- **K1. Situational.** The hint (bottom left) teaches the keys of the operation in hand — a
  route, a pair route or a tune — as `.kbd` caps, in the order they matter, at most three, fewer
  where the strip would reach the right corner's pills. The moment's own keys lead: while the head
  is clear, `V`, `W` and `/`; while a via is armed, `'` / `\` and `Backspace`; when the head nears
  a pad of its net on another layer, `V` alone; blocked at a gap the narrowest legal size on the
  list would pass, `Shift+W` alone. A pair route leads with its via pair and size, a tune with its
  spacing and amplitude. `?` (K4) trails only where keys were left out. Before a route, a pair or
  a pattern starts, the hint shows no keys: the pair and the tuner say where to click instead.
- **K2. Echo.** When the person does with the mouse what a key does (a size from its chip, corner
  mode from its chip), the hint shows that key once.
- **K3. Steady.** A moment shows the same keys every time; none fades with use, so the hint
  never changes under someone who has learned where to look.
- **K4. The rest.** `?` opens a card above the hint of every key of the operation in hand, the
  ones the hint showed and those it had no room for — a route's in sections (route, sizes, vias,
  layers) — and closes it again (the common "show shortcuts" key; Altium's is `Shift+F1`, KiCad's
  Ctrl+F1 lists every hotkey); so do its close button and `Esc`, which then leaves the operation
  alone, and the operation ending. Where the hint shows every key, `?` does nothing. The card says
  `?` toggles it. Not F1, which is KiCad's zoom in on Windows and Linux.
- **K5. Quiet.** Nothing teaches at the cursor, nothing is modal or animated, and a
  hint never moves the coordinates (DESIGN.md, viewport status strips).

## Feedback

- **F1.** The preview draws the head and the tail in their layer's color. Violating segments are
  drawn in the violation red.
- **F2.** In highlight mode, and whenever a click is refused, the copper being violated is drawn
  in a collision green no layer or highlight uses, over a gray halo of the clearance the rules
  give it against the route, in place of its own clearance outline, as KiCad draws it; a hole too
  near shows its halo, a keepout its outline. The person sees what is in the way, not
  only that something is.
- **F3.** The outlines the display settings draw are each item's own clearance: each pad's on the
  active layer, the route's round the head and its via, and pushed copper's (F4). What the head
  runs into is outlined at the clearance between the two (F2), as KiCad's preview draws it.
- **F4.** Pushed copper is drawn where it would go, solid, with its original hidden, over a gray
  halo of the clearance it keeps wherever the route's own clearance is shown.
- **F5.** Nothing follows the cursor: the route's sizes and their sources are the corner pills
  (S11), its net is the net in focus (F8), and what the router is doing is the preview itself
  (F1, F2, F4, F6). A cursor readout of net, layer, width, length and state was tried and
  removed: it repeated the pills and sat off the cursor.
- **F6.** When the head stops short of the cursor, nothing is drawn across the gap: the gap
  itself says it.
- **F7. Where next.** A line runs from the head's end to the nearest copper of the net the route
  has not yet joined (where R23 would go), brighter than the ratsnest, so the person sees where
  the route is headed. It stands in for the net's airwire to that copper, which is not drawn
  beside it, and the net's other airwires span from the route as it is drawn, not from where it
  started.
- **F8. The net in focus.** While a route or drag is in progress, the routed net's copper is lit
  as a selection is and every other item sinks toward the canvas; the net's airwires are
  brightened and every other net's dimmed. A keepout's outline (F2) is a constant width on screen.

## Performance and determinism

- **Q1.** On a board like Jetson's, every mouse move is answered before the next frame. A push
  chain that cannot finish within budget is treated as impossible (P5), and the result is the same
  whenever the same inputs come in.
- **Q2.** The same board, settings and sequence of mouse and key events always give the same
  result, preview and commit alike.

## Decisions

Settled while building, each open to revision once it is used:

- **90° mode** hugs with only 0° and 90° segments: a round pad is passed as a square.
- **R4.** The posture is read from the trail once the cursor is three track widths (at least
  0.3 mm) from the tail, a bend taking it once the trail keeps 30% nearer it than the other; it is
  settled at 25 widths (at least 3 mm), and read afresh if the cursor comes back within three.
- **R39.** A way round up to three times the plain bend is taken whole; past that the head goes
  on along it to 1.5 times the bend's length (KiCad's walkaround hug threshold, and twice it). A walk that gets nowhere within ten times is a dead end
  (R14).
- **Overlapping obstacles** (outlines that meet, so there is no room between them) are always
  passed on the same side. This is what makes a pad row one wall rather than a comb to get stuck
  in.
- **Push budget.** An attempt may do a fixed amount of work (counted, not timed, so the answer is
  the same on any machine; **Differs from KiCad:** KiCad also stops a push after a time limit,
  which makes its result depend on the machine — Q2). Past it the push is impossible (P5).
- **R2.** The way out is the head's own until it leaves the clearance area it started in; where its
  own way runs over that copper, it is the nearest point outside the area instead.
- **D6, via in Avoid.** A dragged via that meets something slides to the clear spot nearest the
  cursor on the side it came from (R11's rule for the head), else stays where it last stood clear.

## Status

What the engine does not do yet:

- **R44 per line.** Route Selected passes over an item only when its whole net is joined;
  KiCad's `RouteSelected` walks the item's own ratsnest lines as R23's Attempt Finish does.
- **R47 in a drag.** KiCad's drag holds the pointer to the grab point's axes as a route holds it
  to its start's (`InlineDrag`); ours snaps a drag to the grid alone.
- Sub-width jogs left by a grid-snapped click are not straightened on commit, as KiCad's
  `LINE_PLACER::simplifyNewLine` merges only exactly collinear segments.
- **Q1.** Pushing on bitclock answers in about 10 ms at the 99th percentile and 24 ms at worst
  (walking in 5 and 7); a worker that answers the latest cursor would take that off the frame.
- Open, to settle before building: a Keys cap the mouse can click.

