# Localization — state, rules, open work

The launch languages — `en`, `de`, `zh-CN`, `ja`, `fr`, `es` ([MILESTONES.md](./MILESTONES.md), Scope) —
ship, with a working language switcher; `ru`, `it`, `pt-BR`, `ko` and `pl` follow them. The technical layout is ARCHITECTURE.md's
"Localization (i18n)" section; the runbook for doing the work — clearing `test:i18n` debt, adding a
language, adding an English string, the translation rules — is the `localize` skill
(`.claude/skills/localize/SKILL.md`). This doc holds the standing decisions and what is open.

## Test policy

`./bin/test` requires **English only**; vue-i18n falls back to `en`, so an untranslated key is a
completeness gap, not a bug. `./bin/test-i18n` checks every locale is complete, and the release
workflow gates on it. The split is **correctness vs completeness**:

| Every commit (`messages.test.ts`) | Release only (`messages.completeness.test.ts`) |
|---|---|
| A malformed message in any locale | A locale missing keys `en` has |
| A wrong plural branch count | A locale with keys `en` lacks (orphans) |
| A key that resolves in no locale; an unmarked key literal | A namespace still byte-identical to English |
| Locale-list drift (renderer / main / picker) | |

`vitest.config.ts` and `vitest.i18n.config.ts` share `vitest.shared.ts` by object spread, because
`mergeConfig` concatenates arrays and an `exclude` cannot be undone through it. The accepted cost:
translation debt is invisible until release day.

## Open, in order

1. **Main-process strings.** Native dialog titles and filters in `src/main/index.ts` ('Open Project',
   'Open File', 'Select 3D Model', 'Save As', 'Choose a Folder for the New Project', …) are outside
   vue-i18n. Use a small mirrored message table in main keyed off `AppConfig.locale` — **not** an
   IPC round-trip: these dialogs are invoked from main, sometimes before a renderer is ready.
2. **Every non-English locale needs a native review** — each is a machine first pass, made against
   KiCad's own `.po` for that language. Structure is test-enforced; wording
   is not. Known-shaky in `de`: `schematicEditor.properties.unit`
   → "Einheit" (a symbol's sub-part, not a measurement); via → "DuKo"; `layerNames.fCrtYd`/`bCrtYd`
   → "Sperrfläche", which collides with `propertiesPanel.keepoutZone`;
   `itemTypes.noConnect` → "Nichtanschluss-Markierung".
3. **String smells — fix while they cost 1×, not N locales×.**
   - `shared.componentsTable.columnsButton` bakes a `▾` into the string; move the glyph to markup.
   - Lists joined with a hardcoded `', '` (`PartsView.vue`, `ManufactureView.vue`,
     `NewProjectDialog.vue`) — use `Intl.ListFormat`.
   - Trailing colons (`Preset:`) are correct as they are — French spaces the colon, so the
     punctuation belongs to the translator.
4. Run `test:i18n` non-blocking on pushes to the default branch, if release-day debt becomes a problem.

## Property-label sharing

**A key may be shared if and only if a single component renders it.** Sharing keys without unifying
the views is all of the coupling risk with none of the code win. Candidates once a shared component
renders them: `rotation, net, value, reference, type, points, size, drill` (cross-check KiCad's
`.po` first). Do **not** share section titles, hints, toolbar buttons or command/undo labels — that
is view voice, and where the false friends live:

| String | Two meanings |
|---|---|
| `Start` | track start point vs. the Welcome page heading |
| `Show` | layer visibility mode (verb) vs. table column header (noun) |
| `Close` | generic button vs. window control |
| `Via` | the object (properties section) vs. the tool (toolbar button) |
| `Text` | the add-text tool vs. a property's content |
| `Footprint` | undo-label fragment vs. property label |

## Known, deliberate non-goals

- **Coordinate and spacing readouts stay dot-decimal and fixed-format.** They round-trip into KiCad
  files and are parsed back from input; a decimal comma would be harmful. Counts and dates may localize.
- **Compile-time key safety is not achievable with vue-i18n — do not re-propose it.** Augmenting
  `DefineLocaleMessage` gives editor autocomplete only: every `t()` overload accepts
  `Key extends string`, so a typo'd key typechecks. The locale tests are the only thing catching bad
  keys and are load-bearing (with the `t()`/`tk()` marking rule, RULES.md §3).
- **No zero-special-case plural branches.** Branch order follows CLDR and `en` has no `zero`
  category; a zero case is its own message. Enforced by the branch-count test.
- KiCad layer codes (`F.Cu`, …) are never translated, only their descriptions (`shared.layerNames.*`).
- BOM field labels persisted into `.kicad_pro` stay English for portability; only the display layer
  translates known builtin fields.
- `lib/board/layerPresets.ts` takes a `label(key)` callback instead of importing vue-i18n, keeping
  the domain layer UI-free.
- **RTL** is not supported: no launch language needs it, and the frameless title bar and drag
  panels are not RTL-aware.
