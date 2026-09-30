// ============================================================
// dsh-scrcpy-core —— Host 半区（"唯一门面"）
//
// 它负责（对用户 + 对 AI 都是同一个门面）：
//   ① provider 注册表 —— 装了哪些 provider、各自能做什么
//   ② 设备与聚焦状态的唯一权威 —— 合并各 provider 的设备；记住"当前聚焦哪台"
//   ③ 命令路由 —— 工具被调用 → 查聚焦设备 → 转给它所属 provider 的底层动作
//   ④ AI 工具 —— 一套中性名 scrcpy_*，**只注册一次**（常驻注册 + 调用时门禁）
//   ⑤ 给 AI 的**固定三段**提示词（工具调用说明 / 权限说明 / 聚焦设备说明）
//   ⑥ 权限门禁 + 二次确认 + 落点预览 + 手势队列
//   ⑦ 视觉识别（llm / attachments 是 DSH 通用服务，只有"取一帧"这一步问 provider）
//
// provider 只回答"这类设备怎么说话"：传输 / sidecar / 设备发现 / 底层动作 / 环境检测。
// provider 不注册 UI、不注册工具、不写 AI 提示词、不关心聚焦是谁。
//
// ⚠️ 标【未实测】的地方 = 按 @deepseek-ai/cordis 与 DSH 源码写的，还没真跑起来验证过。
// ============================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

// core 自己的版本号：直接读包里的 package.json（provider 做模块顶层校验时对齐的就是它）
// 构建戳（【用户口述 2026-09-27】：格式 `YYYY-MM-DD.B<N>` = Build N，每个包各起各的）：
//   改动打一次包就 +1；**戳对不上 = 没装上/没重启**。经 devices:list / core:info 露出来（菜单标题栏右侧）。
const CORE_BUILD = '2026-09-30.B1'
const CORE_VERSION = (function () {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return String(JSON.parse(readFileSync(p, 'utf8')).version || '')
  } catch (e) { return '' }
})()

// ------------------------------------------------------------
// 常量：这些是 DSH 通用概念，跟平台无关，别搬去 provider
// ------------------------------------------------------------
const MIN_DSH_VERSION = '0.1.0-rc8'
const RPC_PATH = '/dsh-scrcpy/rpc'
const PROMPT_SECTION = 'dsh-scrcpy'
const PROMPT_ORDER = 9500

const CONFIG_DIR = process.env.DSH_HOME || join(os.homedir(), '.dsh')
const CONFIG_FILE = join(CONFIG_DIR, 'dsh-scrcpy.json')

// jmuxer（H.264→MSE 解码库）归 core：它是"解码/UI"这一侧的东西，与平台无关。
// 网页通过 jmuxer:source 取源码再 eval（静态包不能直接 import 浏览器库）
const JMUXER_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'jmuxer.min.js')

// core 自己的配置只放"跟平台无关"的东西；provider 的配置（hdc/adb 路径等）归 provider 自己存
function readConfig() {
  try {
    const o = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return { visionProvider: String(o.visionProvider || ''), visionModel: String(o.visionModel || '') }
  } catch { return { visionProvider: '', visionModel: '' } }
}
function writeConfig(cfg) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
    return { ok: true }
  } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
}

// ------------------------------------------------------------
// 权限：四套三态，按设备号存（与 2.1.1 行为一致，进程级、重启即清）
//   off = 禁止；confirm = 每次二次确认；trust = 直接执行
//   依赖关系：shot 关掉 → 另外三个强制关掉；开另外三个前必须有 shot
// ------------------------------------------------------------
const PERMS = ['shot', 'ctl', 'key', 'input']
// 权限基础标签按当前语言现取（Proxy：读的时候才算）。注意"按键"那一项不能直接用它 ——
// 它的显示名要按 provider 声明的 aiKeys 现算，走 permLabelOf(perm, sn)（见下面）。
const PERM_LABEL = new Proxy({}, { get: function (_t, k) { return H('perm.' + String(k)) } })
const modes = { shot: {}, ctl: {}, key: {}, input: {} }   // modes[perm][sn] = 'confirm' | 'trust'
function hasMode(perm) { return Object.keys(modes[perm] || {}).some((sn) => modes[perm][sn]) }

// ------------------------------------------------------------
// provider 注册表
//   provider 通过 ctx.scrcpyProviders.register({...}) 登记自己
//   actions 全是"按 sn 定位"的底层动作；core 只认这些名字，不关心里面怎么实现
// ------------------------------------------------------------
const providers = new Map()      // id -> { id, label, transport, available, note, capabilities, actions, handlers, devices }
const devicesByProvider = new Map() // id -> [{ sn, name, model, online, streaming }]
let focusedSn = ''
const listeners = new Set()

function emitChange() { listeners.forEach((fn) => { try { fn() } catch (e) {} }) }

/**
 * 极简"匹配 core"范围匹配（不引 semver 依赖）。支持四种写法：
 *   "1.0.0"     精确
 *   "^1.0.0"    同 major 且 >= 1.0.0
 *   "~1.0.0"    同 major 且同 minor —— **只允许最后一位变**（1.0.1 ✓、1.0.9 ✓；1.1.0 ✗、2.0.0 ✗）
 *   ">=1.0.0"   下限
 * 空字符串 = 不声明（不校验，放行 —— 向后兼容）。
 */
function matchCompat(range, version) {
  const r = String(range || '').trim()
  if (!r) return true
  const v = parseVersion(version)
  if (!v) return false
  if (r.charAt(0) === '~') {
    const base = parseVersion(r.slice(1))
    return !!base && v.major === base.major && v.minor === base.minor && compareVersion(version, r.slice(1)) >= 0
  }
  if (r.charAt(0) === '^') {
    const base = parseVersion(r.slice(1))
    return !!base && v.major === base.major && compareVersion(version, r.slice(1)) >= 0
  }
  if (r.slice(0, 2) === '>=') return compareVersion(version, r.slice(2).trim()) >= 0
  return compareVersion(version, r) === 0
}

const registry = {
  // 版本判定【由 core 做】（【用户口述 2026-09-25】）：
  //   provider 在 register() 里声明 `coreCompat`（一段"匹配 core"的文字），core 拿自己的版本比对；
  //   不通过 → 把该 provider 标成 `blocked`（设备不进列表、动作不路由 = 不让用），菜单显示一句原因。
  //   ⚠️ core 里【不维护】"支持哪些 provider 版本"的表 —— 否则每发一个 provider 都得动 core。
  /** 登记一个 provider；返回注销函数 */
  register(desc) {
    if (!desc || !desc.id) throw new Error('scrcpyProviders.register: 缺少 id')
    if (!desc.actions || typeof desc.actions !== 'object') throw new Error('scrcpyProviders.register: 缺少 actions')
    const compat = String(desc.coreCompat || '')
    const blocked = compat ? !matchCompat(compat, CORE_VERSION) : false
    const entry = {
      id: String(desc.id),
      label: desc.label || desc.id,
      transport: String(desc.transport || ''),
      available: desc.available !== false,
      note: String(desc.note || ''),
      capabilities: desc.capabilities || {},
      actions: desc.actions,
      handlers: desc.handlers || {},
      coreCompat: compat,
      blocked: blocked,
      blockReason: blocked
        ? { zh: '需要 core ' + compat + '，当前 core ' + CORE_VERSION + ' —— 已停用（把两个包升到配套版本）',
            en: 'needs core ' + compat + ', this core is ' + CORE_VERSION + ' — disabled (upgrade both packages together)' }
        : '',
    }
    providers.set(entry.id, entry)
    if (!devicesByProvider.has(entry.id)) devicesByProvider.set(entry.id, [])
    if (blocked) console.warn('[dsh-scrcpy-core] ' + entry.label + '(' + entry.id + ') ' + entry.blockReason)
    emitChange()
    return function unregister() {
      providers.delete(entry.id)
      devicesByProvider.delete(entry.id)
      if (focusedSn && !findDevice(focusedSn)) focusedSn = ''
      emitChange()
    }
  },
  /** provider 上报设备列表（首次 + 每次变化） */
  setDevices(providerId, list) {
    devicesByProvider.set(String(providerId), Array.isArray(list) ? list.map((d) => ({
      sn: String(d.sn),
      name: String(d.name || ''),
      model: String(d.model || ''),
      online: d.online !== false,
      streaming: !!d.streaming,
    })) : [])
    if (focusedSn && !findDevice(focusedSn)) focusedSn = ''
    emitChange()
  },
  getProviders() {
    return Array.from(providers.values()).map((p) => ({
      id: p.id, label: pickText(p.label), transport: p.transport, available: p.available, note: pickText(p.note),
      capabilities: localizeDeep(p.capabilities, 0), deviceCount: (devicesByProvider.get(p.id) || []).length,
      coreCompat: p.coreCompat || '', blocked: !!p.blocked, blockReason: p.blockReason || '',
    }))
  },
  /** 已知的 provider id（给 UI 做按平台分组用） */
  has(id) { return providers.has(String(id)) },
}

