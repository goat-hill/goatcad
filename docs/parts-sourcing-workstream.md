# Parts sourcing — the IDE side

Picking a real manufacturer part from a distributor and getting it onto a component, by hand, in
the IDE. The agent route is complete (`parts_search` … `schematic_bind`, `parts_cache_datasheet`,
`footprint_cache_model`); this doc owns closing the same steps from the GUI, which
[MILESTONES.md](./MILESTONES.md) schedules after the alpha chain closes. What is built is described
in [ARCHITECTURE.md](./ARCHITECTURE.md) §3.10; the `parts:*` channels are registered in `src/main/partsIpc.ts`.

## State

Built: the provider registry (`PartsProviderId = 'digikey' | 'mouser'`), both providers verified
live, the credential store, the rate limiter, the memory-only result cache, Settings ▸ Distributor
APIs, and Part Search as a tab (`goatcad://parts`) with Universal / DigiKey / Mouser modes, DigiKey
category browse, the server-side filter strip, applied-filter chips, quantity-aware price breaks,
paging and sorting in the distributor modes, and main-side thumbnails.

The agent ops never merge catalogs: `parts_search` searches one distributor, `parts_compare_mpn`
sets one exact MPN's rows side by side, and grouping (`partsGroup.ts`) serves only Universal mode.

The tab is read-only: it can open a product page or a datasheet URL externally and nothing else.
Nothing in the GUI writes a part onto a component, saves a datasheet, or saves a 3D model.

## API terms — they bind every surface here

Both agreements (Mouser Search API ToS, DigiKey API User Agreement) were read in full.

- **No persistence of distributor content.** Price, stock, descriptions, parameters and images live
  in memory for the life of a result set; never on disk, never a database, no bulk walk of a
  category. Our own request counter persists; so does what the user deliberately writes into their
  own design or project folder.
- **Manufacturer facts are ours to keep; distributor content is not.** MPN, manufacturer, package
  and the datasheet originate with the manufacturer. An order code, price, stock, product page and
  photo belong to the distributor. A bind writes manufacturer facts; an order code is written only
  when the user picks that distributor's offer, one part at a time.
- **Attribute on the surface, keep the link.** Every row of distributor data names its distributor
  and keeps a working product link. Photos are resized proportionally, never cropped or overlaid.
  A distributor's logo comes from their asset kit unmodified; it is not a UI glyph and is not
  redrawn into `icons.ts`.
- **Aggregate with distinction.** The manufacturer part is the row; each distributor's offers sit in
  their own labeled compartment. Never a merged "best price".
- **Agent use is not treated as third-party disclosure.** Bulk export, feeding an aggregator or
  building a derivative catalog stay out.
- **Mouser forbids published screenshots of its data without written consent** — this lands on
  `web/`, the docs and the tutorial, not the app. Mouser also reviews each enrollment; the setup
  card must not promise approval.
- **Never ship GoatCAD's own keys.** Bring-your-own-key is the design. Every call is user-initiated;
  nothing is sent in the background.

## Design for the open work

- **One engine.** Bind, datasheet cache and model cache already exist behind the MCP ops; the GUI
  calls the same code, never a second implementation.
- **Bind writes plain KiCad properties** through the command layer and the AST: `MPN`,
  `Manufacturer`, `Datasheet` (a URL, or the `${KIPRJMOD}` path of a cached copy). `LCSC` and a
  distributor order code are ordinary properties. `fabBom.ts` already resolves these, so the fab BOM
  needs no change. Re-binding a component whose MPN is non-empty shows the change and asks.
- **Datasheet and model caching are main-only today** (`partsMcpDatasheetStore.ts`,
  `partsMcpModelStore.ts`, injected on `OpContext`). A GUI button needs a preload channel for each —
  the four-site change of RULES.md §9 — over the same stores, so provenance
  (`datasheets/index.json`, the `.3dshapes` manifest) is written identically whoever asked.
- **CAD assets are a hand-off.** Neither API serves a model file: DigiKey's `EDA Models` media
  entry is a URL to a vendor web page, Mouser has none. `parts:cad` returns it. The route for a
  downloaded library is the existing `AddLibraryDialog` import.
- **Spec filters stay per-distributor.** The two taxonomies are not mapped onto each other; a lossy
  mapping produces confidently wrong specs. Universal offers only what both APIs implement. Sorting
  is offered only where the API sorts (DigiKey); Universal never sorts or pages a merged sample.
- **A query normalizer rewrites, never filters.** Engineer shorthand to what a catalog indexes
  (`100n 0402` → `100nF 0402`, `4u7 16v` → `4.7uF 16V`, `10k 1% 0603` → `10 kOhm 1% 0603`). Pure and
  unit-tested; shows what it sent with a one-click "use exactly what I typed"; unrecognized tokens
  pass through verbatim. RKM codes are the high-value case.

## Open, in order

1. **Bind a part from search to a symbol** — from a Part Search row onto the selected component(s)
   of the open schematic, through the path `schematic_bind` uses.
2. **Cache datasheet button** — preload channel over `partsMcpDatasheetStore.ts`; opening a
   datasheet resolves the project copy first, then the URL.
3. **Cache 3D model from the UI** — preload channel over `partsMcpModelStore.ts`, a file picker or a
   URL, the same `source` provenance.
4. **CAD hand-off wiring** — call `parts:cad` from a result row ("Open CAD model page"; the
   `parts.cad*` strings exist and are unused) and put **Import downloaded library…** beside it,
   opening `AddLibraryDialog`.
5. **Land-pattern wizard** — a form over `footprint.compute_land_pattern` and `footprint.create`
   (ARCHITECTURE §3.10), so New Footprint can start from a package drawing instead of blank.
6. **Query normalizer** (above).
7. **Quota in the tab** — show remaining calls in Part Search once low; today only Settings shows it.
8. **`/privacy` section on `web/`** — part search is the feature that sends design information (a
   searched part number) off the machine; say what is sent, to whom, and that it is user-initiated.
9. **Package-versus-footprint cross-check** — warn where a bound part's distributor package
   disagrees with the assigned footprint; the Component view is the natural home.
10. **Hide a facet that cannot narrow** — one value whose count equals the total. Safe now that
    chips exist to remove an applied filter.

## The maintainer's call

- **An LCSC provider** (not a launch item). LCSC's official API is B2B-gated (business license),
  so it is unavailable to a bring-your-own-key audience. The EasyEDA endpoints every open tool uses
  are unofficial and may close; they are also the only programmatic route to LCSC footprints and
  models, which would need a converter to `.kicad_sym` / `.kicad_mod` round-tripped through our own
  parser. The lower-risk alternative is LCSC numbers typed in, as today.
- **Nexar/Octopart** as a paid universal layer — the only route to spec filters across
  distributors.
- **Mouser screenshot consent** before goatcad.com, the docs or the tutorial show Mouser data.

## Unverified

Mouser's quota numbers (`PROVIDER_INFO.mouser.quota`) and registration deep link; `safeStorage` on
each OS, in particular the Linux no-keyring branch that deliberately fails a save.
