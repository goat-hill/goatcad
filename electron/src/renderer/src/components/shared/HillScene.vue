<script setup lang="ts">
import { useId } from 'vue'
/*
 * The goat-hill motif (BRAND.md §3 Hero motif), ported by copy from the site's
 * web/src/components/art/HeroArt.astro — same ridges, parts, tower and goats,
 * placed by the same rules, and the same hover scenes (LED, lookout, speaker,
 * pot and night, tower, greeting goats). It is the Welcome tab's ground. The
 * app has a pointer, so it drops the site's tap-to-play script.
 *
 * Colors are mixed from the theme tokens rather than the site's golden-hour
 * literals, so the scene stays a muted backdrop in either theme.
 *
 * Geometry changes belong on the site first; keep the two in step.
 */

type Pt = [number, number]
type Seg = [number, number, number, number, number, number]
interface Ridge {
  start: Pt
  segs: Seg[]
}

const W = 1600
const H = 560
// Everything above this is empty sky (the masts top out at y ≈ 164, and the
// glow has faded to nothing by here), so the scene's box starts at it.
const VIEW_TOP = 100

// Gradient ids are document-global, and a split window can show two scenes.
const uid = useId()
const gid = (name: string): string => `hs-${uid}-${name}`
const paint = (name: string): string => `url(#${gid(name)})`

const far: Ridge = {
  start: [0, 322],
  segs: [
    [70, 312, 120, 282, 168, 258],
    [196, 244, 222, 238, 246, 250],
    [262, 258, 272, 266, 290, 262],
    [312, 252, 330, 236, 356, 244],
    [400, 258, 440, 300, 540, 316],
    [660, 336, 800, 330, 920, 322],
    [1040, 314, 1110, 290, 1200, 282],
    [1290, 274, 1360, 296, 1450, 300],
    [1520, 303, 1570, 296, 1600, 294]
  ]
}

const mid: Ridge = {
  start: [0, 398],
  segs: [
    [60, 386, 120, 356, 196, 348],
    [262, 341, 322, 356, 384, 376],
    [470, 404, 570, 424, 700, 426],
    [830, 428, 930, 410, 1010, 380],
    [1080, 354, 1140, 324, 1236, 318],
    [1316, 313, 1362, 326, 1420, 342],
    [1486, 360, 1552, 362, 1600, 360]
  ]
}

const near: Ridge = {
  start: [0, 474],
  segs: [
    [120, 458, 250, 452, 370, 462],
    [490, 472, 570, 492, 710, 494],
    [850, 496, 960, 478, 1060, 452],
    [1116, 437, 1166, 426, 1226, 428],
    [1296, 430, 1360, 448, 1440, 464],
    [1520, 478, 1570, 480, 1600, 480]
  ]
}

const ridgePath = (r: Ridge): string =>
  `M${r.start.join(' ')} ` +
  r.segs.map((s) => `C${s.slice(0, 2)} ${s.slice(2, 4)} ${s.slice(4)}`).join(' ')

const hill = (r: Ridge): string => `${ridgePath(r)} L${W} ${H} L0 ${H} Z`

// Dense polyline of a ridge, for looking up the surface height at any x.
const sample = (r: Ridge): Pt[] => {
  const pts: Pt[] = [r.start]
  let [x0, y0] = r.start
  for (const [x1, y1, x2, y2, x3, y3] of r.segs) {
    for (let i = 1; i <= 64; i++) {
      const t = i / 64
      const u = 1 - t
      pts.push([
        u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
      ])
    }
    ;[x0, y0] = [x3, y3]
  }
  return pts
}

const yAt = (pts: Pt[], x: number): number => {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]
    const [bx, by] = pts[i]
    if (x >= ax && x <= bx) return ay + ((x - ax) / (bx - ax)) * (by - ay)
  }
  return pts[pts.length - 1][1]
}

const farPts = sample(far)
const midPts = sample(mid)
const nearPts = sample(near)
const r1 = (n: number): number => Math.round(n * 10) / 10

interface Goat {
  cls: string
  x: number
  y: number
  scale: number
  pose: 'up' | 'graze'
  flip?: boolean
  // How long after dusk this goat nods off (ms), so they don't drop in unison.
  nap: number
}

const goatTransform = (g: Goat): string =>
  `translate(${r1(g.x)} ${r1(g.y)}) scale(${g.flip ? -g.scale : g.scale} ${g.scale})`

// Where a sleeping goat's z's rise from: just above its tucked head. Drawn
// outside the goat so a flipped goat doesn't mirror its z's.
const zzzAt = (g: Goat): string =>
  `translate(${r1(g.x + (g.flip ? -1 : 1) * 14 * g.scale)} ${r1(g.y - 30 * g.scale)}) scale(${r1(g.scale)})`

const on = (pts: Pt[], x: number, scale = 1): string =>
  `translate(${x} ${r1(yAt(pts, x))})${scale === 1 ? '' : ` scale(${scale})`}`

// Each part's outer extent [left, right] in local units, leads included; every
// neighbour in a scene sits exactly GAP past the previous part's edge.
type Extent = [number, number]
const GAP = 12
const EXTENT: Record<string, Extent> = {
  led: [-14, 14],
  resStanding: [-7, 11],
  fence: [-34, 34],
  pot: [-13, 13],
  transistor: [-8, 8],
  speaker: [-9, 16],
  can: [-24, 24],
  disc: [-11, 11]
}
const row = (cx: number, scale: number, parts: Extent[]): number[] => {
  const width = parts.reduce((w, [l, r]) => w + r - l, 0) + GAP * (parts.length - 1)
  let edge = cx - (width * scale) / 2
  return parts.map(([l, r]) => {
    const x = edge - l * scale
    edge += (r - l + GAP) * scale
    return r1(x)
  })
}

const CENTER = 800
const MID_STEP = 400
const FG_STEP = 180
const TOWER_X = 470
const LED_COL = (TOWER_X + CENTER) / 2

const [LED_X, LED_RES_X] = row(LED_COL, 1.25, [EXTENT.led, EXTENT.resStanding])
const [BUZZER_X, TRANSISTOR_X] = row(CENTER + FG_STEP, 1, [EXTENT.speaker, EXTENT.transistor])
const [FENCE_X, POT_X] = row(CENTER - MID_STEP, 1, [EXTENT.fence, EXTENT.pot])