/** core 内部用：真实 provider 条目 */
function getProvider(id) { return providers.get(String(id)) }
function findDevice(sn) {
  for (const [pid, list] of devicesByProvider) {
    const p = providers.get(pid)
    if (!p || p.blocked) continue          // 被停用的 provider：不参与任何路由（= 不让用）
    const hit = list.find((d) => d.sn === sn)
    if (hit) return { providerId: pid, device: hit }
  }
  return null
}
function findProviderBySn(sn) {
  const hit = findDevice(sn)
  return hit ? providers.get(hit.providerId) : undefined
}
/** 合并所有 provider 的设备，带上"它属于谁 / 是不是当前聚焦" */
function mergedDevices() {
  const out = []
  for (const [pid, list] of devicesByProvider) {
    const p = providers.get(pid)
    if (p && p.blocked) continue           // 被停用的 provider：它的设备不进合并列表
    for (const d of list) out.push(Object.assign({}, d, { providerId: pid, providerLabel: pickText(p ? p.label : pid), focused: d.sn === focusedSn }))
  }
  return out
}

// ------------------------------------------------------------
// 聚焦设备
// ------------------------------------------------------------
function requireFocused() {
  if (!focusedSn) return { ok: false, error: H('err.noFocus') }
  const p = findProviderBySn(focusedSn)
  if (!p) return { ok: false, error: H('err.deviceGone', { sn: focusedSn }) }
  return { ok: true, sn: focusedSn, provider: p }
}
function requireAction(provider, name, sn) {
  const fn = provider.actions && provider.actions[name]
  if (typeof fn !== 'function') {
    return { ok: false, error: H('err.noAction', { label: pickText(provider.label), name: name }) }
  }
  return { ok: true, call: (a) => fn(sn, a) }
}

// ------------------------------------------------------------
// 权限门禁 / 二次确认 / 落点预览 / 手势队列
// ------------------------------------------------------------
/**
 * 某台设备的 provider 允许 AI 用哪些键，拼成给人看的一串。
 * 用 provider 自己的双语 keyLabels（core 已按当前语言挑成字符串）；没声明就返回空串。
 */
function aiKeyListOf(sn) {
  const d = findDevice(sn)
  const p = d ? getProvider(d.providerId) : null
  const caps = (p && p.capabilities) || {}
  const keys = Array.isArray(caps.aiKeys) ? caps.aiKeys : (Array.isArray(caps.keys) ? caps.keys : [])
  const labels = caps.keyLabels || {}
  return keys.map(function (k) { const l = labels[k]; return l ? pickText(l) : String(k) }).join(' / ')
}
/**
 * 权限的显示名。按键那一项**按 provider 的声明现算**（【用户口述 2026-09-27】）——
 * 写死的"允许按键（返回/主页）"在 provider 改了 aiKeys 之后就是假话。
 */
function permLabelOf(perm, sn) {
  if (perm !== 'key') return PERM_LABEL[perm]
  const list = aiKeyListOf(sn)
  return list ? H('perm.keyDyn', { keys: list }) : H('perm.key')
}
function permGate(perm, sn) {
  const mode = (modes[perm] || {})[sn]
  if (!mode || mode === 'off') {
    return { ok: false, error: H('err.permOff', { sn: sn, perm: permLabelOf(perm, sn) }) }
  }
  return { ok: true, mode }
}

let ctlPending = []
let ctlSeq = 0
let ctlPreview = null

/** 需要二次确认时弹确认；confirm 期间发布落点预览（网页据此叠闪烁绿点） */
async function gateApproval(ctx, exec, toolName, reason, preview) {
  if (preview) ctlPreview = preview
  const approval = ctx.get('approval')
  if (!approval) { ctlPreview = null; return { ok: false, error: H('err.noApproval') } }
  if (!exec.agent) { ctlPreview = null; return { ok: false, error: H('err.noAgent') } }
  let outcome
  try {
    outcome = await approval.request({ agent: exec.agent, toolName: toolName, reason: reason, signal: exec.signal })
  } catch (e) { ctlPreview = null; return { ok: false, error: H('err.approvalFailed', { msg: String((e && e.message) || e) }) } }
  if (outcome !== 'allowed-once') { ctlPreview = null; return { ok: false, error: H('err.denied', { outcome: String(outcome) }) } }
  return { ok: true }
}

// ------------------------------------------------------------
// 小工具（与平台无关，从 2.1.1 原样搬过来）
// ------------------------------------------------------------
function clamp01(v) { v = Number(v); return v < 0 ? 0 : v > 1 ? 1 : v }
function cleanJson(obj) {
  const out = {}
  for (const k of Object.keys(obj || {})) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}
function sniffMediaType(bytes) {
  if (!bytes || bytes.length < 4) return ''
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
  return ''
}
function bytesToBase64(bytes) {
  const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2]
    out += CH[b0 >> 2]
    out += CH[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)]
    out += b1 === undefined ? '=' : CH[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)]
    out += b2 === undefined ? '=' : CH[b2 & 63]
  }
  return out
}
function parseVersion(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}
function cmpPreId(a, b) {
  const an = /^\d+$/.test(a), bn = /^\d+$/.test(b)
  if (an && bn) return (+a) - (+b)
  if (an) return -1
  if (bn) return 1
  return a < b ? -1 : a > b ? 1 : 0
}
function compareVersion(a, b) {
  const A = parseVersion(a), B = parseVersion(b)
  if (!A || !B) return 0
  if (A.major !== B.major) return A.major - B.major
  if (A.minor !== B.minor) return A.minor - B.minor
  if (A.patch !== B.patch) return A.patch - B.patch
  if (!A.pre.length && !B.pre.length) return 0
  if (!A.pre.length) return 1
  if (!B.pre.length) return -1
  const n = Math.min(A.pre.length, B.pre.length)
  for (let i = 0; i < n; i++) { const d = cmpPreId(A.pre[i], B.pre[i]); if (d) return d }
  return A.pre.length - B.pre.length
}
let dshVersionPromise = null
function readDshVersion() {
  if (dshVersionPromise) return dshVersionPromise
  dshVersionPromise = (async function () {
    const home = process.env.DSH_HOME || join(os.homedir(), '.dsh')
    const candidates = [
      join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    ]
    for (const p of candidates) {
      try {
        const o = JSON.parse(readFileSync(p, 'utf8'))
        if (o && o.version) return String(o.version)
      } catch (e) {}
    }
    return ''
  })()
  return dshVersionPromise
}

// ------------------------------------------------------------
// 视觉识别（DSH 通用：llm / attachments 都是宿主服务）
// ------------------------------------------------------------
/**
 * 列出【所有 provider】的所有模型 → [{ provider, providerName, id, name }]
 * 两条教训都来自实测 / 用户指出：
 *   ① 早先写死内置 DeepSeek 提供方的 id（`deepseek-official`）→ 桌面端 0.1.7 里那个 id 是
 *      `deepseek-account`，于是列表恒空、下拉被禁用（2026-09-25 实测）；
 *   ② 早先按 `inputModalities` 含 'image' 过滤 → 非官方 API 的提供方大多**不报这个字段**，
 *      能看图的模型也被筛掉了。所以**全都列出来**；选了不支持图片的模型，就让上游 API 自己报错。
 */
