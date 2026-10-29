import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pet, PetMood } from '../types'
import type { Design } from '../types'
import { HATCH_PROMPT, PRESETS, SHOWN, findPreset, partsOf, pivotsOf, sanitize, svgOf } from './design'

const PANE = 'pixel-pet'
const DONE_MS = 10_000
const SLEEP_MS = 5 * 60_000
const HEARTBEAT_MS = 20_000
const ASKS_THE_PERSON = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'])

const pet = atom({ plugin: 'pixel-pet', key: 'pet' } as const, {
  mood: 'idle',
  text: 'Жду задачу',
  since: 0,
  tools: 0,
  active: 0,
  turnStart: 0,
} as Pet)
const petDesign = atom({ plugin: 'pixel-pet', key: 'design' } as const, PRESETS[0]!.design as Design)

// --- the shared folder every session and the floating window use ---------------

let sessionId = ''
let sessionLabel = 'Claude Code'
// this session's own process: the window drops the session the moment it exits
let enginePid = 0

function overlayDir($: EngineInterface): string {
  return `${$.plugin.root}\\overlay`
}

function canFloat($: EngineInterface): boolean {
  return /^[A-Za-z]:[\\/]/.test($.plugin.root)
}

async function writeJson($: EngineInterface, name: string, value: unknown) {
  try {
    await $.fs.write(`${overlayDir($)}\\${name}`, JSON.stringify(value))
  } catch {
    // the window keeps what it last read
  }
}

async function writeSession($: EngineInterface, isGone = false) {
  if (!canFloat($) || sessionId === '') return
  const p = await read($, pet)
  await writeJson($, `sessions\\${sessionId}.json`, {
    id: sessionId,
    label: sessionLabel,
    mood: p.mood,
    text: p.text,
    changed: Date.now(),
    pid: enginePid,
    gone: isGone,
  })
}

async function writePet($: EngineInterface) {
  if (!canFloat($)) return
  const design = await read($, petDesign)
  await writeJson($, 'pet.json', {
    name: design.name,
    topKind: design.top?.kind ?? '',
    parts: partsOf(design),
    pivots: pivotsOf(design),
    shown: SHOWN,
  })
}

/** Whether the floating window runs now: it stamps focus.json every few seconds. */
async function isOverlayRunning($: EngineInterface): Promise<boolean> {
  const focus = await readJson($, 'focus.json')

  return focus !== undefined && Date.now() - Number(focus.at) < 15_000
}

async function launchOverlay($: EngineInterface) {
  if (!canFloat($)) return
  await writeJson($, 'prefs.json', { shown: true })
  const dir = overlayDir($)
  // Started through WMI so the window outlives this session's process tree;
  // the window itself keeps to one copy for all sessions.
  // conhost --headless gives PowerShell a console nobody sees, so nothing flashes.
  const command =
    `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ ` +
    `CommandLine = 'conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "${dir}\\pet-overlay.ps1" -Dir "${dir}"' } | Out-Null`
  try {
    await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command], {
      timeoutMs: 20_000,
    })
  } catch {
    // nothing floats; the pane still works
  }
}

async function setMood(
  $: EngineInterface,
  mood: PetMood,
  text: string,
  change: (p: Pet) => Partial<Pet> = () => ({}),
) {
  const now = await $.clock.now()
  await update($, pet, p => ({ ...p, ...change(p), mood, text, since: now }))
  await writeSession($)
}

// --- what the pet is doing, in words (tooltip and menu) ---------------------------

function base(path: unknown): string {
  return String(path ?? '').split(/[\\/]/).pop() || 'файл'
}

function short(text: unknown, max = 40): string {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

export function describeTool(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Read':
      return `Читаю ${base(input.file_path)}`
    case 'Write':
      return `Пишу ${base(input.file_path)}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Правлю ${base(input.file_path ?? input.notebook_path)}`
    case 'Bash':
    case 'PowerShell':
      return `Запускаю: ${short(input.command)}`
    case 'Grep':
      return `Ищу «${short(input.pattern, 30)}»`
    case 'Glob':
      return `Ищу файлы ${short(input.pattern, 30)}`
    case 'WebSearch':
      return `Ищу в интернете: ${short(input.query, 30)}`
    case 'WebFetch':
      return 'Читаю страницу в интернете'
    case 'Agent':
    case 'Task':
      return 'Зову помощника'
    case 'TodoWrite':
      return 'Обновляю план'
    case 'Skill':
      return `Достаю навык ${short(input.skill, 30)}`
  }
  if (tool.includes('Browser') || tool.includes('chrome')) return 'Работаю в браузере'
  if (tool.startsWith('mcp__')) return `Использую ${short(tool.split('__').pop(), 30)}`

  return `Работаю: ${short(tool, 30)}`
}