const CAP = { w: 48, h: 58 }
const CAP_S = 0.8
const CAN_CRIMP = { y: -17, half: 4, depth: 3.5 }
const canBody = (() => {
  const { w, h } = CAP
  const [top, bottom, r] = [-h - 4, -8, 3]
  const { y, half, depth } = CAN_CRIMP
  return (
    `M${r} ${top} H${w - r} A${r} ${r} 0 0 1 ${w} ${top + r} V${y - half}` +
    ` Q${w - depth * 2} ${y} ${w} ${y + half} V${bottom - r} A${r} ${r} 0 0 1 ${w - r} ${bottom}` +
    ` H${r} A${r} ${r} 0 0 1 0 ${bottom - r} V${y + half} Q${depth * 2} ${y} 0 ${y - half}` +
    ` V${top + r} A${r} ${r} 0 0 1 ${r} ${top} Z`
  )
})()
const canMinus = `M${CAP.w - 13} ${-CAP.h + 10} h6 M${CAP.w - 13} ${-CAP.h + 22} h6 M${CAP.w - 13} ${-CAP.h + 34} h6`
const [CAP_X, DECOUPLE_X] = row(CENTER + MID_STEP, CAP_S, [EXTENT.can, EXTENT.disc])

const goats: Goat[] = [
  {
    cls: 'goat-lookout',
    x: CAP_X,
    y: yAt(midPts, CAP_X) - (CAP.h + 4) * CAP_S,
    scale: 1.35 * CAP_S,
    pose: 'up',
    nap: 0
  },
  {
    cls: 'goat-graze',
    x: CENTER + 28,
    y: yAt(nearPts, CENTER + 28) + 2,
    scale: 1.4,
    pose: 'graze',
    flip: true,
    nap: 450
  },
  {
    cls: 'goat-kid',
    x: CENTER - 36,
    y: yAt(nearPts, CENTER - 36) + 2,
    scale: 0.85,
    pose: 'up',
    flip: true,
    nap: 900
  }
]

const roundRect = (x: number, y: number, w: number, h: number, r: number): string =>
  `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + h - r}` +
  ` A${r} ${r} 0 0 1 ${x + w - r} ${y + h} H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r}` +
  ` V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`
const RES_BODY = [
  roundRect(-20, -7.5, 12, 15, 6),
  roundRect(8, -7.5, 12, 15, 6),
  'M-10 -5.5 H10 V5.5 H-10 Z'
].join(' ')
const RES_BANDS = 'M-14 -7.5 V7.5 M-5 -5.5 V5.5 M1 -5.5 V5.5 M14 -7.5 V7.5'

const res = { cx: FENCE_X, cy: r1(yAt(nearPts, FENCE_X) - 15) }
const LEAD_BEND = 6
const [leadL, leadR] = [FENCE_X + EXTENT.fence[0], FENCE_X + EXTENT.fence[1]]
const resLeads = [
  `M${leadL} ${r1(yAt(nearPts, leadL) + 4)} V${res.cy + LEAD_BEND}`,
  `A${LEAD_BEND} ${LEAD_BEND} 0 0 1 ${leadL + LEAD_BEND} ${res.cy} H${res.cx - 20}`,
  `M${res.cx + 20} ${res.cy} H${leadR - LEAD_BEND}`,
  `A${LEAD_BEND} ${LEAD_BEND} 0 0 1 ${leadR} ${res.cy + LEAD_BEND} V${r1(yAt(nearPts, leadR) + 4)}`
].join(' ')

const SUN = { x: 1020, y: r1(yAt(farPts, 1020) - 12) }
// The glow fades to nothing at its rim, so it is sized to end inside the view:
// cut by the box's top or right edge, it would show a faint straight line.
const GLOW = {
  cy: SUN.y + 10,
  rx: Math.min(760, W - SUN.x),
  ry: r1(SUN.y + 10 - VIEW_TOP)
}

// Sutro-style tower on the far ridge's shoulder; see HeroArt.astro for the
// construction. Every crossbar and band is found on the legs, not drawn at a
// fixed width.
const tower = { x: TOWER_X, base: r1(Math.min(yAt(farPts, 450), yAt(farPts, 490))) }
const towerTop = tower.base - 120
const centerTop = towerTop - 6
const towerFeet = [-15, 0, 15].map((dx) => r1(yAt(farPts, tower.x + dx) + 8))
const FOOT = 15
const WAIST = 5
const ARM = 11
const waistY = tower.base - 56
const armY = tower.base - 86
const legX = (side: -1 | 1, y: number): number => {
  if (y < waistY) return r1(side * (WAIST + ((waistY - y) / (waistY - armY)) * (ARM - WAIST)))
  const foot = side < 0 ? towerFeet[0] : towerFeet[2]
  return r1(side * (FOOT - ((y - foot) / (waistY - foot)) * (FOOT - WAIST)))
}
const legRun = (side: -1 | 1, lo: number, hi: number): string => {
  const ys = lo > waistY && hi < waistY ? [lo, waistY, hi] : [lo, hi]
  return 'M' + ys.map((y) => `${legX(side, y)} ${r1(y)}`).join(' L')
}
const lowBarY = tower.base - 30
const platformY = tower.base - 72
const bar = (y: number, over: number): string => `M${legX(-1, y) - over} ${y} H${legX(1, y) + over}`
const towerRedBars = [bar(lowBarY, 3), bar(waistY, 3), `M${-ARM - 11} ${armY} H${ARM + 11}`].join(
  ' '
)
const towerPlatform = bar(platformY, 3)
const towerLegs = [
  legRun(-1, towerFeet[0], armY),
  legRun(1, towerFeet[2], armY),
  `M0 ${towerFeet[1]} V${armY}`
].join(' ')
const RED_SPANS: [number, number][] = [
  [tower.base + 24, tower.base - 8],
  [lowBarY + 7, lowBarY - 9],
  [waistY + 6, waistY - 7],
  [armY + 7, armY]
]
const towerLegRed = RED_SPANS.flatMap(([lo, hi]) => [
  legRun(-1, lo, hi),
  legRun(1, lo, hi),
  `M0 ${lo} V${hi}`
]).join(' ')
const towerMasts = [
  `M${-ARM} ${armY} V${towerTop}`,
  `M${ARM} ${armY} V${towerTop}`,
  `M0 ${armY} V${centerTop}`
].join(' ')

// Hover targets, in viewBox units: [x, y, w, h] around each scene.
const nearY = (x: number): number => r1(yAt(nearPts, x))
const midY = (x: number): number => r1(yAt(midPts, x))
const hit = {
  led: [LED_X - 24, midY(LED_X) - 72, LED_RES_X - LED_X + 46, 80],
  lookout: [CAP_X - 30, midY(CAP_X) - (CAP.h + 4) * CAP_S - 62, DECOUPLE_X - CAP_X + 50, 136],
  buzzer: [BUZZER_X - 28, nearY(BUZZER_X) - 58, TRANSISTOR_X - BUZZER_X + 40, 64],
  pot: [leadL - 8, res.cy - 33, POT_X - leadL + 28, nearY(POT_X) - res.cy + 39],
  tower: [tower.x - 34, towerTop - 24, 68, tower.base - towerTop + 28],
  goats: [CENTER - 60, nearY(CENTER) - 64, 136, 70]
}

// Fixed-seed pseudo-random in [0, 1), so the art is the same on every launch.
const hash = (n: number): number => {
  const v = Math.sin(n * 12.9898 + 78.233) * 43758.5453
  return v - Math.floor(v)
}