async function listModels(llm) {
  let providers = []
  try { providers = llm.listProviders() || [] } catch (e) { providers = [] }
  const out = []
  for (const p of providers) {
    if (!p || !p.id) continue
    let models = []
    try { models = (await llm.listModels(p.id)) || [] } catch (e) { models = [] }
    for (const m of models) {
      if (!m || !m.id) continue
      out.push({ provider: p.id, providerName: p.name || p.id, id: m.id, name: m.name || m.id })
    }
  }
  return out
}
async function resolveVisionModel(llm) {
  const vision = await listModels(llm)
  if (!vision.length) {
    return { ok: false, error: H('err.noModel'), models: [] }
  }
  const cfg = readConfig()
  let hit = vision.find((m) => m.provider === String(cfg.visionProvider || '') && m.id === String(cfg.visionModel || ''))
  const fallback = !hit
  if (!hit) hit = vision.find((m) => m.id === String(cfg.visionModel || '')) || vision[0]
  return { ok: true, provider: hit.provider, model: hit.id, models: vision, fallback: fallback }
}
async function visionGateCheck(ctx, sn) {
  const llm = ctx.get('llm')
  if (!llm) return { ok: false, error: H('err.noLlm') }
  if (!ctx.get('approval')) return { ok: false, error: H('err.noApproval') }
  const gate = permGate('shot', sn)
  if (!gate.ok) return gate
  const ver = await readDshVersion()
  if (!ver) return { ok: false, error: H('err.badDshVersion', { min: MIN_DSH_VERSION }) }
  if (compareVersion(ver, MIN_DSH_VERSION) < 0) return { ok: false, error: H('err.oldDsh', { ver: ver, min: MIN_DSH_VERSION }) }
  const resolved = await resolveVisionModel(llm)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  return { ok: true, llm: llm, mode: gate.mode, provider: resolved.provider, model: resolved.model, models: resolved.models, modelFallback: resolved.fallback }
}
async function runVision(ctx, bytes, mediaType, prompt, signal, provider, model) {
  const attachments = ctx.get('attachments')
  if (!attachments) return { ok: false, error: H('err.noAttachments') }
  let refs
  try { refs = await attachments.saveImages([{ data: bytes, mediaType: mediaType, name: 'scrcpy-shot' }]) } catch (e) {
    return { ok: false, error: H('err.imageSave', { msg: String((e && e.message) || e) }) }
  }
  if (!refs || !refs[0]) return { ok: false, error: H('err.imageSave2') }
  const llm = ctx.get('llm')
  let text = ''
  try {
    const stream = llm.stream({
      provider: provider, model: model, reasoningEffort: 'high', signal: signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: String(prompt || H('shot.defaultPrompt')) }, { type: 'image', attachment: refs[0] }] }],
    })
    for await (const chunk of stream) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        const msg = (chunk.reason.failure && chunk.reason.failure.message) || String(chunk.reason.kind)
        return { ok: false, error: H('err.visionFailed', { msg: msg }) }
      }
    }
  } catch (e) { return { ok: false, error: H('err.visionThrew', { msg: String((e && e.message) || e) }) } }
  if (!text) return { ok: false, error: H('err.visionEmpty') }
  return { ok: true, text: text }
}

// ------------------------------------------------------------
// AI 工具（中性名 scrcpy_*，**常驻注册**，权限在调用时判）
//   注意：2.1.1 是"有权限才注册"，那个做法跟固定提示词冲突（工具不在，提示词就指向空气），
//   所以 3.0.0 改为常驻 + 运行时门禁，失败时返回明确的"没开权限"错误。
// ------------------------------------------------------------
const OUT_ERR = { type: 'string' }

function toolDevices() {
  return defineTool({
    name: 'scrcpy_devices',
    description: H('tool.devices.desc'),
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          providers: { type: 'array', items: { type: 'object', additionalProperties: true } },
          devices: { type: 'array', items: { type: 'object', additionalProperties: true } },
          focused: { type: 'object', additionalProperties: true },
          error: OUT_ERR,
        },
      },
      render(args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: H('dev.queryFailed', { msg: (value && value.error) || H('err.unknown') }) }]
        const lines = []
        const provLabels = (value.providers || []).map((p) => p.label + (p.available ? H('dev.available') : H('dev.unavailable', { note: p.note || '' }))).join(H('sep.list'))
        lines.push(H('dev.providers', { list: provLabels || H('dev.noProvider') }))
        const ds = value.devices || []
        lines.push(H('dev.connected', { n: ds.length, list: ds.length ? ds.map((d) => d.sn + (d.streaming ? H('dev.streaming') : H('dev.idle')) + (d.focused ? H('dev.focusedMark') : '')).join(H('sep.list')) : H('dev.none') }))
        if (value.focused && value.focused.sn) {
          const f = value.focused
          lines.push(H('dev.focused', { sn: f.sn, label: f.providerLabel || '',
            perms: PERMS.map((p) => permLabelOf(p, f.sn) + '=' + (f.permissions[p] === 'trust' ? H('mode.trust') : f.permissions[p] === 'confirm' ? H('mode.confirm') : H('mode.off'))).join(H('sep.comma')) }))
        } else {
          lines.push(H('dev.noFocus'))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 10000,
    async execute() {
      const devices = mergedDevices()
      const out = { ok: true, providers: registry.getProviders(), devices: devices }
      // ⚠️ 没有聚焦设备时【不要返回 focused: null】—— output schema 声明的是 object，
      //    DSH 的校验会直接判 "value.focused must be an object"（2026-09-25 真机实测踩到）。
      //    focused 不是必填字段，所以直接省略这个键最干净。
      if (focusedSn) {
        const hit = findDevice(focusedSn) || {}
        const owner = hit.providerId ? providers.get(hit.providerId) : null
        out.focused = {
          sn: focusedSn,
          providerId: hit.providerId || '',
          providerLabel: (owner && owner.label) || hit.providerId || '',
          permissions: PERMS.reduce(function (acc, p) { acc[p] = (modes[p] || {})[focusedSn] || 'off'; return acc }, {}),
        }
      }
      return cleanJson(out)
    },
  })
}

function toolScreenshot(ctx) {
  return defineTool({
    name: 'scrcpy_screenshot',
    description: H('tool.screenshot.desc'),
    parameters: {
      prompt: { type: 'string', required: true, description: H('tool.screenshot.prompt') },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, sn: { type: 'string' }, model: { type: 'string' }, prompt: { type: 'string' }, text: { type: 'string' }, error: OUT_ERR },
      },
      render(args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: H('shot.failed', { msg: (value && value.error) || H('err.unknown') }) }]
        return [{ type: 'text', text: H('shot.head', { sn: value.sn, model: value.model }) + '\n' + (value.text || H('shot.empty')) }]
      },
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      const prompt = String((args && args.prompt) || '').trim() || H('shot.defaultPrompt')
      const f = requireFocused()
      if (!f.ok) return { ok: false, error: f.error }
      const sn = f.sn
      const g = await visionGateCheck(ctx, sn)
      if (!g.ok) return { ok: false, error: g.error }
      const act = requireAction(f.provider, 'snapshot', sn)
      if (!act.ok) return { ok: false, error: act.error }
      if (g.mode !== 'trust') {
        const ap = await gateApproval(ctx, exec, 'scrcpy_screenshot', H('appr.screenshot', { sn: sn, model: g.model }), null)
        if (!ap.ok) return { ok: false, error: ap.error }
      }
      const shot = await act.call({})
      if (!shot || !shot.ok) return { ok: false, error: (shot && shot.error) || H('err.shotFailed') }
      const bytes = shot.bytes
      const mediaType = shot.mediaType || sniffMediaType(bytes)
      if (!mediaType) return { ok: false, error: H('err.shotFormat') }
      const vision = await runVision(ctx, bytes, mediaType, prompt, exec.signal, g.provider, g.model)
      if (!vision.ok) return { ok: false, error: vision.error }
      return { ok: true, sn: sn, model: g.model, prompt: prompt, text: vision.text }
    },
  })
}

function toolLocate(ctx) {
  return defineTool({
    name: 'scrcpy_locate',
    description: H('tool.locate.desc'),
    parameters: { target: { type: 'string', description: H('tool.locate.target') } },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true }, sn: { type: 'string' }, target: { type: 'string' },
          count: { type: 'number' }, realW: { type: 'number' }, realH: { type: 'number' },
          controls: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { type: { type: 'string' }, text: { type: 'string' }, desc: { type: 'string' }, id: { type: 'string' }, key: { type: 'string' }, clickable: { type: 'boolean' }, fx: { type: 'number' }, fy: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } } },
          error: OUT_ERR,
        },
      },
      render(args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: H('loc.failed', { msg: (value && value.error) || H('err.unknown') }) }]
        const lines = [H('loc.head', { sn: value.sn, n: value.count, w: value.realW || '?', h: value.realH || '?' })]
        for (const c of value.controls || []) {
          const label = c.text || c.desc || c.key || c.id || c.type
          lines.push('- ' + label + (c.clickable ? H('loc.clickable') : '') + ' @(' + c.fx.toFixed(3) + ', ' + c.fy.toFixed(3) + ') ' + c.w + 'x' + c.h)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 30000,
    async execute(args, exec) {
      const f = requireFocused()
      if (!f.ok) return { ok: false, error: f.error }
      const sn = f.sn
      const g = permGate('ctl', sn)
      if (!g.ok) return { ok: false, error: g.error }
      // 读控件也算"控制"权限下的动作：confirm 模式下同样要走一次二次确认（【用户口述 2026-09-26】）
      if (g.mode !== 'trust') {
        const ap = await gateApproval(ctx, exec, 'scrcpy_locate', H('appr.locate', { sn: sn }), null)
        if (!ap.ok) return { ok: false, error: ap.error }
      }
      const act = requireAction(f.provider, 'dumpLayout', sn)
      if (!act.ok) return { ok: false, error: act.error }
      const dl = await act.call({})
      if (!dl || !dl.ok) return { ok: false, error: (dl && dl.error) || H('loc.readFailed') }
      const items = Array.isArray(dl.items) ? dl.items : []
      if (!items.length) return { ok: false, error: H('loc.empty') }
      return cleanJson({ ok: true, sn: sn, target: String((args && args.target) || '').trim() || undefined, count: items.length, realW: dl.realW, realH: dl.realH, controls: items })
    },
  })
}

