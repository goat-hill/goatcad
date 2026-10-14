// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * How a list of names is ordered wherever one is shown: natural and
 * case-insensitive, so `R10` follows `R2` rather than preceding it and case
 * never splits one list into two runs.
 *
 * This is KiCad's own tree order: `LIB_TREE_NODE::AssignIntrinsicRanks`
 * (`common/lib_tree_model.cpp`) ranks a library's children with `StrNumCmp`,
 * which walks digit runs numerically, passing its `ignoreCase` flag. A symbol
 * list that mirrored FILE order instead would be wrong even for a file KiCad
 * wrote: its `.kicad_sym` is ordered by inheritance depth first (a derived
 * symbol always follows its parent), name second.
 *
 * Fixed to `en` rather than the app locale: the same library must list in the
 * same order for everyone, and an exported file's row order must not depend on
 * who exported it.
 */

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** Compare two names for display order. Ties keep their input order (sort is stable). */
export const compareNames = (a: string, b: string): number => collator.compare(a, b)