// The sky turns as one about a pivot far up and to the right, so at night the
// sun sets on a slant and the stars wheel in along the same arc. CSS applies
// the turn; the numbers reach it as custom properties.
const SKY_PIVOT = { x: 2570, y: -266 }
const SKY_TURN = -3
const turn = ([x, y]: number[], deg: number): number[] => {
  const a = (deg * Math.PI) / 180
  const dx = x - SKY_PIVOT.x
  const dy = y - SKY_PIVOT.y
  return [
    r1(SKY_PIVOT.x + dx * Math.cos(a) - dy * Math.sin(a)),
    r1(SKY_PIVOT.y + dx * Math.sin(a) + dy * Math.cos(a))
  ]
}
// Where something must be drawn by day so the night's turn lands it at p.
const beforeTurn = (p: number[]): number[] => turn(p, -SKY_TURN)

// Night sky: [x, y, r] where each star lands once the sky has turned, kept
// inside the view, off the moon, and clear above the far ridge.
const MOON = { x: 1330, y: 160 }
const stars: { x: number; y: number; r: number; style: string }[] = Array.from(
  { length: 160 },
  (_, i) => [
    r1(hash(i * 3 + 1) * W),
    r1(VIEW_TOP + 10 + hash(i * 3 + 2) * 180),
    r1(0.6 + hash(i * 3 + 3) ** 3 * 1.1)
  ]
)
  .filter(([x]) => x < 520 || x > 1080)
  .filter(([x, y]) => Math.hypot(x - MOON.x, y - MOON.y) > 38)
  .filter(([x, y]) => y < yAt(farPts, x) - 18)
  .slice(0, 46)
  .map(([x, y, r], i) => {
    const [tx, ty] = beforeTurn([x, y])
    return {
      x: tx,
      y: ty,
      r,
      style: `--tw: ${r1(1.6 + hash(i + 7) * 2.2)}s; --td: ${r1(-hash(i + 19) * 3)}s`
    }
  })
const skyStyle = `--sky-turn: ${SKY_TURN}deg; --sky-pivot: ${SKY_PIVOT.x}px ${SKY_PIVOT.y}px`

const tufts = [110, 210, 520, 620, 690, 900, 1080, 1180, 1330, 1470].map((x) => {
  const y = r1(yAt(nearPts, x) + 1)
  return `M${x} ${y} l-3 -8 M${x + 2} ${y} l0 -10 M${x + 4} ${y} l3 -7`
})

// Fog banks drifting left to right over the far and mid ridges; `rest` is
// where a bank holds still under reduced motion.
interface FogBank {
  over: 'far' | 'mid'
  y: number
  rx: number
  ry: number
  dur: number
  delay: number
  rest: number
}
const FOG_START = -420
const fogBanks: FogBank[] = [
  { over: 'far', y: 262, rx: 230, ry: 32, dur: 150, delay: -40, rest: 640 },
  { over: 'far', y: 290, rx: 320, ry: 30, dur: 125, delay: -95, rest: 1500 },
  { over: 'far', y: 300, rx: 260, ry: 24, dur: 170, delay: -150, rest: 1100 },
  { over: 'mid', y: 352, rx: 300, ry: 28, dur: 140, delay: -20, rest: 1250 },
  { over: 'mid', y: 336, rx: 220, ry: 22, dur: 185, delay: -120, rest: 1850 }
]
const billows = (b: FogBank, seed: number): number[][] => {
  const n = Math.max(3, Math.round((2 * b.rx) / 120))
  const puffs = Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1)
    const r = b.ry * (1.1 + 1.3 * Math.sin(Math.PI * t)) * (0.85 + 0.3 * hash(seed * 31 + i))
    return [r1((-b.rx + t * 2 * b.rx) * 0.8), r1(b.ry * 0.35 - r * 0.45), r1(r * 1.5), r1(r)]
  })
  return [[0, r1(b.ry * 0.35), b.rx, r1(b.ry * 0.7)], ...puffs]
}
const fog = (over: FogBank['over']): { bank: FogBank; puffs: number[][] }[] =>
  fogBanks
    .filter((b) => b.over === over)
    .map((bank) => ({ bank, puffs: billows(bank, bank.y + bank.rx) }))
const fogFar = fog('far')
const fogMid = fog('mid')
const fogStyle = (b: FogBank): string =>
  `--dur: ${b.dur}s; --delay: ${b.delay}s; --rest: ${b.rest}px`
</script>

