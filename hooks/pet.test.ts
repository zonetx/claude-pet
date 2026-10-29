import { expect, test } from 'claude-code/testing'

import { PRESETS, SHOWN, partsOf, sanitize, svgOf } from './design'
import { describeTool } from './register'

const MOODS = ['idle', 'thinking', 'working', 'waiting', 'done', 'error', 'sleeping'] as const
const PANE_PROPS = {
  title: 'Клод',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
} as const

test('the tooltip names what Claude is doing', () => {
  expect(describeTool('Read', { file_path: 'C:\\proj\\src\\App.tsx' })).toBe('Читаю App.tsx')
  expect(describeTool('Bash', { command: 'npm test' })).toBe('Запускаю: npm test')
})

test('eight built-in pets, each drawn for every mood', () => {
  expect(PRESETS.length).toBe(8)
  for (const preset of PRESETS) {
    const parts = partsOf(preset.design)
    expect(parts.some(p => p.role === 'body')).toBe(true)
    for (const mood of MOODS) {
      for (const role of SHOWN[mood]) expect(parts.some(p => p.role === role)).toBe(true)
      expect(svgOf(preset.design, mood)).toMatch(/^<svg[\s\S]*<\/svg>$/)
    }
  }
})

test('a hatched design is kept inside the lines', () => {
  const design = sanitize(
    {
      name: 'Искорка',
      body: { shape: 'teapot', color: 'red' },
      eyes: { kind: 'visor', color: '#5fe3ff' },
      top: { kind: 'crown', color: '#F7C948' },
      legs: 'wheels',
    },
    'запасное имя',
  )
  expect(design).toMatchObject({
    name: 'Искорка',
    body: { shape: 'round', color: '#D97757' },
    eyes: { kind: 'visor', color: '#5FE3FF' },
    top: { kind: 'crown' },
    legs: 'feet',
    ears: null,
  })
  expect(sanitize('не json', 'Пушок').name).toBe('Пушок')
})

type Situation = { claude: boolean; idle?: number; said: string; tool: string; input: Record<string, unknown> }

/** Raises Claude Code's permission request with the pet's files and waiter stubbed. */
async function askPermission($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], s: Situation) {
  const seen = { waited: false, asked: [] as string[] }
  on('clock.now', () => ({ value: 1_000 }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('fs.write', (_$, e) => {
    const w = e as unknown as { path: string; text: string }
    if (w.path.includes('asks') && !w.text.includes('"gone"')) seen.asked.push(w.text)

    return { value: undefined } as never
  })
  on('fs.read', () => ({ value: JSON.stringify({ claude: s.claude, idle: s.idle ?? 0, at: Date.now() }) }) as never)
  on('process.run', () => {
    seen.waited = true

    return { value: { exitCode: 0, stdout: `${s.said}\n`, stderr: '' } } as never
  })
  on('classic.PermissionRequest', () => ({}) as never)

  const result = (await $.classic.PermissionRequest({
    tool_name: s.tool,
    tool_input: s.input,
    permission_suggestions: [],
  } as never)) as { decision?: { behavior: string } }

  return { ...seen, behavior: result.decision?.behavior ?? 'ask in Claude' }
}

const NPM = { tool: 'Bash', input: { command: 'npm test' } }

test('away from Claude, allowed on the pet', async ($, on) => {
  const r = await askPermission($, on, { ...NPM, claude: false, said: 'allow' })
  expect(r.behavior).toBe('allow')
  expect(r.waited).toBe(true)
  // the card names the real command, not an empty one
  expect(r.asked.length).toBe(1)
  expect(JSON.parse(r.asked[0]!)).toMatchObject({ title: 'Запускаю: npm test', detail: 'npm test' })
})

test('away from Claude, denied on the pet', async ($, on) => {
  const r = await askPermission($, on, { ...NPM, claude: false, said: 'deny' })
  expect(r.behavior).toBe('deny')
})

test('in Claude, the question stays in Claude', async ($, on) => {
  const r = await askPermission($, on, { ...NPM, claude: true, said: 'allow' })
  expect(r.behavior).toBe('ask in Claude')
  expect(r.waited).toBe(false)
})

test('away from the computer (on a phone), the question stays in Claude', async ($, on) => {
  const r = await askPermission($, on, { ...NPM, claude: false, idle: 300, said: 'allow' })
  expect(r.behavior).toBe('ask in Claude')
  expect(r.waited).toBe(false)
})

test('a question only Claude can ask stays in Claude even while away', async ($, on) => {
  const r = await askPermission($, on, { tool: 'AskUserQuestion', input: { questions: [] }, claude: false, said: 'allow' })
  expect(r.behavior).toBe('ask in Claude')
  expect(r.waited).toBe(false)
})

test('a tool the auto mode allows never shows the pet waiting', async ($, on) => {
  let wroteWaiting = false
  on('clock.now', () => ({ value: 1_000 }) as never)
  on('fs.write', (_$, e) => {
    if ((e as unknown as { text: string }).text.includes('"waiting"')) wroteWaiting = true

    return { value: undefined } as never
  })
  on('tool.check', () => ({ decision: 'ask' }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)

  await $.tool.check({ tool: 'Bash', input: { command: 'ls' } } as never)
  expect(wroteWaiting).toBe(false)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane draws the pet on ${surface}`, async $ => {
    const ui = await $.ui.mount({
      plugin: 'pixel-pet',
      surface,
      component: 'Pane',
      requestId: 'pixel-pet',
      props: PANE_PROPS as never,
    })

    const found = surface === 'desktop' ? await ui.find({ type: 'Svg' }) : await ui.find({ text: /Клод/ })
    expect(found).toBeDefined()
  })
}