/** What exactly Claude wants to do, for the pet's permission card. */
export function askDetail(tool: string, input: Record<string, unknown>): string {
  const pick = input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.query ?? input.pattern
  if (typeof pick === 'string' && pick !== '') return short(pick, 220)
  const rest = Object.fromEntries(
    Object.entries(input).filter(([k]) => !['tool', 'tool_use_id', 'consent', 'agentId'].includes(k)),
  )

  return short(`${tool} ${JSON.stringify(rest)}`, 220)
}

async function readJson($: EngineInterface, name: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await $.fs.read(`${overlayDir($)}\\${name}`)
    const value: unknown = JSON.parse(typeof text === 'string' ? text : String(text))

    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Puts a permission question on the floating pet when the person is in
 * another window, and waits for their click. `app` hands it back to Claude's
 * own dialog: Claude is in front, the pet is not running, or no answer came.
 */
async function askOnPet(
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>,
  what: string,
): Promise<'allow' | 'deny' | 'app'> {
  // A question only the person can answer in Claude (a choice, a plan) stays there:
  // allowing it from the pet would not close Claude's own dialog.
  if (ASKS_THE_PERSON.has(tool)) return 'app'
  if (!canFloat($) || (await $.store.get('askOnPet')) === false) return 'app'
  const focus = await readJson($, 'focus.json')
  const isFresh = focus !== undefined && Date.now() - Number(focus.at) < 15_000
  if (!isFresh || focus.claude === true) return 'app'
  // Away from the computer (following from a phone, say): Claude's own dialog
  // reaches the person wherever they are; the pet's card would not.
  if (Number(focus.idle ?? 0) > 60) return 'app'
  try {
    if ((await $.session.surfaces()).includes('mobile')) return 'app'
  } catch {
    // no surface list: rely on the idle time alone
  }

  const id = `${sessionId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const dir = overlayDir($)
  await writeJson($, `asks\\${id}.json`, {
    id,
    session: sessionId,
    label: sessionLabel,
    title: what,
    detail: askDetail(tool, input),
    created: Date.now(),
  })
  try {
    const run = await $.process.run(
      [
        'powershell.exe',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        `${dir}\\wait-answer.ps1`,
        '-Answer',
        `${dir}\\answers\\${id}.json`,
        '-Focus',
        `${dir}\\focus.json`,
      ],
      { timeoutMs: 600_000 },
    )
    const said = run.stdout.trim()

    return said === 'allow' || said === 'deny' ? said : 'app'
  } catch {
    return 'app'
  } finally {
    await writeJson($, `asks\\${id}.json`, { id, gone: true })
  }
}

function parseDesign(text: string, fallbackName: string): Design | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return sanitize(JSON.parse(text.slice(start, end + 1)), fallbackName)
  } catch {
    return undefined
  }
}

async function useDesign($: EngineInterface, design: Design) {
  await update($, petDesign, () => design)
  await $.store.set('design', design)
  await writePet($)
}

// --- the mod ------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pet',
      description: 'Your floating Claude pet: /pet to show or hide, /pet skin to pick one',
      argumentHint: '[show | hide | skin <питомец> | name <имя> | ask on|off | panel]',
    })
    await $.command.register({
      name: 'hatch',
      description: 'Hatch a new pet from a description (/hatch розовый дракончик с короной)',
      argumentHint: '<описание питомца>',
    })

    try {
      sessionId = await $.session.id()
    } catch {
      sessionId = `s${Date.now()}`
    }
    sessionLabel = base(e.cwd) || 'Claude Code'

    const saved = await $.store.get('design')
    if (saved !== undefined) {
      await update($, petDesign, () => sanitize(saved, 'Клод'))
    }
    await setMood($, 'idle', 'Жду задачу', () => ({ active: 0 }))
    await writePet($)

    if (canFloat($)) {
      // every session that opens brings the pet back, however it was put away before
      await $.store.set('shown', true)
      void launchOverlay($)
      void (async () => {
        try {
          // a command's parent is this session's own process
          const run = await $.process.run(
            [
              'powershell.exe',
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              '(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId',
            ],
            { timeoutMs: 20_000 },
          )
          enginePid = Number(run.stdout.trim()) || 0
          await writeSession($)
        } catch {
          // without it the window falls back to the heartbeat
        }
      })()
    } else {
      void $.ui.open({ id: PANE, title: (await read($, petDesign)).name })
    }

    $.clock.every(5_000, () => {
      void (async () => {
        const p = await read($, pet)
        const now = await $.clock.now()
        const age = now - p.since
        if ((p.mood === 'done' || p.mood === 'error') && age > DONE_MS) {
          await setMood($, 'idle', 'Жду задачу')
        } else if (p.mood === 'idle' && age > SLEEP_MS) {
          await setMood($, 'sleeping', 'Сплю')
        }
      })()
    })
    $.clock.every(HEARTBEAT_MS, () => void writeSession($))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await writeSession($, true)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.command === undefined && !e.isMeta) {
      const now = await $.clock.now()
      await setMood($, 'thinking', 'Думаю над задачей', () => ({ tools: 0, active: 0, turnStart: now }))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Fires only when Claude Code is about to ask the person (not when a rule or
  // the auto mode settles the call), so the pet waits exactly when they are asked.
  on('classic.PermissionRequest', async ($, e, next) => {
    const input = (typeof e.tool_input === 'object' && e.tool_input !== null ? e.tool_input : {}) as Record<
      string,
      unknown
    >
    const what = describeTool(e.tool_name, input)
    await setMood($, 'waiting', `Нужно разрешение: ${what}`)

    // Asked on the pet only while the person is at the computer but away from
    // Claude: otherwise Claude's own dialog asks, as always.
    const answer = await askOnPet($, e.tool_name, input, what)
    if (answer === 'allow') {
      await setMood($, 'working', what)

      return { decision: { behavior: 'allow' } }
    }
    if (answer === 'deny') {
      await setMood($, 'thinking', 'Отклонено с питомца')

      return { decision: { behavior: 'deny', message: 'Пользователь отклонил это действие (ответ с питомца).' } }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    await setMood($, 'working', describeTool(e.tool, input), p => ({
      tools: p.tools + 1,
      active: p.active + 1,
    }))

    const ran = await next(e)

    const p = await read($, pet)
    const active = Math.max(0, p.active - 1)
    if (ran.deny !== undefined) {
      await setMood($, 'thinking', 'Думаю дальше', () => ({ active }))
    } else if (active === 0) {
      await setMood($, 'thinking', ran.isError === true ? 'Не вышло, думаю дальше' : 'Думаю', () => ({ active }))
    } else {
      await update($, pet, q => ({ ...q, active }))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const p = await read($, pet)
      const seconds = Math.max(1, Math.round(e.durationMs / 1000))
      if (e.isAborted) {
        await setMood($, 'idle', 'Остановились', () => ({ active: 0 }))
      } else if (e.reason === 'error') {
        await setMood($, 'error', 'Что-то сломалось', () => ({ active: 0 }))
      } else {
        const tools = p.tools === 0 ? '' : `, действий: ${p.tools}`
        await setMood($, 'done', `Готово за ${seconds} с${tools}`, () => ({ active: 0 }))
      }
    }

    return next(e)
  })

  on('command.run', { command: 'pet' }, async ($, e) => {
    const args = e.args.trim()
    const rename = /^(name|имя)\s+(.+)$/i.exec(args)
    const reskin = /^(skin|скин|питомец|pet)(\s+(.*))?$/i.exec(args)
    const askToggle = /^(ask|вопросы|разрешения)\s+(on|off|вкл|выкл)$/i.exec(args)

    if (askToggle !== null) {
      const isOn = /^(on|вкл)$/i.test(askToggle[2]!)
      await $.store.set('askOnPet', isOn)

      return {
        text: isOn
          ? 'Когда ты не в окне Claude, разрешения будут спрашиваться на питомце.'
          : 'Разрешения снова спрашиваются только в окне Claude.',
      }
    }

    if (rename !== null) {
      const name = short(rename[2], 24)
      await useDesign($, { ...(await read($, petDesign)), name })

      return { text: `Теперь питомца зовут ${name}.` }
    }

    if (reskin !== null) {
      const wanted = (reskin[3] ?? '').trim()
      const current = (await read($, petDesign)).name
      const stored = await $.store.get('hatched')
      const hatched = (Array.isArray(stored) ? stored : []).map(d => sanitize(d, 'Питомец'))
      const mark = (name: string) => (name === current ? '▸' : ' ')
      const list =
        PRESETS.map(p => `${mark(p.design.name)} ${p.design.name}: /pet skin ${p.aliases[0]}`).join('\n') +
        (hatched.length === 0
          ? ''
          : '\n\nТвои выведенные:\n' + hatched.map(d => `${mark(d.name)} ${d.name}: /pet skin ${d.name}`).join('\n'))
      if (wanted === '') {
        return { text: `Питомцы:\n${list}\n\nСвоего можно вывести: /hatch <описание>` }
      }
      const own = hatched.find(d => d.name.toLowerCase() === wanted.toLowerCase())
      const design = own ?? findPreset(wanted)?.design
      if (design === undefined) {
        return { text: `Не знаю питомца «${wanted}». Есть:\n${list}\n\nИли выведи своего: /hatch ${wanted}` }
      }
      await useDesign($, design)

      return { text: `Теперь твой питомец: ${design.name}.` }
    }

    if (/^(panel|панель)$/i.test(args) || !canFloat($)) {
      const name = (await read($, petDesign)).name
      const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
      if (isOpen) {
        await $.ui.close({ id: PANE })

        return { text: 'Панель с питомцем закрыта.' }
      }
      await $.ui.open({ id: PANE, title: name })

      return { text: `${name} в панели.` }
    }

    const wantsShown = /^(show|показать)$/i.test(args)
      ? true
      : /^(hide|скрыть|спрятать)$/i.test(args)
        ? false
        : !(await isOverlayRunning($))

    await $.store.set('shown', wantsShown)
    if (wantsShown) {
      await writePet($)
      await writeSession($)
      await launchOverlay($)

      return { text: 'Питомец на экране. Перетаскивай мышью, правый клик: сессии и меню.' }
    }
    await writeJson($, 'prefs.json', { shown: false })

    return { text: 'Питомец спрятан. /pet вернёт его.' }
  })

  on('command.run', { command: 'hatch' }, async ($, e) => {
    const description = e.args.trim()
    if (description === '') {
      return { text: 'Опиши питомца: /hatch маленький синий робот с антенной' }
    }
    const reply = await $.model.complete({
      model: 'sonnet',
      prompt: HATCH_PROMPT + description,
      maxTokens: 700,
      timeoutMs: 60_000,
    })
    if (!reply.isAnswered) {
      return { text: `Не получилось вывести питомца (${reply.reason}). Попробуй ещё раз.` }
    }
    const design = parseDesign(reply.text, short(description, 20))
    if (design === undefined) {
      return { text: 'Яйцо не проклюнулось: модель ответила не по формату. Попробуй ещё раз.' }
    }
    await useDesign($, design)
    const hatched = await $.store.get('hatched')
    const list = Array.isArray(hatched) ? hatched : []
    await $.store.set('hatched', [design, ...list].slice(0, 12))

    return { text: `🥚 Вылупился ${design.name}! Он уже на экране. Вернуть стандартного: /pet skin claude` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const p = await read($, pet)
    const design = await read($, petDesign)

    if (e.surface === 'desktop' || e.surface === 'mobile') {
      const { Box, Svg } = $.ui.resolve(e)

      return (
        <Box flexDirection="column" alignItems="center">
          <Svg source={svgOf(design, p.mood)} alt={`${design.name}: ${p.text}`} isInteractive />
        </Box>
      )
    }

    const { Text } = $.ui.resolve(e)

    return (
      <Text color="#D97757">
        {design.name}: {p.text}
      </Text>
    )
  })
}
