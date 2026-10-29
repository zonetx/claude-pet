export type PetMood =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'waiting'
  | 'done'
  | 'error'
  | 'sleeping'

export type Pet = {
  mood: PetMood
  text: string
  since: number
  tools: number
  active: number
  turnStart: number
}

export type BodyShape = 'blob' | 'round' | 'tall' | 'ghost' | 'box'
export type EarKind = 'cat' | 'bunny' | 'bear' | 'horns' | 'bulbs'
export type TopKind = 'spark' | 'antenna' | 'leaf' | 'flame' | 'crown'
export type EyeKind = 'round' | 'oval' | 'dot' | 'visor'
export type TailKind = 'cat' | 'fluffy' | 'dragon'
export type Legs = 'stubby' | 'feet' | 'none'

export type Design = {
  name: string
  body: { shape: BodyShape; color: string }
  belly: string | null
  pattern: { kind: 'spots' | 'stripes'; color: string } | null
  ears: { kind: EarKind; color: string; inner: string } | null
  top: { kind: TopKind; color: string } | null
  eyes: { kind: EyeKind; color: string }
  cheeks: string | null
  arms: boolean
  legs: Legs
  tail: { kind: TailKind; color: string } | null
}

declare module 'claude-code' {
  interface PluginState {
    'pixel-pet': { pet: Pet; design: Design }
  }
}
