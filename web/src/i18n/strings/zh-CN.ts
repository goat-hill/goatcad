import type { Strings } from './en'

export const zhCN = {
  meta: {
    homeTitle: 'AI 原生的 PCB 设计',
    tagline: '现代化、AI 原生的电路板设计工作台。',
    description:
      '{product} 是现代化、AI 原生的电路板设计工作台。与 Claude Code 或 Codex 一起绘制原理图和电路板。',
    ogImageAlt: '{product} 的应用图标和字标，下方是标语：{tagline}'
  },
  nav: {
    skip: '跳到正文',
    home: '{product} 首页',
    main: '主导航',
    footer: '页脚',
    docs: '文档',
    blog: '博客',
    soon: '即将推出',
    privacy: '隐私',
    language: '语言'
  },
  download: {
    downloadFor: '下载 {platform} 版',
    version: '版本 {version}',
    comingSoon: '即将支持 macOS、Windows 和 Linux',
    available: '支持 macOS、Windows 和 Linux',
    share: '发送到你的电脑'
  },
  showcase: {
    heading: '你会爱上的 PCB 设计工具。',
    lede: '{product} 将原理图、布局和库管理整合进同一个 IDE。可视化的 git 差异让你清楚看到设计每次修订改了什么。内置 DigiKey 和 Mouser 元件搜索，以及 CircuitHub 和 JLCPCB 制造配置，从选型到导出生产文件一气呵成。',
    altPcb:
      '在 {product} 的 PCB 编辑器中打开的四层板：装配视图的元件本体下方是各铜层，右侧是选中按键开关的属性和完整的层列表。',
    altSchematic:
      '同一窗口切换到原理图标签页：原理图编辑器中打开了一张 DisplayPort 图纸，选中了一个 MOSFET，左侧是项目树和图纸层级。',
    alt3d: '同一块电路板的 3D 预览：阻焊、丝印和每个元件的 3D 模型，右侧是 3D 层和元件的开关。'
  },
  agent: {
    heading: '和 Claude 一起，把想法变成电路。',
    lede: '自带你的智能体：Claude Code 或 Codex，用你现有的订阅即可。在 {product} 中，它会从 DigiKey 和 Mouser 挑选有货的元件，阅读数据手册，绘制任何库里都没有的符号，并在你身边完成原理图连线。',
    window: '分成两栏的 {product}：左边是原理图，右边是 Claude Code 正在为它添加一个 3.3 V 稳压器',
    sheet: '随着智能体搭建逐步绘出的稳压器原理图',
    prompt: '加一个 TLV76733 LDO，从 5V 电源轨得到 3.3V',
    sayPlan: '我会在 +5V 电源轨上放一个 TLV76733 来输出 +3.3V。先查元件和它的数据手册。',
    sayDraw:
      '没有库包含这个元件，所以我来画：IN 和 EN 在左侧，OUT 和 SNS 在右侧，GND 在下方。散热焊盘叠放在 GND 上，NC 保持悬空。',
    sayDone:
      '已添加 U1（新的 TLV76733DRVT 符号），以及 1 µF 的 C1 和 C2，DigiKey 和 Mouser 均有现货。数据手册已缓存到项目中，整个改动可一步撤销，尚未保存。'
  },
  pitch: {
    heading: '原生兼容 KiCad 项目。',
    lede: '{product} 直接使用 KiCad 久经考验的文件格式。打开并编辑现有项目，兼容性丝毫不受影响。即将支持从 Altium 等工具导入。',
    schematic: '原理图',
    board: '电路板布局',
    footprint: '封装',
    symbolLibrary: '符号库'
  }
} satisfies Strings
