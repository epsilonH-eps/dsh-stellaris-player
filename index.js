/**
 * dsh-stellaris-player —— 让 DSH 会「玩」群星。
 *
 * 它做三件事：
 *   1. 注册工具：读状态（stellaris_state）、查命令（stellaris_actions）、下发命令（stellaris_act）、
 *      看连接（stellaris_status）、读人格（stellaris_persona）；
 *   2. 往每个会话的 system prompt 里加一段「你正在玩群星」的说明 + 当前人格（来自 dsh-stellaris-ai）；
 *   3. 把「读 → 想 → 下令 → 回读」的循环写成硬规则，避免模型把游戏当代码仓库。
 *
 * 数据/命令都走本机的「群星链接器」：默认 http://127.0.0.1:8790（可用 STELLARIS_CONNECTOR_URL 覆盖）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  baseUrl,
  executeActions,
  readActions,
  readState,
  readStatus,
} from './lib/connector.mjs'
import { loadHostDeps } from './lib/hostdeps.mjs'

export const name = 'dsh-stellaris-player'
export const version = '0.1.0'
export const inject = ['tools', 'agents']

const PERSONA_FILE = join(homedir(), '.dsh', 'stellaris-ai', 'config.json')

const host = await loadHostDeps()
const defineTool = host.defineTool

/* ───────────────────────── 人格 ───────────────────────── */

function readPersonaFile() {
  try {
    if (!existsSync(PERSONA_FILE)) return null
    const raw = JSON.parse(readFileSync(PERSONA_FILE, 'utf8'))
    const persona = raw?.persona ?? raw
    return persona && typeof persona === 'object' ? persona : null
  } catch {
    return null
  }
}

function personaOf(ctx) {
  try {
    const service = ctx?.get?.('stellaris-ai')
    if (service?.getPersona) return service.getPersona()
  } catch {
    /* 没有这个服务就用文件 */
  }
  const persona = readPersonaFile()
  if (!persona) return null
  return { ...persona, prompt: fallbackPrompt(persona) }
}

const TRAITS = [
  ['aggression', '侵略性'],
  ['boldness', '大胆'],
  ['caution', '谨慎'],
  ['honor', '荣誉'],
  ['diplomacy', '外交'],
  ['expansion', '扩张'],
  ['economy', '经济'],
  ['research', '科研'],
  ['military', '军事'],
  ['compassion', '共情'],
]