<template>
  <svg
    class="hill-scene"
    :viewBox="`0 ${VIEW_TOP} ${W} ${H - VIEW_TOP}`"
    preserveAspectRatio="xMidYMax meet"
    :style="`aspect-ratio: ${W} / ${H - VIEW_TOP}; ${skyStyle}`"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <linearGradient :id="gid('far')" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0.4" class="stop-far-top" />
        <stop offset="0.75" class="stop-far-bottom" />
      </linearGradient>
      <linearGradient :id="gid('mid')" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0.55" class="stop-mid-top" />
        <stop offset="0.9" class="stop-mid-bottom" />
      </linearGradient>
      <linearGradient :id="gid('near')" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0.75" class="stop-near-top" />
        <stop offset="1" class="stop-near-bottom" />
      </linearGradient>
      <radialGradient :id="gid('fog')">
        <stop offset="0" class="stop-fog" />
        <stop offset="0.55" class="stop-fog-mid" />
        <stop offset="1" class="stop-fog-edge" />
      </radialGradient>
      <radialGradient :id="gid('glow')">
        <stop offset="0" class="stop-glow" />
        <stop offset="0.45" class="stop-glow-mid" />
        <stop offset="1" class="stop-glow-edge" />
      </radialGradient>
      <radialGradient :id="gid('halo')">
        <stop offset="0" class="stop-halo" />
        <stop offset="1" class="stop-halo-edge" />
      </radialGradient>
    </defs>
    <g class="sky-turn">
      <ellipse
        class="glow"
        :cx="SUN.x"
        :cy="GLOW.cy"
        :rx="GLOW.rx"
        :ry="GLOW.ry"
        :fill="paint('glow')"
      />
      <circle class="sun" :cx="SUN.x" :cy="SUN.y" r="34" />
    </g>

    <g class="spot spot-tower">
      <rect
        class="hit"
        :x="hit.tower[0]"
        :y="hit.tower[1]"
        :width="hit.tower[2]"
        :height="hit.tower[3]"
      />
      <g :transform="`translate(${tower.x} 0)`">
        <path class="tower-legs" :d="towerLegs" />
        <path class="tower-red" :d="towerLegRed" />
        <path class="tower-platform" :d="towerPlatform" />
        <path class="tower-bars" :d="towerRedBars" />
        <path class="tower-masts" :d="towerMasts" />
        <path class="tower-masts tower-masts-red" :d="towerMasts" />
        <circle class="beacon" :cx="-ARM" :cy="towerTop" r="2" />
        <circle class="beacon" cx="0" :cy="centerTop" r="2" />
        <circle class="beacon" :cx="ARM" :cy="towerTop" r="2" />
        <g class="radio" :transform="`translate(0 ${centerTop})`">
          <path class="wave w1" d="M-7 -6 A9 9 0 0 0 -7 6 M7 -6 A9 9 0 0 1 7 6" />
          <path class="wave w2" d="M-12 -10 A15 15 0 0 0 -12 10 M12 -10 A15 15 0 0 1 12 10" />
          <path class="wave w3" d="M-17 -14 A21 21 0 0 0 -17 14 M17 -14 A21 21 0 0 1 17 14" />
        </g>
      </g>
    </g>
    <path :d="hill(far)" :fill="paint('far')" />

    <g
      v-for="{ bank, puffs } in fogFar"
      :key="bank.y"
      :transform="`translate(${FOG_START} ${bank.y})`"
      :style="fogStyle(bank)"
    >
      <g class="drift">
        <ellipse
          v-for="(p, i) in puffs"
          :key="i"
          :cx="p[0]"
          :cy="p[1]"
          :rx="p[2]"
          :ry="p[3]"
          :fill="paint('fog')"
        />
      </g>
    </g>

    <path :d="hill(mid)" :fill="paint('mid')" />

    <g class="spot spot-led">
      <rect class="hit" :x="hit.led[0]" :y="hit.led[1]" :width="hit.led[2]" :height="hit.led[3]" />
      <g :transform="on(midPts, LED_X, 1.25)">
        <circle class="led-halo" cx="0" cy="-30" r="34" :fill="paint('halo')" />
        <path class="part-lead" d="M-5 4 V-12 M5 4 V-6 L8 -9 V-12" />
        <rect class="part-body" x="-14" y="-17" width="28" height="5" rx="1" />
        <path class="led-lens" d="M-12 -17 V-40 A12 12 0 0 1 12 -40 V-17 Z" />
        <path class="part-shade" d="M-7 -17 V-27 L-1 -29 V-17 Z M3 -17 V-30 H6 V-17 Z" />
        <path
          class="part-light"
          d="M-8.5 -22 V-40 A8.5 8.5 0 0 1 -4 -47.5 A10 10 0 0 0 -6 -40 V-22 Z"
        />
      </g>
      <g :transform="on(midPts, LED_RES_X, 1.25)">
        <path class="part-lead" d="M0 4 V-13 M0 -45 V-49 A5 5 0 0 1 10 -49 V4" />
        <g transform="translate(0 -29) rotate(-90) scale(0.8)">
          <path class="part-body" :d="RES_BODY" />
          <path class="res-bands" :d="RES_BANDS" />
        </g>
      </g>
    </g>

    <g class="spot spot-lookout">
      <rect
        class="hit"
        :x="hit.lookout[0]"
        :y="hit.lookout[1]"
        :width="hit.lookout[2]"
        :height="hit.lookout[3]"
      />
      <g :transform="on(midPts, DECOUPLE_X, CAP_S)">
        <path class="part-lead" d="M-4 4 V-7 L-3 -10 M4 4 V-7 L3 -10" />
        <path
          class="disc-body"
          d="M-3 -9 C-10 -9 -11 -16 -10 -20 C-9 -26 -4 -28 0 -28 C4 -28 9 -26 10 -20 C11 -16 10 -9 3 -9 Z"
        />
      </g>
      <g :transform="on(midPts, CAP_X, CAP_S)">
        <g :transform="`translate(${-CAP.w / 2} 0)`">
          <path class="part-lead" d="M16 -8 V6 M32 -8 V6" />
          <rect class="part-shade" x="4" y="-10" :width="CAP.w - 8" height="6" />
          <path class="part-body" :d="canBody" />
          <rect class="part-light" x="2" :y="-CAP.h - 6" :width="CAP.w - 4" height="4" rx="1.5" />
          <rect class="part-light" :x="CAP.w - 15" :y="-CAP.h" width="10" :height="CAP.h - 12" />
          <path class="can-minus" :d="canMinus" />
        </g>
      </g>
    </g>

    <g
      v-for="{ bank, puffs } in fogMid"
      :key="bank.y"
      class="fog-mid"
      :transform="`translate(${FOG_START} ${bank.y})`"
      :style="fogStyle(bank)"
    >
      <g class="drift">
        <ellipse
          v-for="(p, i) in puffs"
          :key="i"
          :cx="p[0]"
          :cy="p[1]"
          :rx="p[2]"
          :ry="p[3]"
          :fill="paint('fog')"
        />
      </g>
    </g>

    <path :d="hill(near)" :fill="paint('near')" />

    <g class="spot spot-pot">
      <rect class="hit" :x="hit.pot[0]" :y="hit.pot[1]" :width="hit.pot[2]" :height="hit.pot[3]" />
      <path class="part-lead" :d="resLeads" />
      <g :transform="`translate(${res.cx} ${res.cy})`">
        <path class="part-body" :d="RES_BODY" />
        <path class="res-bands" :d="RES_BANDS" />
      </g>
      <g :transform="on(nearPts, POT_X)">
        <path class="part-lead" d="M-7 4 V-8 M0 4 V-8 M7 4 V-8" />
        <rect class="part-body" x="-13" y="-34" width="26" height="26" rx="3" />
        <circle class="part-light" cx="0" cy="-21" r="9" />
        <rect class="part-shade pot-slot" x="-1.5" y="-28" width="3" height="14" rx="1" />
      </g>
    </g>

    <g class="spot spot-buzzer">
      <rect
        class="hit"
        :x="hit.buzzer[0]"
        :y="hit.buzzer[1]"
        :width="hit.buzzer[2]"
        :height="hit.buzzer[3]"
      />
      <g :transform="on(nearPts, TRANSISTOR_X)">
        <path class="part-lead" d="M-5 4 V-10 M0 4 V-10 M5 4 V-10" />
        <path class="part-body" d="M-8 -9 V-22 Q-8 -29 0 -29 Q8 -29 8 -22 V-9 Z" />
      </g>
      <g :transform="on(nearPts, BUZZER_X)">
        <path class="part-lead" d="M0 4 V-8 M10 4 V-11" />
        <rect class="part-shade" x="7" y="-25" width="9" height="14" rx="1.5" />
        <path class="part-body" d="M7 -24 L-6 -31 L-6 -5 L7 -12 Z" />
        <rect class="part-light" x="-9" y="-32" width="4" height="28" rx="2" />
        <g class="sound">
          <path class="wave w1" d="M-13 -23 A7 7 0 0 0 -13 -13" />
          <path class="wave w2" d="M-17 -27 A12 12 0 0 0 -17 -9" />
          <path class="wave w3" d="M-21 -31 A17 17 0 0 0 -21 -5" />
        </g>
      </g>
    </g>

    <g class="spot spot-goats">
      <rect
        class="hit"
        :x="hit.goats[0]"
        :y="hit.goats[1]"
        :width="hit.goats[2]"
        :height="hit.goats[3]"
      />
    </g>

    <path v-for="(d, i) in tufts" :key="i" class="tuft" :d="d" />

    <!-- The goat, facing right with its hooves on y = 0: body, legs (far side
         a tone darker), and an alert or grazing head. -->
    <g
      v-for="g in goats"
      :key="g.cls"
      class="goat"
      :class="g.cls"
      :transform="goatTransform(g)"
      :style="`--nap: ${g.nap}ms`"
    >
      <g class="stance">
        <path class="far-legs" d="M13.5 -14 L14.5 0 M-14 -15 L-15.5 -7 L-14 0" />
        <path class="tail" d="M-21.2 -24.6 L-24.4 -30.8 L-22.4 -31.4 L-19 -25.4 Z" />
        <path
          d="M-21 -25.6 C-17 -28.4 -12.5 -28.2 -8 -27 C-2 -25.8 4 -26.8 8.5 -28.4 C13 -28.4 16 -24 16 -19 C16 -15 13 -13 10 -13 L5 -13 C-2 -12 -9 -12 -15 -13 C-19 -14 -22.5 -17 -22.5 -21 C-22.5 -23.6 -22.2 -25 -21 -25.6 Z"
        />
        <path class="legs" d="M10 -14 L10.5 0 M-18 -15 L-19.5 -7 L-18 0" />
        <path class="legs-folded" d="M9 -14.5 L10 -12 L18 -12.5 M-17 -14.5 L-21 -12 L-13 -11.5" />
        <g v-if="g.pose === 'up'" class="head">
          <path
            d="M5 -27 C8 -30 12 -35 15 -39 L18 -40 C21 -38 24 -35 26 -32 C27 -30.5 26 -29 24 -29.5 C22 -30 20 -31 18 -32 C16 -29 15 -25 14 -21 L8 -21 Z"
          />
          <path d="M14.2 -38.2 C13.6 -44 10.4 -47.6 6 -47.2 C9.8 -45.6 12.8 -42 16.8 -38.6 Z" />
          <path d="M15 -36 L9.5 -35 L15 -33.6 Z" />
          <path d="M23 -29.8 L22 -25.4 L21 -30.6 Z" />
          <circle class="eye" cx="19.5" cy="-36.4" r="0.9" />
          <path class="eye-shut" d="M18.3 -36.8 q1.2 1.4 2.4 0" />
        </g>
        <g v-else class="head">
          <path
            d="M4 -27.5 C10 -28 15.5 -24 18.5 -18.5 L21.5 -17 C24 -13 25.5 -8 26.5 -4.5 C27 -3 25.5 -2 24 -2.8 C22.5 -4 21.5 -6 20.5 -8 C18.5 -10.5 16 -14 14 -18 L8 -21 Z"
          />
          <path d="M18 -18.5 C16 -23.5 12 -25.5 8.5 -24.5 C12 -23 15 -21 20.5 -17.5 Z" />
          <path d="M19.5 -15 L14 -12.5 L19 -13 Z" />
          <path d="M23 -4.5 L19.5 -2 L22 -6 Z" />
          <circle class="eye" cx="21.6" cy="-12.6" r="0.9" />
          <path class="eye-shut" d="M20.4 -13 q1.2 1.4 2.4 0" />
        </g>
        <!-- A grazer also carries an alert head, hidden until something
             startles it. -->
        <g v-if="g.pose === 'graze'" class="head-alert">
          <path
            d="M5 -27 C8 -30 12 -35 15 -39 L18 -40 C21 -38 24 -35 26 -32 C27 -30.5 26 -29 24 -29.5 C22 -30 20 -31 18 -32 C16 -29 15 -25 14 -21 L8 -21 Z"
          />
          <path d="M14.2 -38.2 C13.6 -44 10.4 -47.6 6 -47.2 C9.8 -45.6 12.8 -42 16.8 -38.6 Z" />
          <path d="M15 -36 L9.5 -35 L15 -33.6 Z" />
          <path d="M23 -29.8 L22 -25.4 L21 -30.6 Z" />
          <circle class="eye" cx="19.5" cy="-36.4" r="0.9" />
          <path class="eye-shut" d="M18.3 -36.8 q1.2 1.4 2.4 0" />
        </g>
      </g>
    </g>

    <rect class="night" x="0" :y="VIEW_TOP" :width="W" :height="H - VIEW_TOP" />
    <g
      v-for="g in goats"
      :key="`z:${g.cls}`"
      class="zzz"
      :transform="zzzAt(g)"
      :style="`--nap: ${g.nap}ms`"
    >
      <path class="z z1" d="M0 0 h4 l-4 4 h4" />
      <g transform="translate(6 -8) scale(1.3)"><path class="z z2" d="M0 0 h4 l-4 4 h4" /></g>
      <g transform="translate(13 -18) scale(1.6)"><path class="z z3" d="M0 0 h4 l-4 4 h4" /></g>
    </g>
    <g class="sky-turn">
      <g class="stars">
        <g
          v-for="(st, i) in stars"
          :key="i"
          :transform="`translate(${st.x} ${st.y})`"
          :style="st.style"
        >
          <g class="star">
            <circle :r="st.r" />
            <path
              v-if="st.r >= 1.3"
              class="glint"
              d="M0 -5 L0.6 -0.6 L5 0 L0.6 0.6 L0 5 L-0.6 0.6 L-5 0 L-0.6 -0.6 Z"
            />
          </g>
        </g>
      </g>
    </g>
    <g :transform="`translate(${MOON.x} ${MOON.y})`">
      <path class="moon" d="M0 -18 A18 18 0 1 0 0 18 A12.5 18 0 1 1 0 -18 Z" />
    </g>
  </svg>
