---
name: localize
description: Translate GoatCAD's UI strings — clear the missing-translation debt that `npm run test:i18n` reports, add a new language, or add/change an English string correctly. Use when asked to localize, translate, fix i18n test failures, or add a locale.
---

# Localize GoatCAD

All renderer UI strings live in `electron/src/renderer/src/locales/<locale>/*.yaml`,
one file per component-cluster namespace, assembled by `<locale>/index.ts`.
`en` is the source of truth; every other locale mirrors its key set exactly.
Read `docs/localization-next-steps.md` for the standing decisions before
making judgement calls — it records what was deliberately *not* localized and why.

Two suites, two questions:

| Suite | Command | Asks |
| --- | --- | --- |
| `messages.test.ts` | `./electron/bin/test` (every commit) | Is any message *malformed*, in any locale? |
| `messages.completeness.test.ts` | `./electron/bin/test-i18n` (release gate) | Is every locale *finished*? |

An untranslated key is not a bug — vue-i18n falls back to `en`. So debt
accumulates silently between releases, and clearing it is this skill's main job.

## A. Clear the translation debt (the usual task)

1. `cd electron && ./bin/test-i18n`. The failure names every key, per locale,
   under `missing` (en has it, the locale doesn't) and `orphaned` (the locale
   has it, en doesn't).
2. For each **missing** key, read the English value *with its comments* —
   `locales/en/*.yaml` carries translator context as YAML comments explaining
   what a string actually means (which "Start", noun vs verb, column width).
   That context is the whole point; do not translate the bare string.
3. For each **orphaned** key, work out whether it is a *rename* (en moved
   `sidebar.components.*` → `sidebar.partManager.*`: port the wording across)
   or a *deletion* (drop it). Never keep an orphan to silence the diff.
4. If a whole namespace is missing, create `locales/<locale>/<namespace>.yaml`
   **and** add its import + entry to `locales/<locale>/index.ts`. Missing the
   index entry does not fail the tests — the suites read the directory via
   `import.meta.glob` — but the app will not show the translations.
5. Mirror en's key order and file structure; translated files carry no comments
   (that's the existing convention — the context lives in `en`).
6. Verify: `./bin/test-i18n` **and** `./bin/test` (see §D).

## B. Translation rules

- **Prefer KiCad's own `.po` for the target language** over a fresh translation
  for any ECAD term (net, footprint, via, pad, courtyard, silkscreen, aperture).
  Users switching from KiCad expect its vocabulary, right or wrong.
- **Plural branch counts follow CLDR, not English.** A message with `|` must
  have exactly `pluralBranchCount(locale)` branches: en/de 2, ja 1, fr 3, ru 4,
  ar 6. There is no zero branch in en/de — express a zero case as its own key.
- **`|` is the plural separator.** Never use it as punctuation. A literal pipe
  is `{'|'}`.
- **No `${…}`** in a message: vue-i18n reads `{…}` as a placeholder. Pass such
  tokens (e.g. KiCad's `${KICAD10_3DMODEL_DIR}`) in as an interpolated value.
- **Never translate**: KiCad layer codes (`F.Cu`), format strings for
  coordinates/dimensions (`X: {x} Y: {y} (mm)` stays dot-decimal — the values
  round-trip into KiCad files), language endonyms in `LOCALE_NAMES`, or BOM
  field labels persisted into `.kicad_pro`.
- **Watch the false friends.** Identical English, different meaning — check
  which component renders the key before reusing a translation:
  `Start` (track point vs. Welcome heading), `Show` (verb vs. column header),
  `Close` (button vs. window control), `Via` (object vs. tool), `Text` (tool
  vs. property), `Footprint` (undo-label fragment vs. property label).
- **Respect the layout note in the comment.** Property-row labels render into a
  narrow fixed column; abbreviate rather than spell out.
- Keep trailing punctuation from en (`Preset:`) — French wants a narrow
  no-break space before a colon, so the punctuation belongs to the translator.

## C. Other jobs

**Adding an English string.** Put it in the namespace of the component that
renders it, with a comment saying what it means when the word is ambiguous.
Do not translate it — the dev flow is English-only by design. Share a key
across components **only if a single component renders it** (see
`docs/localization-next-steps.md`).

**Adding a locale `xx`.** Four edits, all of which the tests check:
1. `locales/xx/*.yaml` + `locales/xx/index.ts` (copy en's structure).
2. Register in `i18n.ts`'s `messages` map — plural rules derive from it.
3. Add the endonym to `LOCALE_NAMES` in `i18n.ts` ("Deutsch", not "German").
4. Add to `SUPPORTED_LOCALES` in `src/main/appConfig.ts` (main validates the
   persisted `locale` and cannot import the renderer).

**Main-process strings** (native `dialog.*` titles in `src/main/index.ts`) are
outside vue-i18n. Use a mirrored message table in main keyed off
`AppConfig.locale` — not an IPC round-trip, which races on startup.

## D. Verify before landing

From `electron/`:

```bash
./bin/test-i18n   # completeness: every locale finished
./bin/test        # correctness: shape, plurals, key resolution, locale-list drift
./bin/pre-cm-checks   # format + lint + typecheck + test (the RULES.md pre-commit gate)
```

`bin/pre-cm-checks` runs prettier over the YAML — run it, don't hand-align.
A third completeness check fails if a namespace is byte-identical to English
(the sign of a copy-pasted stub), so genuinely-identical short files are fine
only under 5 keys.
