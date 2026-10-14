/**
 * The interface presets' data (`interfacePresets.ts` plans them): each
 * interface's impedance and budgets, every number with the source it was read
 * from. Values are the sources' own, in their units; where sources disagree the
 * note on the value says which was taken. A chip vendor's guide for the part on
 * the board wins over these, and the rules a preset writes are plain KiCad, so
 * they are edited as any other.
 */

/** A page a value was read from. */
export interface PresetSource {
  title: string
  url: string
  /** Where on the page: a section, table or page number. */
  where: string
}

/** A number and the key of the source it came from. */
export interface Sourced {
  value: number
  source: string
}

export type PresetRuleKind =
  'skewWithinPairs' | 'skewAcrossClass' | 'uncoupled' | 'viaCount' | 'length'

/** One custom rule a mode writes for its class. */
export interface PresetRule {
  kind: PresetRuleKind
  max: Sourced
  /** As the source gives it; KiCad reads mil, mm and ps alike. */
  unit: 'mm' | 'mil' | 'ps' | 'count'
}

/** A way the interface runs (USB's High and Full Speed), each its own budget. */
export interface PresetMode {
  id: string
  /** Ohms: a pair's differential impedance, or a single line's. */
  impedance: Sourced
  /** Percent either side of the target. */
  tolerance?: Sourced
  /**
   * Hold no impedance, against the standard: the class keeps the board's
   * ordinary sizes and takes no tuning profile, only rules. Ours, offered
   * beside the standard's mode, never in its place.
   */
  uncontrolled?: true
  /** A coplanar line's design frequency, Hz: the calculator's model is dispersive. */
  frequencyHz?: number
  rules: PresetRule[]
}

export interface InterfacePreset {
  id: string
  /** The interface's own name, untranslated. */
  name: string
  type: 'single' | 'differential'
  /** `line`: KiCad's microstrip and stripline; `coplanar`: a surface line with ground beside it. */
  model: 'line' | 'coplanar'
  /** The class name the dialog offers first. */
  className: string
  defaultMode: string
  modes: PresetMode[]
  sources: Record<string, PresetSource>
}

const SPRAAR7: PresetSource = {
  title: 'TI SPRAAR7J, High-Speed Interface Layout Guidelines',
  url: 'https://www.ti.com/lit/an/spraar7j/spraar7j.pdf',
  where: 'Appendix A, Tables A-1 to A-8'
}

const SNLA387: PresetSource = {
  title: 'TI SNLA387, Ethernet PHY PCB Design Layout Checklist',
  url: 'https://www.ti.com/lit/an/snla387/snla387.pdf',
  where: '§2'
}

/** The Ethernet presets' two speeds and the matching each holds, mil (SNLA387 §2). */
const ETHERNET_SPEEDS: ReadonlyArray<[string, number]> = [
  ['1g', 20],
  ['100m', 50]
]