function toolTap(ctx) {
  return defineTool({
    name: 'scrcpy_tap',
    description: H('tool.tap.desc'),
    parameters: {
      fx: { type: 'number', required: true, description: H('tool.fx') },
      fy: { type: 'number', required: true, description: H('tool.fy') },
      intent: { type: 'string', description: H('tool.tap.intent') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, seq: { type: 'number' }, fx: { type: 'number' }, fy: { type: 'number' }, intent: { type: 'string' }, error: OUT_ERR } },
      render(args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: H('tap.failed', { msg: (value && value.error) || H('err.unknown') }) }]
        return [{ type: 'text', text: H('tap.queued', { intent: value.intent, fx: value.fx, fy: value.fy }) }]
      },
    },
    timeoutMs: 60000,
    async execute(args, exec) { return await queueGesture(ctx, exec, 'tap', args) },
  })
}

function toolLongPress(ctx) {
  return defineTool({
    name: 'scrcpy_longpress',
    description: H('tool.longpress.desc'),
    parameters: {
      fx: { type: 'number', required: true, description: H('tool.fx') },
      fy: { type: 'number', required: true, description: H('tool.fy') },
      holdMs: { type: 'number', description: H('tool.holdMs') },
      intent: { type: 'string', description: H('tool.longpress.intent') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, seq: { type: 'number' }, fx: { type: 'number' }, fy: { type: 'number' }, holdMs: { type: 'number' }, intent: { type: 'string' }, error: OUT_ERR } },
      render(args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: H('lp.failed', { msg: (value && value.error) || H('err.unknown') }) }]
        return [{ type: 'text', text: H('lp.queued', { intent: value.intent, fx: value.fx, fy: value.fy, ms: value.holdMs || 2000 }) }]
      },
    },
    timeoutMs: 60000,
    async execute(args, exec) { return await queueGesture(ctx, exec, 'longpress', args) },
  })
}

function toolKey(ctx) {
  return defineTool({
    name: 'scrcpy_key',
    description: H('tool.key.desc'),
    parameters: {
      // 合法键值**不写死在这里**：由 provider 声明（capabilities.aiKeys），运行时校验（见下方 allowed）
      key: { type: 'string', required: true, description: H('tool.key.key') },
      intent: { type: 'string', description: H('tool.key.intent') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, seq: { type: 'number' }, key: { type: 'string' }, intent: { type: 'string' }, error: OUT_ERR } },
      render(args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: H('key.failed', { msg: (value && value.error) || H('err.unknown') }) }]
        return [{ type: 'text', text: H('key.queued', { name: value.key === 'home' ? 'Home' : H('key.back'), intent: value.intent ? ' · ' + value.intent : '' }) }]
      },
    },
    timeoutMs: 60000,
    async execute(args, exec) { return await queueKey(ctx, exec, args) },
  })
}

function toolInput(ctx) {
  return defineTool({
    name: 'scrcpy_input',
    description: H('tool.input.desc'),
    parameters: {
      text: { type: 'string', required: true, description: H('tool.input.text') },
      intent: { type: 'string', description: H('tool.input.intent') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, text: { type: 'string' }, intent: { type: 'string' }, error: OUT_ERR } },
      render(args, value) {
        if (!value || value.ok !== true) return [{ type: 'text', text: H('input.failed', { msg: (value && value.error) || H('err.unknown') }) }]
        return [{ type: 'text', text: H('input.done', { text: value.text, intent: value.intent ? ' · ' + value.intent : '' }) }]
      },
    },
    timeoutMs: 30000,
    async execute(args, exec) {
      const text = String((args && args.text) || '').trim()
      if (!text) return { ok: false, error: H('err.noText') }
      const intent = String((args && args.intent) || H('intent.input', { text: text })).trim()
      const f = requireFocused()
      if (!f.ok) return { ok: false, error: f.error }
      const sn = f.sn
      const g = permGate('input', sn)
      if (!g.ok) return { ok: false, error: g.error }
      if (g.mode !== 'trust') {
        const ap = await gateApproval(ctx, exec, 'scrcpy_input', H('appr.input', { text: text }), null)
        if (!ap.ok) return { ok: false, error: ap.error }
      }
      const act = requireAction(f.provider, 'input', sn)
      if (!act.ok) return { ok: false, error: act.error }
      const r = await act.call({ text: text })
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || H('err.injectFailed') }
      return { ok: true, text: text, intent: intent }
    },
  })
}

/** 通用手势：门禁 + 确认（带落点预览）+ 入队；真正的 touch 由网页经它的 WS 发给 provider */
async function queueGesture(ctx, exec, kind, args) {
  const fx0 = args && args.fx, fy0 = args && args.fy
  if (fx0 === undefined || fy0 === undefined || Number.isNaN(Number(fx0)) || Number.isNaN(Number(fy0))) {
    return { ok: false, error: H('err.noFx') }
  }
  const fx = clamp01(fx0), fy = clamp01(fy0)
  let hold
  if (kind === 'longpress') {
    hold = Number(args && args.holdMs)
    if (!hold || Number.isNaN(hold) || hold <= 0) hold = 2000
    hold = Math.min(hold, 10000)
  }
  const verb = kind === 'longpress' ? H('verb.longpress') : H('verb.tap')
  const intent = String((args && args.intent) || (kind === 'longpress' ? H('verb.longPressScreen') : H('verb.tapScreen'))).trim()
  const f = requireFocused()
  if (!f.ok) return { ok: false, error: f.error }
  const sn = f.sn
  const g = permGate('ctl', sn)
  if (!g.ok) return { ok: false, error: g.error }
  const needStream = !f.provider.capabilities || f.provider.capabilities.streams !== false
  if (needStream) {
    const dev = findDevice(sn)
    if (!dev || !dev.device.streaming) return { ok: false, error: H('err.notStreaming', { sn: sn, verb: verb }) }
  }
  const seq = ++ctlSeq
  if (g.mode !== 'trust') {
    const preview = { seq: seq, kind: kind, sn: sn, fx: fx, fy: fy, intent: intent }
    if (kind === 'longpress') preview.holdMs = hold
    const ap = await gateApproval(ctx, exec, kind === 'longpress' ? 'scrcpy_longpress' : 'scrcpy_tap',
      H('appr.tap', { verb: verb, intent: intent, hold: kind === 'longpress' ? H('hold.suffix', { ms: hold }) : '', fx: fx.toFixed(3), fy: fy.toFixed(3) }), preview)
    if (!ap.ok) return { ok: false, error: ap.error }
  }
  const gst = { seq: seq, kind: kind, sn: sn, fx: fx, fy: fy, intent: intent }
  if (kind === 'longpress') gst.holdMs = hold
  ctlPending.push(gst)
  const out = { ok: true, seq: seq, fx: fx, fy: fy, intent: intent }
  if (kind === 'longpress') out.holdMs = hold
  return out
}

async function queueKey(ctx, exec, args) {
  const key = String((args && args.key) || '').trim().toLowerCase()
  const f0 = requireFocused()
  if (!f0.ok) return { ok: false, error: f0.error }
  // AI 能用哪些键**由 provider 声明**（【用户口述 2026-09-27】"同时声明哪些可以让 ai 用"）：
  //   aiKeys 优先；没声明 aiKeys 就用它声明的全部键；两样都没有 → 明确报错（core 不再自带默认表）
  const caps0 = (f0.provider && f0.provider.capabilities) || {}
  const allowed = Array.isArray(caps0.aiKeys) ? caps0.aiKeys : (Array.isArray(caps0.keys) ? caps0.keys : [])
  if (!allowed.length) return { ok: false, error: H('err.noAiKeys', { label: pickText(f0.provider.label) }) }
  if (allowed.indexOf(key) < 0) return { ok: false, error: H('err.badKey', { key: key, label: pickText(f0.provider.label), list: allowed.join(' / ') }) }
  const intent = String((args && args.intent) || (key === 'home' ? H('intent.keyHome') : H('intent.keyBack'))).trim()
  const sn = f0.sn
  const g = permGate('key', sn)
  if (!g.ok) return { ok: false, error: g.error }
  const seq = ++ctlSeq
  if (g.mode !== 'trust') {
    const preview = cleanJson({ seq: seq, kind: 'key', sn: sn, key: key, intent: intent })
    const ap = await gateApproval(ctx, exec, 'scrcpy_key', H('appr.key', { what: key === 'home' ? H('verb.keyHome') : H('verb.keyBack'), intent: intent }), preview)
    if (!ap.ok) return { ok: false, error: ap.error }
  }
  ctlPending.push(cleanJson({ seq: seq, kind: 'key', sn: sn, key: key, intent: intent }))
  return cleanJson({ ok: true, seq: seq, key: key, intent: intent })
}

