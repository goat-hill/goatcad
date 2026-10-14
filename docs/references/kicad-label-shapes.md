# KiCad label and sheet-pin shapes

Read from KiCad source (`eeschema/sch_label.cpp`), not measured from a plot. The
five `LABEL_FLAG_SHAPE` values render two different ways depending on the kind of
label, and **`bidirectional` and `tri_state` are identical in both** — the source
gives them the same template arrays verbatim.

## Hierarchical labels and sheet pins: a glyph at the connection point

`SCH_HIERLABEL::CreateGraphicShape`. `SCH_SHEET_PIN` derives from `SCH_HIERLABEL`,
so a sheet pin is drawn exactly like a hierarchical label. The text sits beside the
glyph; there is no box around it.

Every point is an integer multiple of `halfSize = textHeight / 2`, from the anchor,
chosen by `TemplateShape[shape][spinStyle]`. For the `HI` spin (text running right):

| shape | points, in halfSize units |
| --- | --- |
| input | (0,0) (1,1) (2,1) (2,-1) (1,-1) |
| output | (2,0) (1,-1) (0,-1) (0,1) (1,1) |
| bidirectional | (0,0) (1,-1) (2,0) (1,1) |
| tri_state | identical to bidirectional |
| passive (`UNSPECIFIED`) | (0,-1) (2,-1) (2,1) (0,1) |

So: a chevron pointing in, a chevron pointing out, a diamond, a diamond, a square.
The other three spin styles are the same shapes rotated, held as their own arrays.

## Global labels: the shape wraps the text

`SCH_GLOBALLABEL::CreateGraphicShape`. One six-point outline enclosing the text,
whose ends are chamfered by the shape:

    margin   = 0.375 * textHeight        (DEFAULT_LABEL_SIZE_RATIO)
    halfSize = textHeight / 2 + margin
    symbLen  = textBoxWidth + 2 * margin
    x = symbLen + penWidth + 3           (3 internal units, negligible)
    y = halfSize + penWidth + 3

Base outline, before the shape is applied — note it runs in **-x** from the anchor,
then the whole thing is rotated by spin style:

    (0,0) (0,-y) (-x,-y) (-x,0) (-x,y) (0,y)

The point is made by pushing one end's middle vertex outward by `halfSize`:

| shape | change |
| --- | --- |
| input | `x_offset = -halfSize`, `points[0].x += halfSize` — pointed at the anchor end |
| output | `points[3].x -= halfSize` — pointed at the far end |
| bidirectional | both |
| tri_state | both (identical to bidirectional) |
| passive | neither: a plain rectangle |

## Colors are per kind, not per state

From a plot of a file with no wires at all — every label dangling — each kind still
plots its own fixed color, so the color says what an item **is**, never whether it
is connected. KiCad's default theme:

| kind | color |
| --- | --- |
| local label | `#0F0F0F` |
| global label | `#840000` |
| hierarchical label | `#725600` |
| sheet pin | `#006464` (the sheet's name color) |

Dangling-ness shows in the editor as hollow endpoint markers and, after a run, ERC
arrows. Neither is part of the drawing and neither appears in a plot.