</template>

<style scoped>
/* Muted on purpose: every tone is a token mixed toward the editor ground, so
   the scene sits back in both themes and never competes with the page above
   it. The near hill ends on the ground itself, so the page below it reads as
   the same field. */
.hill-scene {
  --hs-ground: var(--vscode-bg-editor);
  --hs-land: var(--vscode-text-muted);
  --hs-far-top: color-mix(in srgb, var(--hs-land) 20%, var(--hs-ground));
  --hs-far-bottom: color-mix(in srgb, var(--hs-land) 15%, var(--hs-ground));
  --hs-mid-top: color-mix(in srgb, var(--hs-land) 12%, var(--hs-ground));
  --hs-mid-bottom: color-mix(in srgb, var(--hs-land) 8%, var(--hs-ground));
  --hs-near-top: color-mix(in srgb, var(--hs-land) 5%, var(--hs-ground));
  --hs-near-bottom: var(--hs-ground);
  --hs-part: color-mix(in srgb, var(--hs-land) 26%, var(--hs-ground));
  --hs-part-shade: color-mix(in srgb, var(--hs-land) 16%, var(--hs-ground));
  --hs-part-light: color-mix(in srgb, var(--hs-land) 42%, var(--hs-ground));
  --hs-lead: color-mix(in srgb, var(--vscode-accent) 30%, var(--hs-ground));
  --hs-goat: color-mix(in srgb, var(--vscode-text) 42%, var(--hs-ground));
  --hs-goat-far: color-mix(in srgb, var(--vscode-text) 28%, var(--hs-ground));
  --hs-goat-brown: color-mix(
    in srgb,
    color-mix(in srgb, var(--vscode-accent) 45%, var(--hs-land)) 45%,
    var(--hs-ground)
  );
  --hs-goat-brown-far: color-mix(in srgb, var(--hs-goat-brown) 70%, var(--hs-ground));
  --hs-tower: color-mix(in srgb, var(--vscode-accent) 22%, var(--hs-far-top));
  --hs-tower-white: color-mix(in srgb, var(--hs-goat) 45%, var(--hs-far-top));
  --hs-warm: color-mix(in srgb, var(--vscode-accent) 60%, var(--vscode-text));
  /* When the first sound wave is up: the goats hear it then. */
  --hear: 320ms;
  /* How long a goat takes to notice the LED come on. */
  --notice: 250ms;
  /* When the sun is down and the goats settle for the night. */
  --dusk: 1000ms;
  /* Full width, and as tall as the whole scene at that width: never cropped. */
  display: block;
  width: 100%;
  height: auto;
  pointer-events: none;
  user-select: none;
}