// ------------------------------------------------------------
// RPC 处理表（core 的浏览器半区调用）
//   provider 自己的方法走 provider:call 转发，core 不需要知道它们的形状
// ------------------------------------------------------------
const handlers = {
  'locale:set': async function (args) {
    // 客户端告诉宿主它现在是什么语言（DSH 的 locale 是**客户端**服务，宿主读不到）
    // 回执带上宿主当前实际语言 + 构建戳：客户端据此判断要不要重试，也方便一眼看出跑的是哪版宿主
    if (typeof relocalize === 'function') { relocalize(args && args.locale); return { ok: true, locale: hostLocale, build: CORE_BUILD } }
    hostLocale = (args && args.locale === 'en') ? 'en' : 'zh'
    return { ok: true, locale: hostLocale, build: CORE_BUILD, deferred: true }
  },
  'core:info': async function () {
    return { ok: true, core: 'dsh-scrcpy-core', version: CORE_VERSION, build: CORE_BUILD, locale: hostLocale, providers: registry.getProviders() }
  },
  'devices:list': async function () {
    return { ok: true, providers: registry.getProviders(), devices: mergedDevices(), focused: focusedSn, build: CORE_BUILD }
  },
  /** 只刷新**某一个** provider 的设备（【用户口述 2026-09-26】：每组自己的"刷新"按钮只刷自己） */
  'devices:refresh': async function (args) {
    const id = String((args && args.id) || '')
    const p = getProvider(id)
    if (!p) return { ok: false, error: H('err.noProvider', { id: id }) }
    const fn = p.actions && p.actions.listDevices
    if (typeof fn !== 'function') return { ok: false, error: H('err.noAction', { label: pickText(p.label), name: 'listDevices' }) }
    try {
      const list = await fn()
      registry.setDevices(id, Array.isArray(list) ? list : [])
      return { ok: true, devices: mergedDevices(), focused: focusedSn, build: CORE_BUILD }
    } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
  },
  // 网页要解码 H.264，需要 jmuxer 的源码（浏览器半区拿到后 eval 进页面）
  'jmuxer:source': async function () {
    try { return { ok: true, source: readFileSync(JMUXER_FILE, 'utf8') } } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  },
  'device:focus': async function (args) {
    const sn = String((args && args.sn) || '').trim()
    focusedSn = (sn && findDevice(sn)) ? sn : ''
    emitChange()
    return { ok: true, focused: focusedSn }
  },
  'device:connect': async function (args) {
    const sn = String((args && args.sn) || '').trim()
    if (!sn) return { ok: false, error: H('err.noSn') }
    const p = findProviderBySn(sn)
    if (!p) return { ok: false, error: H('err.notMine', { sn: sn }) }
    const act = requireAction(p, 'startStream', sn)
    if (!act.ok) return { ok: false, error: act.error }
    return await act.call({})
  },
  'device:disconnect': async function (args) {
    const sn = String((args && args.sn) || '').trim()
    if (!sn) return { ok: false, error: H('err.noSn') }
    const p = findProviderBySn(sn)
    if (!p) return { ok: false, error: H('err.notMine', { sn: sn }) }
    const act = requireAction(p, 'stopStream', sn)
    if (!act.ok) return { ok: false, error: act.error }
    const r = await act.call({})
    if (focusedSn === sn) { focusedSn = ''; emitChange() }
    return r || { ok: true }
  },
  'mode:get': async function () {
    return { ok: true, modes: { shot: Object.assign({}, modes.shot), ctl: Object.assign({}, modes.ctl), key: Object.assign({}, modes.key), input: Object.assign({}, modes.input) } }
  },
  'mode:set': async function (args) {
    const perm = String((args && args.perm) || '')
    const sn = String((args && args.sn) || '').trim()
    const mode = String((args && args.mode) || 'off')
    if (PERMS.indexOf(perm) < 0) return { ok: false, error: H('err.unknownPerm', { perm: perm }) }
    if (!sn) return { ok: false, error: H('err.noSn') }
    if (['off', 'confirm', 'trust'].indexOf(mode) < 0) return { ok: false, error: H('err.badMode', { mode: mode }) }
    if (perm !== 'shot' && mode !== 'off' && !(modes.shot || {})[sn]) {
      return { ok: false, error: H('err.needShot', { perm: permLabelOf(perm, sn) }) }
    }
    if (mode === 'off') {
      delete modes[perm][sn]
      if (perm === 'shot') { delete modes.ctl[sn]; delete modes.key[sn]; delete modes.input[sn] }
    } else {
      modes[perm][sn] = mode
    }
    emitChange()
    return { ok: true, perm: perm, sn: sn, mode: mode, modes: { shot: Object.assign({}, modes.shot), ctl: Object.assign({}, modes.ctl), key: Object.assign({}, modes.key), input: Object.assign({}, modes.input) } }
  },
  'ctl:dequeue': async function () {
    if (!ctlPending.length) return { ok: true, gesture: null }
    const g = ctlPending.shift()
    if (ctlPreview && ctlPreview.seq === g.seq) ctlPreview = null
    return { ok: true, gesture: g }
  },
  'ctl:preview': async function () { return { preview: ctlPreview ? cleanJson(ctlPreview) : null } },
  'ctl:pending': async function () { return { count: ctlPending.length } },
  // 面板上用户手动的动作：直接用户手势，不走 AI 门禁/确认
  'ctl:input': async function (args) {
    const text = String((args && args.text) || '').trim()
    if (!text) return { ok: false, error: H('err.noInputText') }
    const sn = String((args && args.sn) || '').trim() || focusedSn
    if (!sn) return { ok: false, error: H('err.noSnConnect') }
    const p = findProviderBySn(sn)
    if (!p) return { ok: false, error: H('err.notMine', { sn: sn }) }
    const act = requireAction(p, 'input', sn)
    if (!act.ok) return { ok: false, error: act.error }
    return await act.call({ text: text })
  },
  'shot:capture': async function (args) {
    const sn = String((args && args.sn) || '').trim() || focusedSn
    if (!sn) return { ok: false, error: H('err.noSnConnect') }
    const p = findProviderBySn(sn)
    if (!p) return { ok: false, error: H('err.notMine', { sn: sn }) }
    const act = requireAction(p, 'snapshot', sn)
    if (!act.ok) return { ok: false, error: act.error }
    const shot = await act.call({})
    if (!shot || !shot.ok) return { ok: false, error: (shot && shot.error) || H('err.shotFailed') }
    const mediaType = shot.mediaType || sniffMediaType(shot.bytes)
    if (!mediaType) return { ok: false, error: H('err.shotFormat') }
    return { ok: true, sn: sn, mediaType: mediaType, base64: bytesToBase64(shot.bytes), bytes: shot.bytes.length }
  },
  'model:list': async function (args, ctx) {
    const llm = ctx.get('llm')
    if (!llm) return { ok: false, error: H('err.llmUnavailable') }
    const models = await listModels(llm)
    const cfg = readConfig()
    return { ok: true, configured: { provider: cfg.visionProvider || '', model: cfg.visionModel || '' }, models: models }
  },
  'model:set': async function (args, ctx) {
    const provider = String((args && args.provider) || '').trim()
    const id = String((args && args.model) || '').trim()
    const llm = ctx.get('llm')
    if (!llm) return { ok: false, error: H('err.llmUnavailable') }
    if (id) {
      const hit = (await listModels(llm)).some((m) => m.id === id && (!provider || m.provider === provider))
      if (!hit) return { ok: false, error: H('err.modelMissing', { name: (provider ? provider + '/' : '') + id }) }
    }
    const cfg = readConfig(); cfg.visionProvider = provider; cfg.visionModel = id
    const r = writeConfig(cfg)
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, configured: { provider: provider, model: id } }
  },
  /** 把请求转发给某个 provider 自己的方法（它的配置、环境检测等，core 不关心形状） */
  'provider:call': async function (args) {
    const id = String((args && args.id) || '')
    const method = String((args && args.method) || '')
    const p = getProvider(id)
    if (!p) return { ok: false, error: H('err.noProvider', { id: id }) }
    const fn = p.handlers && p.handlers[method]
    if (typeof fn !== 'function') return { ok: false, error: H('provider.noMethod', { label: pickText(p.label), method: method }) }
    // provider 的文案可以是 { zh, en }：core 按当前语言挑好再交给客户端（见 pickText 的说明）
    return localizeDeep(await fn((args && args.args) || {}), 0)
  },
}

