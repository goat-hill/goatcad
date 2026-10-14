import type { Strings } from './en'

export const ja = {
  meta: {
    homeTitle: 'AIネイティブな基板設計',
    tagline: 'AIネイティブで、モダンな基板設計環境。',
    description:
      '{product}は、AIネイティブでモダンな基板設計環境です。Claude CodeやCodexと一緒に、回路図と基板を設計できます。',
    ogImageAlt: '{product}のアプリアイコンとロゴ、その下にキャッチコピー：{tagline}'
  },
  nav: {
    skip: 'コンテンツへスキップ',
    home: '{product} ホーム',
    main: 'メイン',
    footer: 'フッター',
    docs: 'ドキュメント',
    blog: 'ブログ',
    soon: '近日公開',
    privacy: 'プライバシー',
    language: '言語'
  },
  download: {
    downloadFor: '{platform}版をダウンロード',
    version: 'バージョン {version}',
    comingSoon: 'macOS、Windows、Linux向けに近日公開',
    available: 'macOS、Windows、Linuxに対応',
    share: 'パソコンに送る'
  },
  showcase: {
    heading: 'PCB設計の、新しい定番ツール。',
    lede: '{product}は、回路図、レイアウト、ライブラリ管理をひとつのIDEにまとめます。ビジュアルなgit差分で、設計のリビジョンごとに何が変わったかが一目でわかります。DigiKeyとMouserの部品検索、CircuitHubとJLCPCBの製造プロファイルを内蔵し、部品選定から製造データの出力まで完結します。',
    altPcb:
      '{product}のPCBエディターで4層基板を開いたところ。組立図オーバーレイの部品ボディの下に導体層が見え、右側には選択したタクトスイッチのプロパティと全レイヤーの一覧があります。',
    altSchematic:
      '同じウィンドウの回路図タブ。回路図エディターでDisplayPortのシートを開き、MOSFETを選択した状態。左側にプロジェクトツリーとシート階層があります。',
    alt3d:
      '同じ基板の3Dプレビュー。ハンダマスク、シルクスクリーン、すべての部品の3Dモデルが表示され、右側に3Dレイヤーと部品の表示切り替えがあります。'
  },
  agent: {
    heading: 'Claudeで、アイデアを回路に。',
    lede: 'いつものエージェントを、そのまま。Claude CodeでもCodexでも、今お使いのサブスクリプションで動きます。{product}の中で、DigiKeyとMouserから在庫のある部品を選び、データシートを読み、どのライブラリにもないシンボルを描き、あなたのすぐ隣で回路図を配線します。',
    window:
      '2分割された{product}。左に回路図、右でClaude Codeが3.3 Vレギュレーターを追加しているところ',
    sheet: 'エージェントが組み立てていくレギュレーターの回路図',
    prompt: '5Vレールから3.3Vを作るTLV76733 LDOを追加して',
    sayPlan: '+5Vレールに TLV76733 を置いて +3.3V を作ります。まず部品とデータシートを確認します。',
    sayDraw:
      'この部品はどのライブラリにもないので、シンボルを描きます。左に IN と EN、右に OUT と SNS、下に GND。サーマルパッドは GND に重ね、NC は未接続のままにします。',
    sayDone:
      'U1 を新しい TLV76733DRVT シンボルで追加し、C1 と C2 に 1 µF を配置しました。どれも DigiKey と Mouser に在庫があります。データシートはプロジェクトにキャッシュ済みで、変更は1回の「元に戻す」で取り消せます。まだ保存していません。'
  },
  pitch: {
    heading: 'KiCadプロジェクトとネイティブ互換。',
    lede: '{product}は、実績あるKiCadのファイル形式をそのまま使います。互換性を保ったまま、既存のプロジェクトを開いて編集できます。Altiumなどからのインポートにも近日対応予定です。',
    schematic: '回路図',
    board: '基板レイアウト',
    footprint: 'フットプリント',
    symbolLibrary: 'シンボルライブラリ'
  }
} satisfies Strings