.stop-far-top {
  stop-color: var(--hs-far-top);
}
.stop-far-bottom {
  stop-color: var(--hs-far-bottom);
}
.stop-mid-top {
  stop-color: var(--hs-mid-top);
}
.stop-mid-bottom {
  stop-color: var(--hs-mid-bottom);
}
.stop-near-top {
  stop-color: var(--hs-near-top);
}
.stop-near-bottom {
  stop-color: var(--hs-near-bottom);
}

.stop-glow,
.stop-glow-mid,
.stop-glow-edge {
  stop-color: var(--vscode-accent);
  stop-opacity: 0.1;
}
.stop-glow-mid {
  stop-opacity: 0.035;
}
.stop-glow-edge {
  stop-opacity: 0;
}
.sun {
  fill: color-mix(in srgb, var(--vscode-accent) 30%, var(--hs-ground));
}

.stop-fog,
.stop-fog-mid,
.stop-fog-edge {
  stop-color: var(--vscode-text);
  stop-opacity: 0.05;
}
.stop-fog-mid {
  stop-opacity: 0.025;
}
.stop-fog-edge {
  stop-opacity: 0;
}
.fog-mid {
  opacity: 0.75;
}

.tower-legs,
.tower-red,
.tower-platform,
.tower-bars,
.tower-masts {
  fill: none;
  stroke: var(--hs-tower);
  stroke-width: 2.2;
  stroke-linejoin: round;
}
.tower-legs,
.tower-platform,
.tower-masts {
  stroke: var(--hs-tower-white);
}
.tower-bars {
  stroke-width: 3;
}
.tower-platform {
  stroke-width: 2.4;
}
.tower-masts {
  stroke-width: 1.4;
}
.tower-masts-red {
  stroke: var(--hs-tower);
  stroke-dasharray: 5 5;
}