// ------------------------------------------------------------
// i18n（宿主半区）
//   语言由**客户端**经 RPC 告知（`locale:set`）—— 宿主自己读不到 DSH 的 locale（那是客户端服务）。
//   默认中文；英文是 DSH 的兜底语言。**日志/诊断行不翻**（【用户口述 2026-09-26】：给开发看的，
//   翻了反而不好 grep）。
// ------------------------------------------------------------
let hostLocale = 'zh'
/** apply() 里装上：换语言时重注册工具/提示词（RPC locale:set 调它）*/
let relocalize = null
const HOST_DICT = {
  zh: {
    'perm.shot': '允许截图', 'perm.ctl': '允许读取控件&点击/长按', 'perm.key': '允许按键', 'perm.keyDyn': '允许按键（{keys}）', 'perm.input': '允许输入文字',
    'mode.off': '禁止使用', 'mode.confirm': '需要确认', 'mode.trust': '无需确认',
    'provider.noMethod': '{label} 没有这个方法：{method}',
    // ── 工具 render 文案（工具卡里能看到）──
    'sep.list': '、', 'sep.comma': '，',
    'dev.queryFailed': '查询设备失败：{msg}', 'dev.available': '(可用)',
    'dev.unavailable': '(不可用:{note})', 'dev.providers': '【已装 provider】{list}',
    'dev.noProvider': '（一个都没装 —— 用户需要在插件面板里装 provider）',
    'dev.connected': '【已连接设备 {n} 台】{list}', 'dev.streaming': '(投屏中)',
    'dev.idle': '(未投屏)', 'dev.focusedMark': ' ←当前聚焦', 'dev.none': '（无）',
    'dev.focused': '【当前聚焦】{sn}（{label}） 权限：{perms}',
    'dev.noFocus': '【当前聚焦】无 —— 操作类工具现在都不可用，请先让用户在投屏面板里打开某台设备的画面',
    'shot.failed': '截图识别失败：{msg}', 'shot.head': '【截图识别 · {sn} · {model}】',
    'shot.empty': '（无内容）', 'shot.defaultPrompt': '请描述当前屏幕的内容。',
    'loc.failed': '控件清单获取失败：{msg}', 'loc.head': '【控件清单 · {sn} · {n} 项 · 屏幕 {w}x{h}】',
    'loc.clickable': ' [可点]', 'loc.readFailed': '读取控件树失败',
    'loc.empty': '未解析到任何可用控件（布局为空或全部不可见）',
    'tap.failed': '点击失败：{msg}', 'tap.queued': '【点击 · {intent}】\n已排队执行（比例坐标 {fx}, {fy}）',
    'lp.failed': '长按失败：{msg}', 'lp.queued': '【长按 · {intent}】\n已排队执行（比例坐标 {fx}, {fy} · 按住 {ms}ms）',
    'key.failed': '按键失败：{msg}', 'key.queued': '【按键 · {name}】\n已排队执行{intent}',
    'input.failed': '输入失败：{msg}', 'input.done': '【输入 · {text}】已注入到当前聚焦的输入框{intent}',
    // ── 报错（用户可见）──
    'err.llmUnavailable': 'llm 服务不可用', 'err.noModel': '没有任何提供方提供可用模型，截图识别不可用',
    'err.noLlm': 'llm 服务不可用，无法调用视觉模型', 'err.noApproval': 'approval 服务不可用，无法发起二次确认',
    'err.noAgent': '缺少调用代理身份，无法发起确认', 'err.approvalFailed': '二次确认失败: {msg}',
    'err.denied': '用户未允许（{outcome}）', 'err.badDshVersion': '无法读取 DSH 版本；截图识别仅支持 DSH {min} 及以上版本',
    'err.oldDsh': '当前 DSH 版本 {ver} 低于 {min}，截图识别不可用', 'err.noAttachments': 'attachments 服务不可用',
    'err.imageSave': '图片保存失败: {msg}', 'err.imageSave2': '图片保存失败：未返回图片引用',
    'err.visionFailed': '视觉模型调用失败: {msg}', 'err.visionThrew': '视觉模型调用异常: {msg}',
    'err.visionEmpty': '视觉模型未返回内容', 'err.shotFormat': '无法识别的截图格式（仅支持 PNG/JPEG）',
    'err.noFocus': '当前没有聚焦的投屏设备：先在某台设备的投屏面板里打开画面，再让我操作它',
    'err.deviceGone': '聚焦的设备 {sn} 已断开，请重新投屏后再操作',
    'err.noAction': '{label} 不支持这个操作（缺 {name}）：请检查 provider 版本',
    'err.permOff': '设备 {sn} 的「{perm}」为禁止使用（请在设置里选"需要确认/无需确认"；控制/按键/输入还需先开启「允许截图」）',
    'err.noSn': '缺少设备 SN', 'err.noSnConnect': '缺少设备 SN：请先连接投屏',
    'err.notMine': '设备 {sn} 不属于任何已装 provider', 'err.unknownPerm': '未知权限：{perm}',
    'err.badMode': '无效模式：{mode}', 'err.needShot': '请先开启「允许截图」再开启「{perm}」',
    'err.noInputText': '缺少输入内容', 'err.noText': '缺少 text：请填写要输入的内容',
    'err.noFx': '缺少 fx/fy：请传入目标中心的比例坐标(0..1)', 'err.injectFailed': '文本注入失败',
    'err.notStreaming': '设备 {sn} 未在投屏连接中：请先投屏连接该设备再执行{verb}',
    'err.badKey': '不支持的按键：{key}（{label} 支持 {list}）', 'err.noAiKeys': '{label} 没有声明可供 AI 使用的按键', 'err.modelMissing': '模型 {name} 不存在或不支持图片输入',
    'err.noProvider': '未安装 provider：{id}', 'err.unknown': '未知错误',
    'err.shotFailed': '截图失败',
    // ── 确认框文案（用户点确认时看到）──
    'verb.tap': '点击', 'verb.longpress': '长按',
    'verb.tapScreen': '点击屏幕', 'verb.longPressScreen': '长按屏幕',
    'verb.keyHome': '按 Home 键', 'verb.keyBack': '按返回键',
    'intent.keyHome': '按 Home 键回到桌面', 'intent.keyBack': '按返回键返回上一页',
    'intent.input': '输入「{text}」',
    'hold.suffix': '按住 {ms}ms 后松开，',
    'appr.screenshot': '允许截取设备 {sn} 的当前屏幕画面，并发送给 {model} 视觉模型识别？',
    'appr.locate': 'AI 想读取设备 {sn} 的当前屏幕控件清单（只读，不会操作屏幕）——是否允许？',
    'appr.input': 'AI 想向当前聚焦的输入框输入：「{text}」——是否允许？',
    'appr.tap': 'AI 想执行：{verb}「{intent}」（{hold}设备屏幕比例坐标 x={fx}, y={fy}）——是否允许？',
    'appr.key': 'AI 想执行：{what}「{intent}」——是否允许？',
    'err.relocalize': 'relocalize 未就绪',
  },
  en: {
    'prompt.tools': '[scrcpy tools] The user installed the scrcpy plugin: you can see and operate a phone/tablet screen from DSH. Tools: scrcpy_devices lists connected devices and which one is "focused" (needs no permission — start here); scrcpy_screenshot captures the screen and asks a vision model to describe it; scrcpy_locate reads the control list (type/text/id/key/clickable/fx/fy ratios/w/h); scrcpy_tap / scrcpy_longpress tap and long-press (always 0..1 ratios, taken from scrcpy_locate’s fx/fy); scrcpy_key sends back/home; scrcpy_input injects text into the focused input box. Typical flow: scrcpy_devices → scrcpy_screenshot or scrcpy_locate → scrcpy_tap with fx/fy.',
    'prompt.perms': '[scrcpy permissions] Each device has four independent switches with three states: blocked / ask each time / always allow. "Allow reading controls & tap/long-press" gates scrcpy_locate and scrcpy_tap/scrcpy_longpress; the keys switch gates scrcpy_key (which keys the AI may press is declared by the installed provider and shown in that device’s settings); "Allow text input" gates scrcpy_input. The last three all depend on "Allow screenshots" — turning screenshots off turns them off too. When a permission is off the tool returns an explicit error (do not retry in a loop; tell the user to enable it in the mirroring panel’s Settings). In "ask each time" mode every call shows a confirmation dialog (including reading the control list); the user may decline — do not retry after a refusal.',
    'prompt.focus': '[scrcpy focused device] Every operating tool acts only on the **currently focused** device (the one the user is looking at in the mirroring panel). You neither need to nor should guess a device. Use scrcpy_devices to check which one is focused and what its permissions are (the state changes — never rely on memory). With no focused device the tools fail explicitly; ask the user to open a device’s mirroring panel first.',
    'perm.shot': 'Allow screenshots', 'perm.ctl': 'Allow reading controls & tap/long-press', 'perm.key': 'Allow keys', 'perm.keyDyn': 'Allow keys ({keys})', 'perm.input': 'Allow text input',
    'mode.off': 'Blocked', 'mode.confirm': 'Ask each time', 'mode.trust': 'Always allow',
    'tool.devices.desc': 'Lists connected devices, which one is currently focused (the mirroring panel on screen) and its permission state. Callable at any time, needs no permission. Use it first whenever you need to know which device can be operated, or which one has its permissions locked.',
    'tool.screenshot.desc': 'Captures the focused device screen and asks the built-in vision model to describe it (confirm the page content, find the approximate text/description of a target control). Requires "Allow screenshots" on that device; in confirm mode every call asks the user first.',
    'tool.screenshot.prompt': 'What you want to learn from the picture (e.g. which app is this? what buttons are visible?).',
    'tool.locate.desc': 'Reads the control list of the focused device (read-only, performs no action). Each item carries type/text/id/key/clickable/fx/fy (0..1 ratios)/w/h. Pick a target from the list, then tap its fx/fy with scrcpy_tap. Requires "Allow reading controls & tap/long-press"; when that switch is "ask each time" this tool asks first as well.',
    'tool.locate.target': '(optional, context only) What you are looking for, e.g. like button, login button.',
    'tool.tap.desc': 'Taps once on the focused device screen. Coordinates are ratios (0..1) of the current picture — take them from scrcpy_locate’s fx/fy. Asks the user first and flashes a green dot where it will land (unless the switch is "always allow"). Requires "Allow reading controls & tap/long-press".',
    'tool.fx': 'Target centre as a horizontal ratio 0..1.',
    'tool.fy': 'Target centre as a vertical ratio 0..1.',
    'tool.tap.intent': 'What this tap is meant to do (shown in the confirmation dialog — be specific).',
    'tool.longpress.desc': 'Long-presses on the focused device screen (hold for a while, then release). Coordinates are ratios (0..1) of the current picture. Asks the user first and flashes a green dot (unless "always allow"). Requires "Allow reading controls & tap/long-press".',
    'tool.holdMs': 'Hold duration in milliseconds, default 2000.',
    'tool.longpress.intent': 'What this long-press is meant to do (shown in the confirmation dialog).',
    'tool.key.desc': 'Sends one system key to the focused device. Which keys the AI may press is declared by the installed provider; if you pass one it does not allow, the tool replies with the allowed list. Asks the user first (unless "always allow"). Requires "Allow keys" on that device.',
    'tool.key.key': 'Which key to press. The device’s provider decides which keys are allowed (back/home by default).',
    'tool.key.intent': 'What this key press is meant to do (shown in the confirmation dialog).',
    'tool.input.desc': 'Injects a piece of text into the focused input box of the focused device (Chinese supported). Focus the target input box first (usually by tapping it with scrcpy_tap). Asks the user first (unless "always allow"). Requires "Allow text input".',
    'tool.input.text': 'The text to type.',
    'tool.input.intent': 'What this input is meant to do (shown in the confirmation dialog).',
    'provider.noMethod': '{label} has no method: {method}',
    // ── tool render text (visible in the tool cards) ──
    'sep.list': ', ', 'sep.comma': ', ',
    'dev.queryFailed': 'Failed to query devices: {msg}', 'dev.available': '(available)',
    'dev.unavailable': '(unavailable: {note})', 'dev.providers': '[providers] {list}',
    'dev.noProvider': '(none installed — the user needs to install a provider from the plugin panel)',
    'dev.connected': '[connected devices: {n}] {list}', 'dev.streaming': '(mirroring)',
    'dev.idle': '(not mirroring)', 'dev.focusedMark': ' ←focused', 'dev.none': '(none)',
    'dev.focused': '[focused] {sn} ({label}) permissions: {perms}',
    'dev.noFocus': '[focused] none — operating tools are unavailable; ask the user to open a device’s mirroring panel first',
    'shot.failed': 'Screenshot recognition failed: {msg}', 'shot.head': '[screenshot · {sn} · {model}]',
    'shot.empty': '(no content)', 'shot.defaultPrompt': 'Describe what is currently on the screen.',
    'loc.failed': 'Failed to read the control list: {msg}', 'loc.head': '[controls · {sn} · {n} items · screen {w}x{h}]',
    'loc.clickable': ' [clickable]', 'loc.readFailed': 'Failed to read the control tree',
    'loc.empty': 'No usable controls parsed (empty layout or everything invisible)',
    'tap.failed': 'Tap failed: {msg}', 'tap.queued': '[tap · {intent}]\nqueued (ratios {fx}, {fy})',
    'lp.failed': 'Long-press failed: {msg}', 'lp.queued': '[long-press · {intent}]\nqueued (ratios {fx}, {fy} · hold {ms}ms)',
    'key.failed': 'Key failed: {msg}', 'key.queued': '[key · {name}]\nqueued{intent}',
    'input.failed': 'Input failed: {msg}', 'input.done': '[input · {text}] injected into the focused input box{intent}',
    // ── errors (user visible) ──
    'err.llmUnavailable': 'The llm service is unavailable', 'err.noModel': 'No provider offers a usable model; screenshot recognition is unavailable',
    'err.noLlm': 'The llm service is unavailable; cannot call the vision model', 'err.noApproval': 'The approval service is unavailable; cannot ask for confirmation',
    'err.noAgent': 'Missing the calling agent identity; cannot ask for confirmation', 'err.approvalFailed': 'Confirmation failed: {msg}',
    'err.denied': 'The user did not allow it ({outcome})', 'err.badDshVersion': 'Cannot read the DSH version; screenshot recognition needs DSH {min} or newer',
    'err.oldDsh': 'This DSH version ({ver}) is older than {min}; screenshot recognition is unavailable', 'err.noAttachments': 'The attachments service is unavailable',
    'err.imageSave': 'Failed to save the image: {msg}', 'err.imageSave2': 'Failed to save the image: no reference returned',
    'err.visionFailed': 'Vision model call failed: {msg}', 'err.visionThrew': 'Vision model call threw: {msg}',
    'err.visionEmpty': 'The vision model returned nothing', 'err.shotFormat': 'Unrecognised screenshot format (PNG/JPEG only)',
    'err.noFocus': 'No focused mirroring device: open a device’s mirroring panel first, then ask me to operate it',
    'err.deviceGone': 'The focused device {sn} is disconnected; mirror it again and retry',
    'err.noAction': '{label} does not support this action (missing {name}): check the provider version',
    'err.permOff': '"{perm}" for device {sn} is blocked (pick "ask each time" or "always allow" in Settings; controls/keys/typing also need "Allow screenshots")',
    'err.noSn': 'Missing device SN', 'err.noSnConnect': 'Missing device SN: connect the device first',
    'err.notMine': 'Device {sn} does not belong to any installed provider', 'err.unknownPerm': 'Unknown permission: {perm}',
    'err.badMode': 'Invalid mode: {mode}', 'err.needShot': 'Turn on "Allow screenshots" before enabling "{perm}"',
    'err.noInputText': 'Missing input text', 'err.noText': 'Missing text: provide the text to type',
    'err.noFx': 'Missing fx/fy: pass the target centre as ratios (0..1)', 'err.injectFailed': 'Text injection failed',
    'err.notStreaming': 'Device {sn} is not mirroring: connect it first, then {verb}',
    'err.badKey': 'Unsupported key: {key} ({label} supports {list})', 'err.noAiKeys': '{label} declares no keys the AI may use', 'err.modelMissing': 'Model {name} does not exist or does not accept images',
    'err.noProvider': 'Provider not installed: {id}', 'err.unknown': 'Unknown error',
    'err.shotFailed': 'Screenshot failed',
    // ── confirmation dialog copy (shown when the user is asked) ──
    'verb.tap': 'tap', 'verb.longpress': 'long-press',
    'verb.tapScreen': 'tap the screen', 'verb.longPressScreen': 'long-press the screen',
    'verb.keyHome': 'Home', 'verb.keyBack': 'Back',
    'intent.keyHome': 'press Home to go to the desktop', 'intent.keyBack': 'press Back to return',
    'intent.input': 'type “{text}”',
    'hold.suffix': 'hold for {ms}ms then release, ',
    'appr.screenshot': 'Capture the screen of {sn} and send it to the {model} vision model?',
    'appr.locate': 'The AI wants to read the control list of {sn} (read-only; it will not touch the screen) — allow?',
    'appr.input': 'The AI wants to type into the focused input box: “{text}” — allow?',
    'appr.tap': 'The AI wants to {verb} “{intent}” ({hold}device screen ratios x={fx}, y={fy}) — allow?',
    'appr.key': 'The AI wants to press {what} (“{intent}”) — allow?',
    'err.relocalize': 'relocalize is not ready',
  },
}
/** 占位替换（{name}），缺参数就原样留着，便于发现漏传 */
function tmplH(s, params) {
  if (!params) return s
  return String(s).replace(/\{(\w+)\}/g, function (m, k) {
    return Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m
  })
}
/**
 * 宿主半区取文案。回退顺序：**当前语言 → 英文 → 中文 → key 本身**。
 * ⚠️ 英文在中间是有意的：**面向 AI 的文案（三段提示词 + 7 个工具的描述/参数）只写在 `en` 里**，
 *    所以无论界面是什么语言，AI 拿到的永远是英文 —— 跟 DSH 自己的系统提示词一致
 *    （【用户口述 2026-09-26】："不应该把提示词也分中英文，应该跟随 dsh 永远英文"）。
 */
