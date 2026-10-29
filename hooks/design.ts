import type { BodyShape, Design, PetMood } from '../types'

export type { Design } from '../types'

// Smooth vector pets. A pet is a small set of parameters (Design); `partsOf`
// turns it into SVG path data with roles, which the floating window (WPF) and
// the in-app pane (SVG) both draw and animate. /hatch asks a model for a Design.

export const VW = 120
export const VH = 110

export type Part = {
  role: string
  d: string
  fill?: string
  grad?: [string, string]
  stroke?: string
  sw?: number
  opacity?: number
}

export type Pivots = Record<string, [number, number]>

// --- colors -------------------------------------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)

  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a)
  const [r2, g2, b2] = rgb(b)
  const c = (x: number, y: number) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, '0')

  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`.toUpperCase()
}

const light = (c: string, t = 0.28) => mix(c, '#FFFFFF', t)
const dark = (c: string, t = 0.22) => mix(c, '#000000', t)

// --- path helpers (SVG syntax that WPF's path markup also reads) ---------------

const f = (n: number) => (Math.round(n * 10) / 10).toString()

function rr(x: number, y: number, w: number, h: number, r: number): string {
  const q = Math.min(r, w / 2, h / 2)

  return (
    `M${f(x + q)},${f(y)} H${f(x + w - q)} A${f(q)},${f(q)} 0 0 1 ${f(x + w)},${f(y + q)} ` +
    `V${f(y + h - q)} A${f(q)},${f(q)} 0 0 1 ${f(x + w - q)},${f(y + h)} H${f(x + q)} ` +
    `A${f(q)},${f(q)} 0 0 1 ${f(x)},${f(y + h - q)} V${f(y + q)} A${f(q)},${f(q)} 0 0 1 ${f(x + q)},${f(y)} Z`
  )
}

function ell(cx: number, cy: number, rx: number, ry = rx): string {
  return (
    `M${f(cx - rx)},${f(cy)} A${f(rx)},${f(ry)} 0 1 0 ${f(cx + rx)},${f(cy)} ` +
    `A${f(rx)},${f(ry)} 0 1 0 ${f(cx - rx)},${f(cy)} Z`
  )
}

function star(cx: number, cy: number, outer: number, inner: number, points: number, turn = 0): string {
  const pts: string[] = []
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const a = turn + (Math.PI * i) / points - Math.PI / 2
    pts.push(`${f(cx + r * Math.cos(a))},${f(cy + r * Math.sin(a))}`)
  }

  return `M${pts.join(' L')} Z`
}

// --- the body plan ------------------------------------------------------------------

type Plan = {
  x: number
  y: number
  w: number
  h: number
  d: string
  eyeY: number
  gap: number
  mouthY: number
  topY: number
  armY: number
}

function plan(shape: BodyShape): Plan {
  switch (shape) {
    case 'round':
      return { x: 29, y: 38, w: 62, h: 50, d: ell(60, 63, 31, 25), eyeY: 60, gap: 12, mouthY: 71, topY: 38, armY: 66 }
    case 'tall':
      return { x: 36, y: 32, w: 48, h: 56, d: rr(36, 32, 48, 56, 23), eyeY: 54, gap: 10, mouthY: 65, topY: 32, armY: 64 }
    case 'ghost': {
      const d =
        'M30,86 V58 A30,30 0 0 1 90,58 V86 Q87,80 82.5,86 Q78,92 73.5,86 Q69,80 64.5,86 ' +
        'Q60,92 55.5,86 Q51,80 46.5,86 Q42,92 37.5,86 Q33,80 30,86 Z'

      return { x: 30, y: 28, w: 60, h: 60, d, eyeY: 55, gap: 11, mouthY: 66, topY: 28, armY: 66 }
    }
    case 'box':
      return { x: 26, y: 40, w: 68, h: 46, d: rr(26, 40, 68, 46, 9), eyeY: 61, gap: 13, mouthY: 74, topY: 40, armY: 64 }
    default:
      return { x: 28, y: 46, w: 64, h: 38, d: rr(28, 46, 64, 38, 14), eyeY: 63, gap: 12, mouthY: 72, topY: 46, armY: 65 }
  }
}

// --- parts ------------------------------------------------------------------------------

export function pivotsOf(design: Design): Pivots {
  const p = plan(design.body.shape)
  const eyeY = design.ears?.kind === 'bulbs' ? p.y + 1 : p.eyeY

  return {
    body: [60, 92],
    eyes: [60, eyeY],
    top: [60, p.topY - 14],
    'arm-l': [p.x + 2, p.armY],
    'arm-r': [p.x + p.w - 2, p.armY],
    tail: [p.x + p.w - 4, p.y + p.h - 8],
  }
}

export function partsOf(design: Design): Part[] {
  const p = plan(design.body.shape)
  const base = design.body.color
  const parts: Part[] = []
  const add = (part: Part) => parts.push(part)
  const ink = design.eyes.kind === 'visor' ? design.eyes.color : dark(base, 0.72)
  const eyeY = design.ears?.kind === 'bulbs' ? p.y + 1 : p.eyeY
  const ex = [60 - p.gap, 60 + p.gap]

  add({ role: 'shadow', d: ell(60, 95, 30, 3.6), fill: '#000000', opacity: 0.16 })

  // tail, behind everything else
  if (design.tail !== null) {
    const tx = p.x + p.w - 4
    const ty = p.y + p.h - 8
    const c = design.tail.color
    if (design.tail.kind === 'cat') {
      add({
        role: 'tail',
        d: `M${f(tx)},${f(ty)} C${f(tx + 22)},${f(ty + 2)} ${f(tx + 22)},${f(ty - 26)} ${f(tx + 10)},${f(ty - 30)}`,
        stroke: c,
        sw: 6,
      })
    } else if (design.tail.kind === 'fluffy') {
      add({ role: 'tail', d: ell(tx + 6, ty + 2, 9), fill: c })
    } else {
      add({
        role: 'tail',
        d: `M${f(tx - 2)},${f(ty - 6)} Q${f(tx + 20)},${f(ty + 2)} ${f(tx + 22)},${f(ty - 18)} L${f(tx + 28)},${f(ty - 14)} L${f(tx + 22)},${f(ty - 24)} Q${f(tx + 14)},${f(ty - 4)} ${f(tx - 2)},${f(ty + 4)} Z`,
        fill: c,
      })
    }
  }

  // ears, also behind the head
  if (design.ears !== null) {
    const { kind, color, inner } = design.ears
    const l = p.x
    const t = p.y
    const r = p.x + p.w
    if (kind === 'cat') {
      add({ role: 'ears', d: `M${f(l + 5)},${f(t + 12)} L${f(l + 10)},${f(t - 12)} L${f(l + 28)},${f(t + 3)} Z`, fill: color })
      add({ role: 'ears', d: `M${f(r - 5)},${f(t + 12)} L${f(r - 10)},${f(t - 12)} L${f(r - 28)},${f(t + 3)} Z`, fill: color })
      add({ role: 'ears', d: `M${f(l + 10)},${f(t + 6)} L${f(l + 12)},${f(t - 5)} L${f(l + 21)},${f(t + 3)} Z`, fill: inner })
      add({ role: 'ears', d: `M${f(r - 10)},${f(t + 6)} L${f(r - 12)},${f(t - 5)} L${f(r - 21)},${f(t + 3)} Z`, fill: inner })
    } else if (kind === 'bunny') {
      add({ role: 'ears', d: ell(60 - 11, t - 12, 6.5, 20), fill: color })
      add({ role: 'ears', d: ell(60 + 11, t - 12, 6.5, 20), fill: color })
      add({ role: 'ears', d: ell(60 - 11, t - 10, 3.2, 14), fill: inner })
      add({ role: 'ears', d: ell(60 + 11, t - 10, 3.2, 14), fill: inner })
    } else if (kind === 'bear') {
      add({ role: 'ears', d: ell(l + 11, t + 5, 9), fill: color })
      add({ role: 'ears', d: ell(r - 11, t + 5, 9), fill: color })
      add({ role: 'ears', d: ell(l + 11, t + 5, 4.8), fill: inner })
      add({ role: 'ears', d: ell(r - 11, t + 5, 4.8), fill: inner })
    } else if (kind === 'horns') {
      add({ role: 'ears', d: `M${f(l + 12)},${f(t + 6)} Q${f(l + 6)},${f(t - 8)} ${f(l + 14)},${f(t - 15)} Q${f(l + 16)},${f(t - 4)} ${f(l + 24)},${f(t + 3)} Z`, fill: color })
      add({ role: 'ears', d: `M${f(r - 12)},${f(t + 6)} Q${f(r - 6)},${f(t - 8)} ${f(r - 14)},${f(t - 15)} Q${f(r - 16)},${f(t - 4)} ${f(r - 24)},${f(t + 3)} Z`, fill: color })
    } else {
      add({ role: 'ears', d: ell(ex[0]!, eyeY, 11), grad: [light(color, 0.2), color] })
      add({ role: 'ears', d: ell(ex[1]!, eyeY, 11), grad: [light(color, 0.2), color] })
      add({ role: 'ears', d: ell(ex[0]!, eyeY, 8), fill: inner })
      add({ role: 'ears', d: ell(ex[1]!, eyeY, 8), fill: inner })
    }
  }

  // legs
  const legColor = dark(base, 0.18)
  if (design.legs === 'stubby') {
    for (const lx of [p.x + 8, p.x + 18, p.x + p.w - 24, p.x + p.w - 14]) {
      add({ role: 'legs', d: rr(lx, p.y + p.h - 6, 6, 98 - (p.y + p.h) - 2, 3), fill: legColor })
    }
  } else if (design.legs === 'feet') {
    add({ role: 'legs', d: ell(60 - 14, 92, 9, 4.5), fill: legColor })
    add({ role: 'legs', d: ell(60 + 14, 92, 9, 4.5), fill: legColor })
  }

  // arms
  if (design.arms) {
    add({ role: 'arm-l', d: rr(p.x - 10, p.armY - 5, 14, 10, 5), grad: [light(base, 0.12), dark(base, 0.08)] })
    add({ role: 'arm-r', d: rr(p.x + p.w - 4, p.armY - 5, 14, 10, 5), grad: [light(base, 0.12), dark(base, 0.08)] })
  }

  // body
  add({ role: 'body', d: p.d, grad: [light(base, 0.22), dark(base, 0.14)] })
  if (design.belly !== null) {
    add({ role: 'body', d: ell(60, p.y + p.h * 0.72, p.w * 0.3, p.h * 0.22), fill: design.belly })
  }
  if (design.pattern !== null) {
    const c = design.pattern.color
    if (design.pattern.kind === 'spots') {
      add({ role: 'body', d: ell(p.x + p.w * 0.2, p.y + p.h * 0.38, 4), fill: c, opacity: 0.85 })
      add({ role: 'body', d: ell(p.x + p.w * 0.82, p.y + p.h * 0.3, 3), fill: c, opacity: 0.85 })
      add({ role: 'body', d: ell(p.x + p.w * 0.75, p.y + p.h * 0.72, 3.5), fill: c, opacity: 0.85 })
    } else {
      for (const dx of [-8, 0, 8]) {
        add({
          role: 'body',
          d: `M${f(60 + dx - 3)},${f(p.y + 2)} Q${f(60 + dx)},${f(p.y + 9)} ${f(60 + dx + 3)},${f(p.y + 2)}`,
          stroke: c,
          sw: 2.6,
        })
      }
    }
  }
  // soft shine on the head
  add({ role: 'body', d: ell(p.x + p.w * 0.27, p.y + Math.min(9, p.h * 0.2), p.w * 0.13, p.h * 0.09), fill: '#FFFFFF', opacity: 0.3 })

  if (design.eyes.kind === 'visor') {
    add({ role: 'body', d: rr(p.x + 8, eyeY - 10, p.w - 16, 21, 7), grad: ['#2A3445', '#161C26'] })
  }

  if (design.cheeks !== null) {
    add({ role: 'body', d: ell(ex[0]! - 7, eyeY + 8, 5, 3), fill: design.cheeks, opacity: 0.55 })
    add({ role: 'body', d: ell(ex[1]! + 7, eyeY + 8, 5, 3), fill: design.cheeks, opacity: 0.55 })
  }

  // eyes, one set per expression
  const e = design.eyes
  for (const x of ex) {
    if (e.kind === 'visor') {
      add({ role: 'eyes-open', d: rr(x - 4, eyeY - 4, 8, 8, 2.5), fill: e.color })
      add({ role: 'eyes-open', d: rr(x - 2.6, eyeY - 2.8, 2.6, 2.6, 1), fill: '#FFFFFF', opacity: 0.8 })
    } else {
      const [rx, ry] = e.kind === 'oval' ? [3.4, 6] : e.kind === 'dot' ? [2.8, 3.1] : [4.2, 5]
      add({ role: 'eyes-open', d: ell(x, eyeY, rx, ry), fill: e.color })
      add({ role: 'eyes-open', d: ell(x - rx * 0.35, eyeY - ry * 0.38, Math.max(1.1, rx * 0.36)), fill: '#FFFFFF' })
      add({ role: 'eyes-open', d: ell(x + rx * 0.38, eyeY + ry * 0.4, Math.max(0.6, rx * 0.18)), fill: '#FFFFFF', opacity: 0.75 })
    }
    add({ role: 'eyes-happy', d: `M${f(x - 4.5)},${f(eyeY + 1.5)} Q${f(x)},${f(eyeY - 4.5)} ${f(x + 4.5)},${f(eyeY + 1.5)}`, stroke: ink, sw: 2.6 })
    add({ role: 'eyes-closed', d: `M${f(x - 4.5)},${f(eyeY)} Q${f(x)},${f(eyeY + 3.5)} ${f(x + 4.5)},${f(eyeY)}`, stroke: ink, sw: 2.4 })
    add({ role: 'eyes-x', d: `M${f(x - 3.5)},${f(eyeY - 3.5)} L${f(x + 3.5)},${f(eyeY + 3.5)} M${f(x + 3.5)},${f(eyeY - 3.5)} L${f(x - 3.5)},${f(eyeY + 3.5)}`, stroke: ink, sw: 2.4 })
  }

  // mouths
  const my = p.mouthY
  add({ role: 'mouth-smile', d: `M${f(54.5)},${f(my - 1)} Q60,${f(my + 5)} 65.5,${f(my - 1)}`, stroke: ink, sw: 2.2 })
  add({ role: 'mouth-small', d: `M57,${f(my)} Q60,${f(my + 2.4)} 63,${f(my)}`, stroke: ink, sw: 2 })
  add({ role: 'mouth-open', d: ell(60, my + 1.5, 3.4, 3.2), fill: ink })
  add({ role: 'mouth-flat', d: `M55,${f(my + 1)} H65`, stroke: ink, sw: 2.2 })

  // the thing on top
  if (design.top !== null) {
    const c = design.top.color
    const ty = p.topY
    if (design.top.kind === 'spark') {
      add({ role: 'top-stem', d: rr(58.9, ty - 7, 2.2, 8, 1.1), fill: dark(base, 0.05) })
      add({ role: 'top', d: star(60, ty - 14, 9.5, 3.2, 8), grad: [light(c, 0.25), c] })
    } else if (design.top.kind === 'antenna') {
      add({ role: 'top-stem', d: rr(58.8, ty - 10, 2.4, 11, 1.2), fill: dark(base, 0.2) })
      add({ role: 'top', d: ell(60, ty - 13, 4.2), grad: [light(c, 0.35), c] })
    } else if (design.top.kind === 'leaf') {
      add({ role: 'top', d: `M60,${f(ty + 1)} Q59,${f(ty - 6)} 60,${f(ty - 10)}`, stroke: '#4E8F3A', sw: 2.2 })
      add({ role: 'top', d: `M60,${f(ty - 9)} Q50,${f(ty - 18)} 47,${f(ty - 10)} Q53,${f(ty - 6)} 60,${f(ty - 9)} Z`, fill: c })
      add({ role: 'top', d: `M60,${f(ty - 9)} Q70,${f(ty - 20)} 74,${f(ty - 12)} Q67,${f(ty - 6)} 60,${f(ty - 9)} Z`, fill: light(c, 0.15) })
    } else if (design.top.kind === 'flame') {
      add({ role: 'top', d: `M60,${f(ty - 24)} Q70,${f(ty - 12)} 66,${f(ty - 4)} Q60,${f(ty + 1)} 54,${f(ty - 4)} Q50,${f(ty - 12)} 60,${f(ty - 24)} Z`, grad: ['#FFE07A', c] })
      add({ role: 'top', d: `M60,${f(ty - 14)} Q64,${f(ty - 8)} 62,${f(ty - 4)} Q60,${f(ty - 2)} 58,${f(ty - 4)} Q56,${f(ty - 8)} 60,${f(ty - 14)} Z`, fill: '#FFF4C2' })
    } else {
      add({
        role: 'top',
        d: `M48,${f(ty + 1)} L48,${f(ty - 10)} L54,${f(ty - 4)} L60,${f(ty - 13)} L66,${f(ty - 4)} L72,${f(ty - 10)} L72,${f(ty + 1)} Z`,
        grad: [light(c, 0.3), c],
      })
    }
  }

  // effects, shown per mood
  const cloud = '#FFFFFF'
  add({ role: 'fx-think', d: ell(83, 38, 2.2), fill: cloud })
  add({ role: 'fx-think', d: ell(88, 31, 3.2), fill: cloud })
  add({ role: 'fx-think', d: ell(97, 19, 13, 9), fill: '#D9DEE6' })
  add({ role: 'fx-think', d: ell(97, 19, 12, 8), fill: cloud })
  add({ role: 'fx-dot1', d: ell(91, 19, 1.9), fill: '#6B7280' })
  add({ role: 'fx-dot2', d: ell(97, 19, 1.9), fill: '#6B7280' })
  add({ role: 'fx-dot3', d: ell(103, 19, 1.9), fill: '#6B7280' })

  add({ role: 'fx-bang', d: rr(97, 14, 7, 17, 3.5), grad: ['#FFE07A', '#F2B705'] })
  add({ role: 'fx-bang', d: ell(100.5, 37, 3.6), fill: '#F2B705' })

  add({ role: 'fx-spark1', d: star(20, 30, 7, 2, 4), fill: '#F7C948' })
  add({ role: 'fx-spark2', d: star(103, 26, 6, 1.8, 4), fill: '#F7C948' })
  add({ role: 'fx-spark3', d: star(106, 66, 4.5, 1.4, 4), fill: '#FFE07A' })

  add({ role: 'fx-z1', d: 'M92,40 H100 L92,48 H100', stroke: '#9AA3B2', sw: 2.4 })
  add({ role: 'fx-z2', d: 'M102,28 H107 L102,33 H107', stroke: '#B4BBC6', sw: 2 })

  add({ role: 'fx-drop', d: 'M98,50 Q103,57 98,61 Q93,57 98,50 Z', grad: ['#A9D6F7', '#4A9BE0'] })

  // reactions to the person: hearts when petted, swirls when shaken
  const heart = (x: number, y: number, s: number) =>
    `M${f(x)},${f(y + 3 * s)} C${f(x)},${f(y - s)} ${f(x - 6 * s)},${f(y - s)} ${f(x - 6 * s)},${f(y + 3 * s)} ` +
    `C${f(x - 6 * s)},${f(y + 7 * s)} ${f(x)},${f(y + 9 * s)} ${f(x)},${f(y + 12 * s)} ` +
    `C${f(x)},${f(y + 9 * s)} ${f(x + 6 * s)},${f(y + 7 * s)} ${f(x + 6 * s)},${f(y + 3 * s)} ` +
    `C${f(x + 6 * s)},${f(y - s)} ${f(x)},${f(y - s)} ${f(x)},${f(y + 3 * s)} Z`
  add({ role: 'fx-heart1', d: heart(92, 30, 0.75), grad: ['#FF9DB5', '#F0607F'] })
  add({ role: 'fx-heart2', d: heart(26, 36, 0.55), grad: ['#FF9DB5', '#F0607F'] })
  for (const x of ex) {
    add({
      role: 'eyes-dizzy',
      d: `M${f(x)},${f(eyeY)} m-1,0 a1,1 0 1 1 2,0 a2,2 0 1 1 -4,0 a3,3 0 1 1 6,0`,
      stroke: ink,
      sw: 1.6,
    })
  }

  add({ role: 'laptop', d: rr(40, 64, 40, 25, 3), grad: ['#465063', '#262B35'] })
  add({ role: 'laptop', d: rr(33, 88, 54, 4.5, 2), grad: ['#C3CAD5', '#8D97A6'] })
  add({ role: 'laptop-logo', d: star(60, 76, 5.5, 1.9, 8), fill: '#F4A27E' })

  return parts
}

// --- what each mood shows (the window decides the motion) --------------------------

export const SHOWN: Record<PetMood, string[]> = {
  idle: ['eyes-open', 'mouth-small'],
  thinking: ['eyes-open', 'fx-think', 'fx-dot1', 'fx-dot2', 'fx-dot3'],
  working: ['eyes-open', 'laptop', 'laptop-logo'],
  waiting: ['eyes-open', 'mouth-open', 'fx-bang'],
  done: ['eyes-happy', 'mouth-smile', 'fx-spark1', 'fx-spark2', 'fx-spark3'],
  error: ['eyes-x', 'mouth-flat', 'fx-drop'],
  sleeping: ['eyes-closed', 'fx-z1', 'fx-z2'],
}

const ALWAYS = new Set(['shadow', 'tail', 'ears', 'legs', 'arm-l', 'arm-r', 'body', 'top-stem', 'top'])

export function isShown(role: string, mood: PetMood): boolean {
  return ALWAYS.has(role) || SHOWN[mood].includes(role)
}

// --- the built-in pets (eight, like Codex) -----------------------------------------

const base: Omit<Design, 'name' | 'body' | 'eyes'> = {
  belly: null,
  pattern: null,
  ears: null,
  top: null,
  cheeks: null,
  arms: false,
  legs: 'stubby',
  tail: null,
}

export type Preset = { id: string; aliases: string[]; design: Design }

export const PRESETS: Preset[] = [
  {
    id: 'claude',
    aliases: ['клод', 'claude', 'клауд'],
    design: {
      ...base,
      name: 'Клод',
      body: { shape: 'blob', color: '#D97757' },
      eyes: { kind: 'round', color: '#2A1A14' },
      top: { kind: 'spark', color: '#F08D66' },
      cheeks: '#F7A58F',
      arms: true,
    },
  },
  {
    id: 'cat',
    aliases: ['кот', 'котик', 'кошка', 'cat'],
    design: {
      ...base,
      name: 'Котик',
      body: { shape: 'round', color: '#A9AFBA' },
      belly: '#E9ECF1',
      ears: { kind: 'cat', color: '#A9AFBA', inner: '#F3B1BC' },
      eyes: { kind: 'oval', color: '#2F7D46' },
      cheeks: '#F3B1BC',
      legs: 'feet',
      tail: { kind: 'cat', color: '#959BA6' },
    },
  },
  {
    id: 'robot',
    aliases: ['робот', 'робо', 'robot', 'bot'],
    design: {
      ...base,
      name: 'Робот',
      body: { shape: 'box', color: '#8C9BB5' },
      eyes: { kind: 'visor', color: '#5FE3FF' },
      top: { kind: 'antenna', color: '#FF5A5A' },
      arms: true,
    },
  },
  {
    id: 'ghost',
    aliases: ['призрак', 'привидение', 'ghost', 'бу'],
    design: {
      ...base,
      name: 'Призрак',
      body: { shape: 'ghost', color: '#F4F1EC' },
      eyes: { kind: 'round', color: '#3A3550' },
      cheeks: '#F6B8C4',
      legs: 'none',
    },
  },
  {
    id: 'frog',
    aliases: ['лягушка', 'лягуха', 'жаба', 'frog'],
    design: {
      ...base,
      name: 'Лягушка',
      body: { shape: 'round', color: '#6DBE4B' },
      belly: '#D9F0A3',
      ears: { kind: 'bulbs', color: '#6DBE4B', inner: '#FFFFFF' },
      eyes: { kind: 'dot', color: '#1E2A1E' },
      cheeks: '#F2A7B0',
      legs: 'feet',
    },
  },
  {
    id: 'bunny',
    aliases: ['зайка', 'заяц', 'кролик', 'bunny'],
    design: {
      ...base,
      name: 'Зайка',
      body: { shape: 'tall', color: '#F1E7DD' },
      ears: { kind: 'bunny', color: '#F1E7DD', inner: '#F6B8C4' },
      eyes: { kind: 'round', color: '#3A2A2A' },
      cheeks: '#F6B8C4',
      legs: 'feet',
      tail: { kind: 'fluffy', color: '#FFFFFF' },
    },
  },
  {
    id: 'bear',
    aliases: ['мишка', 'медведь', 'bear'],
    design: {
      ...base,
      name: 'Мишка',
      body: { shape: 'round', color: '#A0714F' },
      belly: '#D9B48F',
      ears: { kind: 'bear', color: '#A0714F', inner: '#D9A47F' },
      eyes: { kind: 'dot', color: '#24170F' },
      cheeks: '#E8957F',
      arms: true,
      legs: 'feet',
    },
  },
  {
    id: 'dragon',
    aliases: ['дракон', 'дракоша', 'dragon'],
    design: {
      ...base,
      name: 'Дракоша',
      body: { shape: 'blob', color: '#8E6CCF' },
      belly: '#C9B6EE',
      pattern: { kind: 'spots', color: '#7656B8' },
      ears: { kind: 'horns', color: '#F2D27A', inner: '#F2D27A' },
      eyes: { kind: 'round', color: '#22163A' },
      cheeks: '#F0A6C8',
      arms: true,
      tail: { kind: 'dragon', color: '#7E5EC2' },
    },
  },
]

export function findPreset(query: string): Preset | undefined {
  const q = query.trim().toLowerCase()
  if (q === '') return undefined

  return PRESETS.find(
    p => p.id === q || p.design.name.toLowerCase() === q || p.aliases.some(a => a === q || a.startsWith(q)),
  )
}

// --- /hatch: the model fills a Design, and this keeps it inside the lines ----------

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
const color = (v: unknown, fallback: string) => (typeof v === 'string' && HEX.test(v) ? v.toUpperCase() : fallback)
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

export function sanitize(raw: unknown, fallbackName: string): Design {
  const o = obj(raw) ?? {}
  const body = obj(o.body) ?? {}
  const bodyColor = color(body.color, '#D97757')
  const eyes = obj(o.eyes) ?? {}
  const ears = obj(o.ears)
  const top = obj(o.top)
  const tail = obj(o.tail)
  const pattern = obj(o.pattern)
  const name = typeof o.name === 'string' && o.name.trim() !== '' ? o.name.trim().slice(0, 24) : fallbackName

  return {
    name,
    body: { shape: pick(body.shape, ['blob', 'round', 'tall', 'ghost', 'box'] as const, 'round'), color: bodyColor },
    belly: o.belly === null || o.belly === undefined ? null : color(o.belly, light(bodyColor, 0.5)),
    pattern:
      pattern === null
        ? null
        : { kind: pick(pattern.kind, ['spots', 'stripes'] as const, 'spots'), color: color(pattern.color, dark(bodyColor, 0.2)) },
    ears:
      ears === null
        ? null
        : {
            kind: pick(ears.kind, ['cat', 'bunny', 'bear', 'horns', 'bulbs'] as const, 'cat'),
            color: color(ears.color, bodyColor),
            inner: color(ears.inner, '#F3B1BC'),
          },
    top:
      top === null
        ? null
        : { kind: pick(top.kind, ['spark', 'antenna', 'leaf', 'flame', 'crown'] as const, 'spark'), color: color(top.color, '#F7C948') },
    eyes: { kind: pick(eyes.kind, ['round', 'oval', 'dot', 'visor'] as const, 'round'), color: color(eyes.color, '#2A1A14') },
    cheeks: o.cheeks === null || o.cheeks === undefined ? null : color(o.cheeks, '#F6B8C4'),
    arms: o.arms === true,
    legs: pick(o.legs, ['stubby', 'feet', 'none'] as const, 'feet'),
    tail:
      tail === null
        ? null
        : { kind: pick(tail.kind, ['cat', 'fluffy', 'dragon'] as const, 'cat'), color: color(tail.color, dark(bodyColor, 0.1)) },
  }
}

export const HATCH_PROMPT = `Ты дизайнер милых питомцев-компаньонов для программиста. По описанию пользователя собери питомца из готовых деталей.
Ответь ТОЛЬКО одним JSON-объектом, без пояснений и без markdown, по этой схеме:
{
  "name": "короткое имя по-русски",
  "body": { "shape": "blob" | "round" | "tall" | "ghost" | "box", "color": "#RRGGBB" },
  "belly": "#RRGGBB" | null,
  "pattern": { "kind": "spots" | "stripes", "color": "#RRGGBB" } | null,
  "ears": { "kind": "cat" | "bunny" | "bear" | "horns" | "bulbs", "color": "#RRGGBB", "inner": "#RRGGBB" } | null,
  "top": { "kind": "spark" | "antenna" | "leaf" | "flame" | "crown", "color": "#RRGGBB" } | null,
  "eyes": { "kind": "round" | "oval" | "dot" | "visor", "color": "#RRGGBB" },
  "cheeks": "#RRGGBB" | null,
  "arms": true | false,
  "legs": "stubby" | "feet" | "none",
  "tail": { "kind": "cat" | "fluffy" | "dragon", "color": "#RRGGBB" } | null
}
Подсказки: blob — широкий с ручками, round — круглый, tall — вытянутый, ghost — привидение (legs: "none"), box — робот (eyes: "visor").
bulbs — глаза-шарики как у лягушки, horns — рожки. Цвета гармоничные, мягкие; глаза тёмные (у visor — светящиеся).