.part-body {
  fill: var(--hs-part);
}
.part-shade,
.can-minus {
  fill: var(--hs-part-shade);
  stroke: var(--hs-part-shade);
}
.can-minus {
  stroke-width: 2;
}
.part-light {
  fill: var(--hs-part-light);
}
.part-lead {
  fill: none;
  stroke: var(--hs-lead);
  stroke-width: 2;
  stroke-linejoin: round;
}
.res-bands {
  stroke: var(--hs-lead);
  stroke-width: 3;
}
.disc-body {
  fill: color-mix(in srgb, var(--vscode-accent) 18%, var(--hs-part));
}
/* Unlit: amber gone dull, the way an LED looks with no current. */
.led-lens {
  --led-off: color-mix(in srgb, var(--vscode-accent) 18%, var(--hs-part));
  --led-on: color-mix(in srgb, var(--vscode-accent) 70%, #fff4d6);
  fill: var(--led-off);
}
.beacon {
  fill: var(--vscode-accent);
  opacity: 0.3;
}

.tuft {
  fill: none;
  stroke: var(--hs-part);
  stroke-width: 1.4;
  stroke-linecap: round;
}

.goat {
  fill: var(--hs-goat);
}
.eye {
  fill: var(--hs-ground);
}
.legs,
.far-legs {
  fill: none;
  stroke: var(--hs-goat);
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.far-legs {
  stroke: var(--hs-goat-far);
}
.goat-graze {
  fill: var(--hs-goat-brown);
}
.goat-graze .legs {
  stroke: var(--hs-goat-brown);
}
.goat-graze .far-legs {
  stroke: var(--hs-goat-brown-far);
}

/* --- Hover scenes. Feedback lands at the app's ~70ms; anything that
   plays out (a hop, a sunrise) starts on that beat and runs its course. --- */
/* The SVG itself ignores the pointer; only the scenes take it. */
.spot {
  pointer-events: auto;
}
.hit {
  fill: none;
  pointer-events: all;
}

/* Light: the LED powers on. A clean ramp, never a flicker (that reads as
   a failing part): the lens brightens from the first frame, and the halo
   swells into a bloom that slightly overshoots and settles, ~380ms end to
   end. Switching off is a plain fade. */
.stop-halo {
  stop-color: var(--vscode-accent);
  stop-opacity: 0.55;
}
.stop-halo-edge {
  stop-color: var(--vscode-accent);
  stop-opacity: 0;
}
.led-halo {
  opacity: 0;
  transform-box: fill-box;
  transform-origin: 50% 50%;
  transition: opacity 400ms ease-out;
}
.led-lens {
  transition: fill 400ms ease-out;
}
.spot-led:hover .led-halo {
  opacity: 1;
  animation: hs-led-halo 380ms cubic-bezier(0.2, 0.7, 0.3, 1);
}
.spot-led:hover .led-lens {
  fill: var(--led-on);
  transition: fill 180ms ease-out;
}
@keyframes hs-led-halo {
  0% {
    opacity: 0.3;
    transform: scale(0.5);
  }
  60% {
    opacity: 1;
    transform: scale(1.12);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

/* The LED catches the nearby goats' eye: a beat after it lights, the
   nanny lifts her head and the kid tips its chin up toward it. (Both face
   it already; the lookout faces away and doesn't notice.) */
.hill-scene:has(.spot-led:hover) .goat-graze .head {
  animation: hs-hide 0s linear var(--notice) forwards;
}
.hill-scene:has(.spot-led:hover) .goat-graze .head-alert {
  animation: hs-show 0s linear var(--notice) forwards;
}
.goat-kid .head {
  transform-origin: 8px -22px;
  transition: transform 300ms ease-out;
}
.hill-scene:has(.spot-led:hover) .goat-kid .head {
  transform: rotate(-14deg);
  transition-delay: var(--notice);
}

/* Greet: the kid turns round to face its mother and steps in, she lifts
   her head and dips it to touch noses, and both wag. The goats are drawn
   over this scene's hit area, so they are what you hover. The turn is a
   flip of the kid's stance in its own (already mirrored) frame. */
.goat-kid .stance {
  transform-origin: 0 0;
  /* Spelled out in the same form as the turned pose so the turn tweens
     scaleX straight through (a flat cartoon turn). From 'none', the browser
     would blend the mirror as a matrix and spin the kid round. */
  transform: translateX(0) scaleX(1);
}
.hill-scene:has(.spot-goats:hover) .goat-kid .stance {
  /* The idle hop animates this transform; it has to stand down. */
  animation: none;
  transform: translateX(-5px) scaleX(-1);
  transition: transform 280ms ease-in-out;
}

.hill-scene:has(.spot-goats:hover) .goat-graze .head {
  animation: hs-hide 0s linear 200ms forwards;
}
.hill-scene:has(.spot-goats:hover) .goat-graze .head-alert {
  animation: hs-show 0s linear 200ms forwards;
  transform: rotate(38deg);
  transition: transform 300ms ease-out 200ms;
}
.goat .tail {
  transform-box: fill-box;
  transform-origin: 90% 100%;
}
.hill-scene:has(.spot-goats:hover) .goat-kid .tail,
.hill-scene:has(.spot-goats:hover) .goat-graze .tail {
  animation: hs-wag 220ms ease-in-out infinite alternate 250ms;
}

/* Joy: the lookout wags its tail, quick and happy, chin up. The tail's
   pivot is set with its idle flick below. */
.hill-scene:has(.spot-lookout:hover) .goat-lookout .tail {
  animation: hs-wag 240ms ease-in-out infinite alternate;
}
@keyframes hs-wag {
  from {
    transform: rotate(-30deg);
  }
  to {
    transform: rotate(12deg);
  }
}
.goat-lookout .head {
  transition: transform 250ms ease-out;
}
.hill-scene:has(.spot-lookout:hover) .goat-lookout .head {
  animation: none;
  transform: rotate(-10deg);
}

/* The kid's startle jump (see Sound). */
@keyframes hs-hop {
  0% {
    transform: translateY(0);
  }
  10% {
    transform: translateY(2px);
  }
  45% {
    transform: translateY(-18px);
  }
  80% {
    transform: translateY(0);
  }
  90% {
    transform: translateY(1px);
  }
  100% {
    transform: translateY(0);
  }
}

/* Waves, shared by sound and radio: rings pulse outward in turn. */
.wave {
  fill: none;
  stroke: var(--hs-warm);
  stroke-width: 1.6;
  stroke-linecap: round;
  opacity: 0;
  transform-box: fill-box;
  transform-origin: 50% 100%;
}
/* The speaker's waves leave the cone sideways, toward the goats. */
.sound .wave {
  transform-origin: 100% 50%;
}
.radio .wave {
  stroke: var(--vscode-accent);
  transform-origin: 50% 50%;
}
.spot-buzzer:hover .wave,
.spot-tower:hover .wave {
  animation: hs-wave 1.1s ease-out infinite;
}
.spot-buzzer:hover .w2,
.spot-tower:hover .w2 {
  animation-delay: 0.18s;
}
.spot-buzzer:hover .w3,
.spot-tower:hover .w3 {
  animation-delay: 0.36s;
}
@keyframes hs-wave {
  0% {
    opacity: 0;
    transform: scale(0.85);
  }
  25% {
    opacity: 0.9;
  }
  100% {
    opacity: 0;
    transform: scale(1.15);
  }
}

/* Sound: the goats react once the first wave is visible, not the instant
   the speaker is hovered — sound has to reach them. The nanny's head comes
   up (the grazer carries an alert head, hidden until then) and the kid
   startles. The swap runs as zero-length animations so it can be delayed;
   `display` can't be. */
.goat .head-alert {
  visibility: hidden;
}
.hill-scene:has(.spot-buzzer:hover) .goat-graze .head {
  animation: hs-hide 0s linear var(--hear) forwards;
}
.hill-scene:has(.spot-buzzer:hover) .goat-graze .head-alert {
  animation: hs-show 0s linear var(--hear) forwards;
}
.hill-scene:has(.spot-buzzer:hover) .goat-kid .stance {
  animation: hs-hop 500ms cubic-bezier(0.3, 0.7, 0.4, 1) var(--hear);
}
@keyframes hs-hide {
  to {
    visibility: hidden;
  }
}
@keyframes hs-show {
  to {
    visibility: visible;
  }
}

/* Radio: the mast lights flare while it broadcasts. */
.beacon {
  transition: opacity 70ms ease-out;
}
.spot-tower:hover .beacon {
  opacity: 1;
}

/* Night: the trimmer turns down, the sun sinks behind the ridge, the glow
   goes out, a cool dark settles over everything, and the stars, the moon
   and the tower's lights come out. The sun's setting and the stars'
   arrival are one motion: the sky turns (see SKY_TURN). Undoing it runs the same way back. */
.pot-slot {
  transform-origin: 0 -21px;
  transition: transform 700ms ease-in-out;
}
.spot-pot:hover .pot-slot {
  transform: rotate(-150deg);
}
.sky-turn {
  transform-box: view-box;
  transform-origin: var(--sky-pivot);
  transition: transform 1600ms ease-in-out;
}
.hill-scene:has(.spot-pot:hover) .sky-turn {
  transform: rotate(var(--sky-turn));
}
.glow {
  transition: opacity 1200ms ease-in-out;
}
.night {
  fill: var(--scene-night);
  opacity: 0;
  transition: opacity var(--scene-night-fall) ease-in-out;
}
.stars circle {
  fill: var(--scene-starlight);
}
.stars,
.moon {
  opacity: 0;
  transition: opacity 600ms ease-out;
}
.moon {
  fill: var(--scene-starlight);
  transform: translate(-46px, 34px) rotate(-18deg);
  transition:
    opacity 600ms ease-out,
    transform 1400ms cubic-bezier(0.2, 0.7, 0.3, 1);
}
.glint {
  fill: var(--scene-starlight);
  opacity: 0.7;
}
.star {
  transform-box: fill-box;
  transform-origin: 50% 50%;
}
.hill-scene:has(.spot-pot:hover) .star {
  animation: hs-twinkle var(--tw) ease-in-out infinite var(--td);
}
@keyframes hs-twinkle {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  45% {
    opacity: 0.25;
    transform: scale(0.6);
  }
  60% {
    opacity: 0.9;
    transform: scale(1.15);
  }
}
.hill-scene:has(.spot-pot:hover) .glow {
  opacity: 0;
}
.hill-scene:has(.spot-pot:hover) .night {
  opacity: var(--scene-night-opacity);
}
.hill-scene:has(.spot-pot:hover) .stars {
  opacity: 0.85;
  transition-delay: 700ms;
}
/* The moon rises into place along its own short arc as it fades in. */
.hill-scene:has(.spot-pot:hover) .moon {
  opacity: 0.9;
  transform: none;
  transition-delay: 400ms;
}
.hill-scene:has(.spot-pot:hover) .beacon {
  opacity: 1;
}

/* Sleep: once the sun is down, every goat lies down — legs folding under
   as the body lowers, head tucked, eyes shut — and z's drift up. They get up
   again as soon as the sun does. */
.goat .stance {
  transition: transform 600ms ease-in-out;
}
/* As the body lowers, the standing legs draw up from the hip and the
   folded legs take their place as it lands. Eyes swap to a closed curve. */
.goat .legs,
.goat .far-legs {
  transform-box: fill-box;
  transform-origin: 50% 0;
  transition: transform 600ms ease-in-out;
}
.goat .eye-shut {
  fill: none;
  stroke: var(--hs-ground);
  stroke-width: 0.8;
  stroke-linecap: round;
  opacity: 0;
}
.hill-scene:has(.spot-pot:hover) .goat .stance {
  animation: none;
  transform: translateY(11px);
  transition-delay: calc(var(--dusk) + var(--nap));
}
.hill-scene:has(.spot-pot:hover) .goat .legs,
.hill-scene:has(.spot-pot:hover) .goat .far-legs {
  transform: scaleY(0);
  transition-delay: calc(var(--dusk) + var(--nap));
}
/* The resting pose: front leg bent forward under the chest, hind leg
   tucked under the hip, drawn in as the body lands. */
.goat .legs-folded {
  fill: none;
  stroke: var(--hs-goat);
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0;
  transition: opacity 150ms ease-out;
}
.goat-graze .legs-folded {
  stroke: var(--hs-goat-brown);
}
.hill-scene:has(.spot-pot:hover) .goat .legs-folded {
  opacity: 1;
  transition-delay: calc(var(--dusk) + var(--nap) + 420ms);
}
.hill-scene:has(.spot-pot:hover) .goat .eye {
  animation: hs-hide 0s linear calc(var(--dusk) + var(--nap) + 400ms) forwards;
}
.hill-scene:has(.spot-pot:hover) .goat .eye-shut {
  animation: hs-show-op 0s linear calc(var(--dusk) + var(--nap) + 400ms) forwards;
}
@keyframes hs-show-op {
  to {
    opacity: 1;
  }
}
.hill-scene:has(.spot-pot:hover) .goat .head,
.hill-scene:has(.spot-pot:hover) .goat .tail {
  animation: none;
}
.hill-scene:has(.spot-pot:hover) .goat-kid .head,
.hill-scene:has(.spot-pot:hover) .goat-lookout .head {
  transform: rotate(30deg);
  transition: transform 600ms ease-in-out calc(var(--dusk) + var(--nap));
}
/* The nanny sleeps with her head up and tucked like the others: a grazing
   neck laid on the ground reads as collapsed, not asleep. */
.hill-scene:has(.spot-pot:hover) .goat-graze .head {
  animation: hs-hide 0s linear calc(var(--dusk) + var(--nap)) forwards;
}
.hill-scene:has(.spot-pot:hover) .goat-graze .head-alert {
  animation: hs-show 0s linear calc(var(--dusk) + var(--nap)) forwards;
  transform: rotate(30deg);
}
.goat-graze .head-alert {
  transform-origin: 8px -22px;
}
.z {
  fill: none;
  stroke: var(--scene-starlight);
  stroke-width: 0.9;
  stroke-linejoin: round;
  opacity: 0;
}
.hill-scene:has(.spot-pot:hover) .z {
  animation: hs-z 4.8s ease-in-out infinite;
}
.hill-scene:has(.spot-pot:hover) .z1 {
  animation-delay: calc(var(--dusk) + var(--nap) + 900ms);
}
.hill-scene:has(.spot-pot:hover) .z2 {
  animation-delay: calc(var(--dusk) + var(--nap) + 2500ms);
}
.hill-scene:has(.spot-pot:hover) .z3 {
  animation-delay: calc(var(--dusk) + var(--nap) + 4100ms);
}
@keyframes hs-z {
  0%,
  100% {
    opacity: 0;
  }
  35%,
  55% {
    opacity: 0.4;
  }
}

/* Ambient motion. Every loop runs at its own period so nothing syncs
   into a chorus line, and each is slow enough to stay in the corner of the eye. */
.goat-graze .head {
  transform-origin: 8px -22px;
  animation: hs-nibble 6.5s ease-in-out infinite -2.5s;
}
@keyframes hs-nibble {
  0%,
  60%,
  100% {
    transform: rotate(0deg);
  }
  68%,
  76% {
    transform: rotate(7deg);
  }
  72% {
    transform: rotate(4deg);
  }
}

.goat-kid .stance {
  animation: hs-pronk 11s ease-out infinite 2s;
}
@keyframes hs-pronk {
  0%,
  88%,
  100% {
    transform: translateY(0);
  }
  91% {
    transform: translateY(-7px);
  }
  94% {
    transform: translateY(0);
  }
}

.goat-lookout .head {
  transform-origin: 8px -22px;
  animation: hs-look 13s ease-in-out infinite;
}
@keyframes hs-look {
  0%,
  40%,
  100% {
    transform: rotate(0deg);
  }
  48%,
  70% {
    transform: rotate(-8deg);
  }
}

.goat-lookout .tail {
  transform-box: fill-box;
  transform-origin: 90% 100%;
  animation: hs-flick 6s ease-in-out infinite;
}
@keyframes hs-flick {
  0%,
  90%,
  100% {
    transform: rotate(0deg);
  }
  93%,
  97% {
    transform: rotate(-24deg);
  }
  95% {
    transform: rotate(8deg);
  }
}

.drift {
  animation: hs-pass var(--dur) linear infinite var(--delay);
}
@keyframes hs-pass {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(2440px);
  }
}

/* The still frame is a composed one: the grazer mid-graze, fog banks spread
   across the ridges. */
@media (prefers-reduced-motion: reduce) {
  .goat .head,
  .goat .tail,
  .goat .stance,
  .drift {
    animation: none;
  }
  .drift {
    transform: translateX(var(--rest));
  }
  /* Hover scenes keep their idea without the motion: waves show still, the
     LED still lights, the lookout still lifts its chin; the wag and the kid's
     jump are dropped. */
  .spot-buzzer:hover .wave,
  .spot-tower:hover .wave {
    animation: none;
    opacity: 0.7;
  }
  .hill-scene:has(.spot-buzzer:hover) .goat-kid .stance,
  .hill-scene:has(.spot-pot:hover) .star,
  .hill-scene:has(.spot-goats:hover) .goat-kid .stance,
  .hill-scene:has(.spot-goats:hover) .goat .tail {
    animation: none;
  }
  .moon {
    transform: none;
  }
  .hill-scene:has(.spot-pot:hover) .z {
    animation: none;
    opacity: 0.35;
  }
}
</style>