function H(key, params) {
  const dict = HOST_DICT[hostLocale] || HOST_DICT.en
  const s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key]
    : (Object.prototype.hasOwnProperty.call(HOST_DICT.en, key) ? HOST_DICT.en[key]
      : (Object.prototype.hasOwnProperty.call(HOST_DICT.zh, key) ? HOST_DICT.zh[key] : key))
  return tmplH(s, params)
}

// 固定三段提示词（【用户口述】§9.2：不再把当前设备状态写进提示词）—— 按当前语言现取
function fixedPrompt() {
  return [H('prompt.tools'), H('prompt.perms'), H('prompt.focus')].join('\n')
}

// ------------------------------------------------------------
// provider 的双语文案（【用户口述 2026-09-26】：provider 里直接放两套、**core 挑一个**）
//   provider 返回的用户可见文案可以是 `{ zh, en }`；字符串 = 两语言同值（向后兼容）。
//   好处：**core 不必把语言传给 provider**（少一个参数就少一个 bug 点），provider 也不用读 DSH 的 locale。
// ------------------------------------------------------------
function pickText(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    // 【用户实测 2026-09-29】设备行显示成 `（[object Object]）`：值是对象但**不是**标准的 {zh,en} 形状
    //   （例如嵌套一层、或键名既不是 zh/en 也不是当前 locale），老代码 String(对象) 就出了 [object Object]。
    const hit = v[hostLocale] != null ? v[hostLocale] : (v.zh != null ? v.zh : (v.en != null ? v.en : null))
    if (hit == null) {
      // 挑不出语言就**别静默**：按项目约定给 JSON 原文，让下次排查看得见（而不是 [object Object]）
      try { return JSON.stringify(v) } catch (e) { return String(v) }
    }
    return typeof hit === 'object' ? pickText(hit) : String(hit)   // 值还是对象（嵌套双语）→ 再挑一层
  }
  return String(v)
}
/** 只对**已知的文案字段**挑语言（避免误伤数据里恰好叫 zh/en 的字段）。
 *  `on`/`off`/`notReady` 是给 `capabilities.keyboard` 用的（provider 声明"有没有键盘输入"和两句话）。*/
