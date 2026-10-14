import { DESCRIPTION, HOME_TITLE, TAGLINE } from '../../brand'

/**
 * The landing page's English copy — the source every other language mirrors
 * (`satisfies Strings` makes a missing or extra key a type error under
 * `astro check`).
 *
 * `{product}` and the like are filled by `fmt()`; the product name is never
 * written into a string (brand.ts). Translations keep the spirit of a line over
 * its words where a literal rendering reads badly — marketing copy is adapted,
 * not transcribed. Spec-like facts (part numbers, vendors, file extensions) are
 * never adapted.
 */
export const en = {
  meta: {
    /** After the name in the home `<title>`; keep it short (search cuts ~60 chars). */
    homeTitle: HOME_TITLE,
    tagline: TAGLINE,
    /** Meta description; under ~160 chars. */
    description: DESCRIPTION,
    /** The OG card is English artwork, so its alt quotes the English tagline. */
    ogImageAlt: 'The {product} app icon and wordmark over the tagline: {tagline}'
  },
  nav: {
    skip: 'Skip to content',
    home: '{product} home',
    main: 'Main',
    footer: 'Footer',
    docs: 'Docs',
    blog: 'Blog',
    soon: 'soon',
    privacy: 'Privacy',
    /** Accessible name of the language switcher. */
    language: 'Language'
  },
  download: {
    downloadFor: 'Download for {platform}',
    version: 'Version {version}',
    comingSoon: 'Coming soon to macOS, Windows and Linux',
    /** On a phone, where nothing installs. */
    available: 'Available for macOS, Windows and Linux',
    share: 'Send to your computer'
  },
  showcase: {
    heading: 'Your new favorite PCB design tool.',
    lede: '{product} brings schematics, layout and library management into one IDE. Visual git diffs show exactly what changed in each revision of your design. DigiKey and Mouser part search and CircuitHub and JLCPCB fab profiles are built in, from choosing parts to exporting for fabrication.',
    altPcb:
      "{product} with a four-layer board open in the PCB editor — copper layers under the assembly overlay's part bodies, a push button selected with its properties and the full layer list on the right.",
    altSchematic:
      'The same window on the schematic tab — a display-port sheet open in the schematic editor with a MOSFET selected, project tree and sheet hierarchy on the left.',
    alt3d:
      "The same board in 3D preview — solder mask, silkscreen and every part's 3D model, with the 3D layer and component toggles on the right."
  },
  agent: {
    heading: 'Turn ideas into circuits with Claude.',
    lede: 'Bring your own agent: Claude Code or Codex, on the subscription you already have. Inside {product} it picks in-stock parts from DigiKey and Mouser, reads their datasheets, draws the symbols no library has, and wires the schematic right beside you.',
    window:
      '{product} split in two: a schematic on the left, Claude Code on the right adding a 3.3 V regulator to it',
    sheet: 'The regulator schematic, drawn as the agent builds it',
    /*
     * The demo turn. The prompt and the agent's own sentences are in the
     * reader's language, as the agent answers in the language it is asked in;
     * tool calls and their results stay English, because that is what the app
     * returns. Net names (+5V, +3.3V), pins and part numbers never translate.
     */
    prompt: 'add a TLV76733 LDO to make 3.3V from the 5V rail',
    sayPlan: "I'll put a TLV76733 on the +5V rail for +3.3V. First the part and its datasheet.",
    sayDraw:
      "No library has this part, so I'll draw it: IN and EN on the left, OUT and SNS on the right, GND below. The thermal pad stacks on GND; NC stays off.",
    sayDone:
      "Added U1 with a new TLV76733DRVT symbol, and C1 and C2 at 1 µF, all in stock at DigiKey and Mouser. The datasheet is cached in the project, and it's one undo step, not saved yet."
  },
  pitch: {
    heading: 'Native compatibility with KiCad projects.',
    lede: "{product} uses KiCad's existing and well-tested file format. Open and edit existing projects while preserving compatibility. Import from Altium and others coming soon.",
    schematic: 'Schematic',
    board: 'Board layout',
    footprint: 'Footprint',
    symbolLibrary: 'Symbol library'
  }
}

type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> }

/** Every language's copy has exactly en's keys. */
export type Strings = Shape<typeof en>
