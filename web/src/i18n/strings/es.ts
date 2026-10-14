import type { Strings } from './en'

export const es = {
  meta: {
    homeTitle: 'Diseño de PCB con la IA integrada',
    tagline: 'El entorno moderno de diseño de placas de circuito, con la IA en su núcleo.',
    description:
      '{product} es un entorno moderno de diseño de placas de circuito, con la IA en su núcleo. Dibuje esquemas y placas junto a Claude Code o Codex.',
    ogImageAlt: 'El icono y el logotipo de {product} sobre el lema: {tagline}'
  },
  nav: {
    skip: 'Saltar al contenido',
    home: 'Inicio de {product}',
    main: 'Principal',
    footer: 'Pie de página',
    docs: 'Documentación',
    blog: 'Blog',
    soon: 'pronto',
    privacy: 'Privacidad',
    language: 'Idioma'
  },
  download: {
    downloadFor: 'Descargar para {platform}',
    version: 'Versión {version}',
    comingSoon: 'Próximamente para macOS, Windows y Linux',
    available: 'Disponible para macOS, Windows y Linux',
    share: 'Enviar a su computadora'
  },
  showcase: {
    heading: 'Su nueva herramienta favorita para diseñar PCB.',
    lede: '{product} reúne esquemas, diseño de placa y gestión de bibliotecas en un solo IDE. Los diffs visuales de git muestran exactamente qué cambió en cada revisión de su diseño. La búsqueda de componentes en DigiKey y Mouser y los perfiles de fabricación de CircuitHub y JLCPCB vienen integrados, desde elegir los componentes hasta exportar para fabricación.',
    altPcb:
      '{product} con una placa de cuatro capas abierta en el editor de PCB: capas de cobre bajo los cuerpos de los componentes de la vista de montaje, un pulsador seleccionado con sus propiedades y la lista completa de capas a la derecha.',
    altSchematic:
      'La misma ventana en la pestaña del esquema: una hoja de DisplayPort abierta en el editor de esquemas con un MOSFET seleccionado, y el árbol del proyecto y la jerarquía de hojas a la izquierda.',
    alt3d:
      'La misma placa en vista previa 3D: máscara de soldadura, serigrafía y el modelo 3D de cada componente, con los conmutadores de capas 3D y de componentes a la derecha.'
  },
  agent: {
    heading: 'Convierta sus ideas en circuitos con Claude.',
    lede: 'Traiga su propio agente: Claude Code o Codex, con la suscripción que ya tiene. Dentro de {product} elige componentes en stock de DigiKey y Mouser, lee sus hojas de datos, dibuja los símbolos que ninguna biblioteca tiene y cablea el esquema justo a su lado.',
    window:
      '{product} dividido en dos: un esquema a la izquierda y, a la derecha, Claude Code añadiéndole un regulador de 3,3 V',
    sheet: 'El esquema del regulador, dibujado a medida que el agente lo construye',
    prompt: 'agrega un LDO TLV76733 para sacar 3.3V del riel de 5V',
    sayPlan:
      'Pondré un TLV76733 en el riel de +5V para obtener +3.3V. Primero, el componente y su hoja de datos.',
    sayDraw:
      'Ninguna biblioteca tiene este componente, así que lo dibujaré: IN y EN a la izquierda, OUT y SNS a la derecha, GND abajo. El pad térmico se apila sobre GND; NC queda sin conectar.',
    sayDone:
      'Añadí U1 con un nuevo símbolo TLV76733DRVT, y C1 y C2 de 1 µF, todos en stock en DigiKey y Mouser. La hoja de datos queda guardada en el proyecto, y todo se deshace en un solo paso; aún no está guardado.'
  },
  pitch: {
    heading: 'Compatibilidad nativa con proyectos de KiCad.',
    lede: '{product} usa el formato de archivo de KiCad, probado y consolidado. Abra y edite proyectos existentes sin perder compatibilidad. Próximamente: importación desde Altium y otras herramientas.',
    schematic: 'Esquema',
    board: 'Diseño de placa',
    footprint: 'Huella',
    symbolLibrary: 'Biblioteca de símbolos'
  }
} satisfies Strings
