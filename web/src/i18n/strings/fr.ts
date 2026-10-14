import type { Strings } from './en'

/*
 * French typography: a narrow no-break space (\u202f) before : ; ? ! — the
 * escape keeps it visible in source, where the character itself is not.
 */
export const fr = {
  meta: {
    homeTitle: 'Conception de circuits imprimés avec l’IA',
    tagline: 'L’atelier moderne de conception de circuits imprimés, pensé pour l’IA.',
    description:
      '{product} est un atelier moderne de conception de circuits imprimés, pensé pour l’IA. Dessinez vos schémas et vos circuits aux côtés de Claude Code ou Codex.',
    ogImageAlt: 'L’icône et le logotype de {product} au-dessus du slogan\u202f: {tagline}'
  },
  nav: {
    skip: 'Aller au contenu',
    home: 'Accueil {product}',
    main: 'Principale',
    footer: 'Pied de page',
    docs: 'Documentation',
    blog: 'Blog',
    soon: 'bientôt',
    privacy: 'Confidentialité',
    language: 'Langue'
  },
  download: {
    downloadFor: 'Télécharger pour {platform}',
    version: 'Version {version}',
    comingSoon: 'Bientôt sur macOS, Windows et Linux',
    available: 'Disponible sur macOS, Windows et Linux',
    share: 'Envoyer vers votre ordinateur'
  },
  showcase: {
    heading: 'Votre nouvel outil de CAO électronique préféré.',
    lede: '{product} réunit schéma, routage et gestion des bibliothèques dans un seul IDE. Des diffs git visuels montrent exactement ce qui a changé à chaque révision de votre conception. La recherche de composants DigiKey et Mouser et les profils de fabrication CircuitHub et JLCPCB sont intégrés, du choix des composants jusqu’à l’export pour la fabrication.',
    altPcb:
      '{product} avec un circuit imprimé à quatre couches ouvert dans l’éditeur de PCB — les couches cuivre sous les corps des composants de la vue d’assemblage, un bouton-poussoir sélectionné avec ses propriétés et la liste complète des couches à droite.',
    altSchematic:
      'La même fenêtre sur l’onglet schéma — une feuille DisplayPort ouverte dans l’éditeur de schéma, un MOSFET sélectionné, l’arborescence du projet et la hiérarchie des feuilles à gauche.',
    alt3d:
      'Le même circuit en aperçu 3D — masque de soudure, sérigraphie et le modèle 3D de chaque composant, avec les bascules de couches 3D et de composants à droite.'
  },
  agent: {
    heading: 'Transformez vos idées en circuits avec Claude.',
    lede: 'Apportez votre propre agent\u202f: Claude Code ou Codex, avec l’abonnement que vous avez déjà. Dans {product}, il choisit des composants en stock chez DigiKey et Mouser, lit leurs fiches techniques, dessine les symboles qu’aucune bibliothèque ne contient et câble le schéma juste à côté de vous.',
    window:
      '{product} partagé en deux\u202f: un schéma à gauche, et à droite Claude Code qui y ajoute un régulateur 3,3 V',
    sheet: 'Le schéma du régulateur, dessiné à mesure que l’agent le construit',
    prompt: 'ajoute un LDO TLV76733 pour faire du 3.3V à partir du rail 5V',
    sayPlan:
      'Je place un TLV76733 sur le rail +5V pour obtenir +3.3V. D’abord le composant et sa fiche technique.',
    sayDraw:
      'Aucune bibliothèque n’a ce composant, je vais donc le dessiner\u202f: IN et EN à gauche, OUT et SNS à droite, GND en bas. Le pad thermique s’empile sur GND\u202f; NC reste en l’air.',
    sayDone:
      'U1 ajouté avec un nouveau symbole TLV76733DRVT, ainsi que C1 et C2 de 1 µF, tous en stock chez DigiKey et Mouser. La fiche technique est en cache dans le projet, et le tout s’annule en une seule fois, pas encore enregistré.'
  },
  pitch: {
    heading: 'Compatible nativement avec les projets KiCad.',
    lede: '{product} utilise le format de fichier éprouvé de KiCad. Ouvrez et modifiez vos projets existants sans rien perdre en compatibilité. L’import depuis Altium et d’autres outils arrive bientôt.',
    schematic: 'Schéma',
    board: 'Circuit imprimé',
    footprint: 'Empreinte',
    symbolLibrary: 'Bibliothèque de symboles'
  }
} satisfies Strings