export const INTERFACE_PRESETS: readonly InterfacePreset[] = [
  {
    id: 'usb2',
    name: 'USB 2.0',
    type: 'differential',
    model: 'line',
    className: 'USB',
    defaultMode: 'high',
    modes: [
      {
        id: 'high',
        impedance: { value: 90, source: 'usb' },
        // The spec's ±15% is the cable's; board guides hold the trace to ±10%.
        tolerance: { value: 10, source: 'ti' },
        rules: [
          { kind: 'skewWithinPairs', max: { value: 50, source: 'ti' }, unit: 'mil' },
          { kind: 'viaCount', max: { value: 4, source: 'ti' }, unit: 'count' },
          { kind: 'length', max: { value: 12000, source: 'ti' }, unit: 'mil' }
        ]
      },
      {
        id: 'full',
        impedance: { value: 90, source: 'usbFull' },
        tolerance: { value: 15, source: 'usbFull' },
        rules: [{ kind: 'skewWithinPairs', max: { value: 2.5, source: 'renesasFs' }, unit: 'mm' }]
      },
      {
        // 12 Mb/s edges span far more than a board's trace, so a thick two-layer
        // board may route at its ordinary sizes rather than the spec's 90 Ω widths.
        id: 'full-uncontrolled',
        impedance: { value: 90, source: 'usbFull' },
        uncontrolled: true,
        rules: [{ kind: 'skewWithinPairs', max: { value: 2.5, source: 'renesasFs' }, unit: 'mm' }]
      }
    ],
    sources: {
      usb: {
        title: 'USB 2.0 Specification',
        url: 'https://www.usb.org/sites/default/files/usb_20_20211008.zip',
        where: '§7.1.1.3, board traces of nominal 90 Ω differential'
      },
      usbFull: {
        title: 'USB 2.0 Specification',
        url: 'https://www.usb.org/sites/default/files/usb_20_20211008.zip',
        where: '§7.1.6.1, the full-speed line 90 Ω ±15%'
      },
      ti: SPRAAR7,
      renesasFs: {
        title: 'Renesas R01AN0628EJ, Guidelines for Full-Speed USB2.0 Board Design',
        url: 'https://renesas.com/en/document/apn/full-speed-usb-guidelines-full-speed-usb20-board-design-rev100',
        where: 'Table 2, D+/D− length difference'
      }
    }
  },
  {
    id: 'rf-50',
    name: '50 Ω RF feed',
    type: 'single',
    model: 'coplanar',
    className: 'RF',
    defaultMode: '2g4',
    // The fence and the gap under the dielectric height are layout, not rules: the notes say so.
    modes: [
      ['sub1g', 0.9e9],
      ['2g4', 2.45e9],
      ['5g', 5.5e9]
    ].map(([id, hz]) => ({
      id: id as string,
      impedance: { value: 50, source: 'infineon' },
      frequencyHz: hz as number,
      rules: []
    })),
    sources: {
      infineon: {
        title: 'Infineon AN91445, Antenna Design and RF Layout Guidelines',
        url: 'https://www.infineon.com/dgdl/Infineon-AN91445_Antenna_Design_and_RF_Layout_Guidelines-ApplicationNotes-v09_00-EN.pdf',
        where:
          '§16.3 a 50 Ω coplanar line, its gap under the substrate height; §20 via pitch at most λ/20'
      }
    }
  },
  {
    id: 'csi2',
    name: 'MIPI CSI-2 (D-PHY)',
    type: 'differential',
    model: 'line',
    className: 'CSI',
    defaultMode: '2g5',
    // Lane-to-clock skew is 0.075 UI (AMD UG863 Table 2), so it scales with the line rate.
    modes: [
      ['1g0', 75],
      ['1g5', 50],
      ['2g5', 30]
    ].map(([id, ps]) => ({
      id: id as string,
      impedance: { value: 100, source: 'amd' },
      tolerance: { value: 10, source: 'amd' },
      rules: [
        { kind: 'skewWithinPairs', max: { value: 2, source: 'amd' }, unit: 'ps' },
        { kind: 'skewAcrossClass', max: { value: ps as number, source: 'amdRates' }, unit: 'ps' },
        { kind: 'viaCount', max: { value: 2, source: 'ti' }, unit: 'count' }
      ]
    })),
    sources: {
      amd: {
        title: 'AMD UG863, Versal PCB Design: MIPI D-PHY',
        url: 'https://docs.amd.com/r/en-US/ug863-versal-pcb-design/MIPI-D-PHY',
        where: 'Table 1, 100 Ω ±10% and ±2 ps within a pair'
      },
      amdRates: {
        title: 'AMD UG863, Versal PCB Design: MIPI D-PHY',
        url: 'https://docs.amd.com/r/en-US/ug863-versal-pcb-design/MIPI-D-PHY',
        where: 'Table 2, clock-to-data skew 0.075 UI by line rate'
      },
      ti: { ...SPRAAR7, where: 'Tables A-7 and A-8, CSI vias per trace' }
    }
  },
  {
    id: 'ethernet-mdi',
    name: 'Ethernet MDI',
    type: 'differential',
    model: 'line',
    className: 'ETH',
    defaultMode: '1g',
    // The checklist matches "the traces" without saying across pairs; within each pair it holds either way.
    modes: ETHERNET_SPEEDS.map(([id, mil]) => ({
      id,
      impedance: { value: 100, source: 'ti' },
      tolerance: { value: 10, source: 'ti' },
      rules: [
        { kind: 'skewWithinPairs', max: { value: mil, source: 'ti' }, unit: 'mil' },
        { kind: 'length', max: { value: 2000, source: 'ti' }, unit: 'mil' }
      ]
    })),
    sources: {
      ti: {
        ...SNLA387,
        where:
          '§2 MDI Traces: 100 Ω ±10% differential, matched within 20 mil (1G) or 50 mil (10/100M), under 2000 mil'
      }
    }
  },
  {
    id: 'rgmii',
    name: 'Ethernet MII / RGMII',
    type: 'single',
    model: 'line',
    // TX and RX are matched apart: a class each, the preset applied to each.
    className: 'RGMII_TX',
    defaultMode: '1g',
    modes: ETHERNET_SPEEDS.map(([id, mil]) => ({
      id,
      impedance: { value: 50, source: 'ti' },
      tolerance: { value: 10, source: 'ti' },
      rules: [
        { kind: 'skewAcrossClass', max: { value: mil, source: 'ti' }, unit: 'mil' },
        { kind: 'length', max: { value: 6000, source: 'ti' }, unit: 'mil' }
      ]
    })),
    sources: {
      ti: {
        ...SNLA387,
        where:
          '§2 MII Traces: 50 Ω ±10%, TX matched to TX and RX to RX within 20 mil (1G) or 50 mil (10/100M), under 6000 mil'
      }
    }
  }
]