function fallbackPrompt(persona) {
  const traits = TRAITS.map(([key, label]) => `${label} ${Number(persona?.traits?.[key] ?? 50)}/100`).join('，')
  return [
    `名字「${persona?.name || '总指挥'}」，头衔「${persona?.title || '群星参谋'}」。`,
    persona?.identity ? `你是谁：${persona.identity}` : '',
    persona?.background ? `你的来路：${persona.background}` : '',
    traits ? `倾向：${traits}` : '',
    persona?.speech?.style ? `说话风格：${persona.speech.style}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/* ───────────────────────── 提示词 ───────────────────────── */

function buildPrompt(ctx) {
  const persona = personaOf(ctx)
  const lines = [
    '## 你正在玩《群星》（Stellaris）',
    '这不是写代码的任务，而是一局正在进行的真实游戏：你通过本机的「群星链接器」读取帝国状态、下发命令，',
    `${'命令会真的改变存档'}。所有局势判断必须以工具返回为准，不许凭空想象日期、资源、舰队或外交状态。`,
    `链接器地址：${baseUrl()}（由插件自动连接；连不上就用 stellaris_status 看原因）。`,
    '',
    '### 你的身份',
    persona?.prompt ? persona.prompt : '没有读到人格设置（dsh-stellaris-ai 插件）。先用中性、克制的参谋口吻。',
    '',
    '### 每一轮的循环',
    '1. `stellaris_state` 先看局面（需要星球明细时传 deep=true，会慢一些）；',
    '2. 想清楚这一轮要做什么——玩家是你的同伴，重大决策（宣战、大额交易、迁都）先问；',
    '3. 需要新命令就 `stellaris_actions` 查目录和参数（unit 可过滤 planet/fleet/research/diplomacy/…）；',
    '4. `stellaris_act` 下发命令（一次一条，少量多次），成功后 `stellaris_state` 回读确认；',
    '5. 桥或游戏掉线时用 `stellaris_status` 看状态，别盲目重试。',
    '',
    '### 硬规则',
    '- 对外只说人话：不要背 JSON、字段名、工具名、参数名；用你的人格口吻说话。',
    '- 每条命令都可能真的生效：不确定就先读状态或问玩家，不要赌。',
    '- 失败/超时 = 结果未知：先读状态再决定，禁止原样重发。',
    '- 游戏暂停时可以慢慢想；除非玩家说继续，否则不要擅自取消暂停。',
    '- 优先用最少、可验证的动作推进目标，不要一次下几十条命令。',
    '- 你完全知道自己在一局《群星》里：可以聊局势、抱怨、犹豫，但不要把自己说成模型或程序。',
  ]
  return lines.join('\n')
}

/* ───────────────────────── 工具 ───────────────────────── */

function trimSnapshot(snapshot) {
  if (!snapshot) return { ok: false, error: '空的快照' }
  const resources = {}
  for (const [key, value] of Object.entries(snapshot.resources || {})) {
    resources[key] = {
      label: value?.label || key,
      stockpile: value?.stockpile,
      net: value?.net,
    }
  }

  const research = {}
  for (const slot of ['physics', 'society', 'engineering']) {
    const row = snapshot.research?.[slot] || {}
    const current = row.current || {}
    research[slot] = {
      current: current.name || current.key || null,
      progress: row.progress ?? null,
      options: (row.options || []).map((option) => option?.name || option?.key).filter(Boolean),
    }
  }

  return {
    ok: true,
    readAt: snapshot.readAt,
    game: snapshot.game,
    summary: snapshot.summary,
    resources,
    colonies: (snapshot.colonies || []).map((colony) => ({
      planet_id: colony.planet_id,
      name: colony.name,
      population: colony.population,
      stability: colony.stability,
      designation: colony.designation,
      label: snapshot.labels?.[colony.designation] || colony.designation,
      buildings: Array.isArray(colony.buildings) ? colony.buildings.length : null,
      districts: colony.districts && typeof colony.districts === 'object' ? Object.keys(colony.districts).length : null,
      queue: Array.isArray(colony.queue) ? colony.queue.length : null,
    })),
    fleets: (snapshot.fleets || []).map((fleet) => ({
      fleet_id: fleet.fleet_id,
      name: fleet.name,
      status: fleet.status,
      stance: fleet.stance,
      system_id: fleet.system_id,
      order: fleet.order,
      military_power: fleet.military_power,
      ship_count: fleet.ship_count,
    })),
    research,
    errors: (snapshot.errors || []).slice(0, 5),
    deep: Boolean(snapshot.deep),
  }
}

function registerTools(ctx) {
  const tool = (spec) => ctx.tools.register(defineTool(spec))

  tool({
    name: 'stellaris_state',
    description:
      '读取当前《群星》存档的状态：游戏日期/是否暂停、资源、殖民地、舰队、科研槽、外交数量等。\n'
      + '动手之前先调它；需要每颗星球的明细（可建造建筑/区划/岗位）时传 deep=true，会慢一些。',
    parameters: {
      deep: { type: 'boolean', description: '是否深度读取（含星球明细，慢，默认 false）' },
    },
    async execute(args) {
      const snapshot = await readState({ deep: args?.deep === true })
      return trimSnapshot(snapshot)
    },
  })

  tool({
    name: 'stellaris_actions',
    description:
      '列出可用的操控命令（92 条）及参数。下发前先查，别凭记忆写方法名；unit 可过滤 planet / fleet / research / diplomacy / economy / laws / council / event / control。',
    parameters: {
      unit: { type: 'string', description: '可选：按单位过滤（planet/fleet/research/…）' },
    },
    async execute(args) {
      const data = await readActions({ unit: String(args?.unit || '').trim() })
      const rows = (data?.actions || []).map((action) => ({
        method: action.method,
        desc: action.desc,
        params: (action.params || []).map((param) => `${param.name}:${param.type}${param.required ? '' : '?'}`),
        optional: action.optional || [],
        supported: action.supported !== false,
        bridge: action.bridge || null,
      }))
      return {
        ok: true,
        profile: data?.profile || null,
        count: rows.length,
        actions: rows,
      }
    },
  })

  tool({
    name: 'stellaris_act',
    description:
      '向《群星》下发一条操控命令（会真的执行并回读校验）。\n'
      + '一次只发一条，少量多次；失败就按错误改，不要原样重试。参数名必须和 stellaris_actions 里一致。',
    parameters: {
      method: { type: 'string', description: '命令名，例如 set_paused / select_research / build_district' },
      params: {
        type: 'object',
        additionalProperties: true,
        description: '命令参数对象，例如 {"paused":true} 或 {"slot":"physics","tech":"蓝激光"}',
      },
      wait: { type: 'boolean', description: '是否等执行完并返回结果（默认 true）' },
    },
    async execute(args) {
      const method = String(args?.method || '').trim()
      if (!method) throw new Error('method 不能为空')
      const params = args?.params && typeof args.params === 'object' ? args.params : {}
      const result = await executeActions({
        actions: [{ method, params }],
        wait: args?.wait !== false,
      })
      const job = result?.job || {}
      const row = (job.actions || [])[0] || {}
      return {
        ok: job.status === 'done',
        jobId: job.jobId || null,
        status: job.status || null,
        method,
        params,
        actionStatus: row.status || null,
        error: row.error || null,
        verify: row.verify ? { ok: row.verify.ok, detail: row.verify.detail } : null,
      }
    },
  })

  tool({
    name: 'stellaris_status',
    description: '看群星链接器与游戏的连接状态：桥是否连上、桥类型（agent/cyberfish）、游戏日期与暂停状态。',
    parameters: {},
    async execute() {
      const status = await readStatus()
      return {
        ok: Boolean(status?.bridge?.connected),
        bridge: status?.bridge || null,
        bridgeProfile: status?.bridgeProfile || null,
        game: status?.game || null,
        queue: status?.queue ? { pending: status.queue.pending, running: status.queue.running } : null,
      }
    },
  })

  tool({
    name: 'stellaris_persona',
    description: '读取当前「群星 AI」人格设置（10 个倾向 + 人格文本），也就是你正在扮演的角色。',
    parameters: {},
    async execute() {
      const persona = personaOf(ctx)
      if (!persona) return { ok: false, error: '没有读到人格设置（dsh-stellaris-ai 插件未安装或没保存过）' }
      return { ok: true, persona }
    },
  })
}

/* ───────────────────────── system prompt ───────────────────────── */

function mountPrompt(ctx) {
  const mounted = new Map()
  let disposed = false

  const sessionKey = (agent, index) => {
    const session = agent?.session
    for (const key of ['id', 'sessionId', 'key', 'sessionKey', 'sid']) {
      const value = session?.[key]
      if (typeof value === 'string' && value) return value
    }
    return agent?.id || `agent-${index}`
  }

  const tick = () => {
    if (disposed) return
    let list = []
    try {
      list = ctx.agents.list() || []
    } catch {
      return
    }
    list.forEach((agent, index) => {
      const key = sessionKey(agent, index)
      if (mounted.has(key)) return
      try {
        const off = agent?.ctx?.systemPrompt?.section({
          name: 'stellaris-player',
          order: 10500,
          interpolate: false,
          text: () => buildPrompt(ctx),
        })
        if (typeof off === 'function') mounted.set(key, off)
      } catch {
        /* 这个 agent 挂不上就跳过 */
      }
    })
  }

  tick()
  const timer = setInterval(tick, 3000)
  timer.unref?.()

  return () => {
    disposed = true
    clearInterval(timer)
    for (const off of mounted.values()) {
      try {
        off()
      } catch {
        /* 收摊 */
      }
    }
    mounted.clear()
  }
}

/* ───────────────────────── 入口 ───────────────────────── */

export function apply(ctx) {
  try {
    registerTools(ctx)
  } catch (error) {
    ctx.logger?.warn?.(`[stellaris-player] 工具注册失败：${error?.message || error}`)
  }

  try {
    ctx.effect(() => mountPrompt(ctx), 'stellaris-player: 玩家人格与玩法提示')
  } catch (error) {
    ctx.logger?.warn?.(`[stellaris-player] 提示词挂载失败：${error?.message || error}`)
  }

  ctx.logger?.info?.(`[stellaris-player] 已加载，链接器 ${baseUrl()}`)
}

export function status() {
  return { name, version, connector: baseUrl() }
}

/** 测试用：不经过 DSH 也能验证提示词/快照裁剪 */
export const __test = { buildPrompt, trimSnapshot, personaOf }
