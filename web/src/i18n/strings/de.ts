import type { Strings } from './en'

export const de = {
  meta: {
    homeTitle: 'KI-natives Leiterplattendesign',
    tagline: 'Die moderne, KI-native Werkbank für Leiterplattendesign.',
    description:
      '{product} ist eine moderne, KI-native Werkbank für Leiterplattendesign. Zeichnen Sie Schaltpläne und Platinen gemeinsam mit Claude Code oder Codex.',
    ogImageAlt: 'App-Symbol und Schriftzug von {product} über dem Slogan: {tagline}'
  },
  nav: {
    skip: 'Zum Inhalt springen',
    home: '{product} – Startseite',
    main: 'Hauptnavigation',
    footer: 'Fußzeile',
    docs: 'Doku',
    blog: 'Blog',
    soon: 'bald',
    privacy: 'Datenschutz',
    language: 'Sprache'
  },
  download: {
    downloadFor: 'Für {platform} herunterladen',
    version: 'Version {version}',
    comingSoon: 'Bald für macOS, Windows und Linux',
    available: 'Verfügbar für macOS, Windows und Linux',
    share: 'An Ihren Computer senden'
  },
  showcase: {
    heading: 'Ihr neues Lieblingswerkzeug für Leiterplattendesign.',
    lede: '{product} vereint Schaltplan, Layout und Bibliotheksverwaltung in einer IDE. Visuelle Git-Diffs zeigen genau, was sich in jeder Revision Ihres Designs geändert hat. Bauteilsuche bei DigiKey und Mouser sowie Fertigungsprofile für CircuitHub und JLCPCB sind eingebaut – von der Bauteilauswahl bis zum Export für die Fertigung.',
    altPcb:
      '{product} mit einer vierlagigen Platine im Platineneditor – Kupferlagen unter den Bauteilkörpern der Bestückungsansicht, rechts ein ausgewählter Taster mit seinen Eigenschaften und die vollständige Lagenliste.',
    altSchematic:
      'Dasselbe Fenster im Schaltplan-Tab – ein DisplayPort-Blatt im Schaltplaneditor mit ausgewähltem MOSFET, links Projektbaum und Blatthierarchie.',
    alt3d:
      'Dieselbe Platine in der 3D-Vorschau – Lötstopplack, Bestückungsdruck und das 3D-Modell jedes Bauteils, rechts die Schalter für 3D-Lagen und Bauteile.'
  },
  agent: {
    heading: 'Machen Sie mit Claude aus Ideen Schaltungen.',
    lede: 'Bringen Sie Ihren eigenen Agenten mit: Claude Code oder Codex, mit dem Abo, das Sie schon haben. In {product} wählt er lieferbare Bauteile bei DigiKey und Mouser aus, liest ihre Datenblätter, zeichnet die Symbole, die keine Bibliothek hat, und verdrahtet den Schaltplan direkt neben Ihnen.',
    window:
      '{product} zweigeteilt: links ein Schaltplan, rechts Claude Code, das ihm einen 3,3-V-Regler hinzufügt',
    sheet: 'Der Reglerschaltplan, gezeichnet, während der Agent ihn aufbaut',
    prompt: 'füge einen TLV76733-LDO hinzu, der aus der 5V-Schiene 3.3V macht',
    sayPlan:
      'Ich setze einen TLV76733 an die +5V-Schiene für +3.3V. Zuerst das Bauteil und sein Datenblatt.',
    sayDraw:
      'Keine Bibliothek hat dieses Bauteil, also zeichne ich es: IN und EN links, OUT und SNS rechts, GND unten. Das Thermal-Pad liegt auf GND; NC bleibt offen.',
    sayDone:
      'U1 mit neuem TLV76733DRVT-Symbol hinzugefügt, dazu C1 und C2 mit 1 µF, alle bei DigiKey und Mouser lieferbar. Das Datenblatt liegt im Projekt, und alles ist ein einziger Rückgängig-Schritt, noch nicht gespeichert.'
  },
  pitch: {
    heading: 'Nativ kompatibel mit KiCad-Projekten.',
    lede: '{product} verwendet das bewährte Dateiformat von KiCad. Öffnen und bearbeiten Sie bestehende Projekte, ohne die Kompatibilität zu verlieren. Import aus Altium und weiteren Tools folgt in Kürze.',
    schematic: 'Schaltplan',
    board: 'Platinenlayout',
    footprint: 'Footprint',
    symbolLibrary: 'Symbolbibliothek'
  }
} satisfies Strings