Описание пользователя: `

// --- the in-app pane: the same parts as one SVG -------------------------------------

const MOVES_WITH_BODY = new Set(['tail', 'ears', 'arm-l', 'arm-r', 'body', 'top-stem', 'top'])

export function svgOf(design: Design, mood: PetMood, width = VW * 1.4): string {
  const pivots = pivotsOf(design)
  const defs: string[] = []
  const draw = (part: Part) => {
    let fill = 'none'
    if (part.grad !== undefined) {
      const id = `g${defs.length}`
      defs.push(
        `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${part.grad[0]}"/><stop offset="1" stop-color="${part.grad[1]}"/></linearGradient>`,
      )
      fill = `url(#${id})`
    } else if (part.fill !== undefined) {
      fill = part.fill
    }
    const stroke = part.stroke === undefined ? '' : ` stroke="${part.stroke}" stroke-width="${part.sw ?? 2}" stroke-linecap="round" stroke-linejoin="round"`
    const opacity = part.opacity === undefined ? '' : ` opacity="${part.opacity}"`

    return `<path d="${part.d}" fill="${fill}"${stroke}${opacity}/>`
  }
  const shown = partsOf(design).filter(p => isShown(p.role, mood))
  const of = (test: (role: string) => boolean) => shown.filter(p => test(p.role)).map(draw).join('')
  const [ex, ey] = pivots.eyes
  const bob =
    mood === 'working'
      ? 'values="0 0;0 -1.2;0 0" dur="0.35s"'
      : mood === 'done'
        ? 'values="0 0;0 -10;0 0;0 -4;0 0" dur="1.1s"'
        : mood === 'sleeping'
          ? 'values="0 0;0 0.8;0 0" dur="3.8s"'
          : 'values="0 0;0 -1.8;0 0" dur="2.6s"'
  const blink =
    mood === 'sleeping' || mood === 'done' || mood === 'error'
      ? ''
      : `<animateTransform attributeName="transform" type="scale" values="1 1;1 1;1 0.1;1 1" keyTimes="0;0.95;0.975;1" dur="4.3s" repeatCount="indefinite"/>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" width="${f(width)}" height="${f((width * VH) / VW)}">` +
    of(role => role === 'shadow' || role === 'legs') +
    `<g><animateTransform attributeName="transform" type="translate" ${bob} repeatCount="indefinite"/>` +
    of(role => MOVES_WITH_BODY.has(role)) +
    `<g transform="translate(${ex} ${ey})"><g>${blink}<g transform="translate(${-ex} ${-ey})">` +
    of(role => role.startsWith('eyes-')) +
    '</g></g></g>' +
    of(role => role.startsWith('mouth-')) +
    '</g>' +
    `<g><animate attributeName="opacity" values="1;0.55;1" dur="1.4s" repeatCount="indefinite"/>` +
    of(role => role.startsWith('fx-') || role.startsWith('laptop')) +
    '</g>' +
    `<defs>${defs.join('')}</defs></svg>`
  )
}