const TEXT_KEYS = ['label', 'hint', 'help', 'note', 'placeholder', 'title', 'text', 'error', 'blockReason', 'providerLabel', 'on', 'off', 'notReady']
function localizeDeep(v, depth) {
  if (v == null || typeof v !== 'object') return v
  if ((depth || 0) > 5) return v
  if (Array.isArray(v)) return v.map(function (x) { return localizeDeep(x, (depth || 0) + 1) })
  const out = {}
  for (const k of Object.keys(v)) {
    const val = v[k]
    // keyLabels 是「键名 → {zh,en}」的字典：**里面的键名是任意的**，进不了 TEXT_KEYS，
    // 必须整表逐条挑语言 —— 漏了它，{zh,en} 对象就会原样送到界面，
    // React 渲染对象子节点会抛错并把整棵 UI 树卸掉（2026-09-27 实测：一点"启动"画面连同菜单全没）
    if (k === 'keyLabels' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const m = {}
      for (const kk of Object.keys(val)) m[kk] = pickText(val[kk])
      out[k] = m
      continue
    }
    out[k] = (TEXT_KEYS.indexOf(k) >= 0 && val !== null && typeof val === 'object')
      ? pickText(val)
      : localizeDeep(val, (depth || 0) + 1)
  }
  return out
}

// ------------------------------------------------------------
// HTTP：POST /dsh-scrcpy/rpc
// ------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1024 * 1024) { req.destroy(); reject(new Error('request body too large')) } })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}
async function rpcHandler(req, res, ctx) {
  try {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
    let parsed
    try { parsed = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: 'invalid json body' }) }
    const method = String(parsed.method || '')
    const handler = handlers[method]
    if (!handler) return json(res, 404, { ok: false, error: 'unknown method: ' + method })
    const result = await handler(parsed.args || {}, ctx)
    json(res, 200, { ok: true, result: result })
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) })
  }
}

// ------------------------------------------------------------
// 插件出口
// ------------------------------------------------------------
export default {
  name: 'dsh-scrcpy-core',
  inject: ['webServer', 'tools'],
  apply(ctx) {
    // RPC 路由
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: RPC_PATH, handler: (req, res) => rpcHandler(req, res, ctx) }),
      'dsh-scrcpy-core: rpc route',
    )

    // 把 provider 注册表作为服务提供出去（provider 用 inject: ['scrcpyProviders'] 依赖它）
    // ⚠️【未实测】ctx.provide 的用法按 cordis src/reflect.ts:277 写的，还没跑起来验过
    ctx.effect(() => ctx.provide('scrcpyProviders', registry), 'dsh-scrcpy-core: provider registry')

    // 固定三段提示词（【用户口述】§9.2：固定文本，状态靠 scrcpy_devices 查）—— 可重注册（换语言要换文案）
    const sysPrompt = ctx.get('systemPrompt')
    let promptDisposer = null
    function registerPrompt() {
      if (!sysPrompt) return
      try { if (typeof promptDisposer === 'function') promptDisposer() } catch (e) {}
      try {
        promptDisposer = sysPrompt.section({ name: PROMPT_SECTION, order: PROMPT_ORDER, text: fixedPrompt() })
      } catch (e) { console.error('[dsh-scrcpy-core] 注册提示词失败: ' + String((e && e.message) || e)) }
    }

    // 工具：常驻注册（权限在调用时判，见文件头的说明）—— 可重注册（换语言要换描述）
    const disposers = []
    function registerTools() {
      disposers.forEach((d) => { try { d() } catch (e) {} })
      disposers.length = 0
      for (const build of [toolDevices, toolScreenshot, toolLocate, toolTap, toolLongPress, toolKey, toolInput]) {
        try {
          disposers.push(ctx.tools.register(build(ctx)))
        } catch (e) {
          console.error('[dsh-scrcpy-core] 注册工具失败: ' + String((e && e.message) || e))
        }
      }
    }

    // 客户端把语言告诉我们（RPC locale:set）→ 换语言 + 重注册工具/提示词
    relocalize = function (loc) {
      const next = String(loc || '').toLowerCase().startsWith('en') ? 'en' : 'zh'
      if (next === hostLocale) return { ok: true, locale: hostLocale, changed: false }
      hostLocale = next
      registerPrompt()
      registerTools()
      return { ok: true, locale: hostLocale, changed: true }
    }

    registerPrompt()
    registerTools()

    ctx.on('dispose', function () {
      disposers.forEach((d) => { try { d() } catch (e) {} })
      ctlPending = []
      ctlPreview = null
      providers.clear()
      devicesByProvider.clear()
      focusedSn = ''
    })
  },
}
