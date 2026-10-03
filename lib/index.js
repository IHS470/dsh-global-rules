/**
 * dsh-global-rules — host half.
 *
 * Owns one user-owned list of global rules and delivers it to the model on
 * every single request, so "check the rules before answering" is a property of
 * the request rather than of the conversation history:
 *
 *   - `ctx.systemPrompt.section()` injects the rendered rule list into every
 *     assembled system prompt (order 100: right after the deployment persona,
 *     before the tool sections);
 *   - the `global_rules` tool lets the agent read and change the same list;
 *   - the `/rules` command gives the human a one-line editor in the composer;
 *   - the browser half's Settings page edits it point-and-click.
 *
 * All three callers reach one store, so they can never disagree:
 *
 *   GET  /dsh-global-rules/state   current state + the exact injected text
 *   POST /dsh-global-rules/state   replace state (JSON)
 *
 * The store lives under `$DSH_HOME/dsh-global-rules/`, never inside the
 * package: an installed plugin directory may be read-only or replaced.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Cordis plugin name (the patch id matches it). */
export const name = 'global-rules'

/** Official services this plugin needs; a missing one keeps it pending. */
export const inject = ['webServer', 'tools', 'systemPrompt']

const PACKAGE_NAME = 'dsh-global-rules'
const ROUTE_PREFIX = '/dsh-global-rules'
const TOOL_NAME = 'global_rules'
const COMMAND_NAME = 'rules'
const SECTION_NAME = 'global-rules'
/**
 * 100 sits between the deployment persona (0) and PLAN_POLICY (500): the rules
 * follow the identity block and precede every tool instruction.
 */
const SECTION_ORDER = 100

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'dsh-global-rules')
const STORE_FILE = path.join(DATA_DIR, 'rules.json')

/** Bounds: a rule list is guidance, not a document store. */
const MAX_RULES = 200
const MAX_RULE_CHARS = 2000
const MAX_BODY_BYTES = 256 * 1024

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** The state every install starts from: enabled, with no rules yet. */
function defaultStore() {
  return { version: 1, enabled: true, acknowledge: false, rules: [], updatedAt: null }
}

function newId() {
  return `r-${randomUUID().slice(0, 8)}`
}

/** One rule body: line endings normalized, trimmed, bounded. */
function cleanText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n?/g, '\n').trim().slice(0, MAX_RULE_CHARS)
}

/**
 * Coerce one wire/disk rule. A bare string is accepted so the store stays
 * hand-editable and a text-mode paste needs no ids.
 */
function sanitizeRule(raw) {
  if (typeof raw === 'string') {
    const text = cleanText(raw)
    return text ? { id: newId(), text, enabled: true } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const text = cleanText(raw.text)
  if (!text) return null
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 40) : newId()
  return { id, text, enabled: raw.enabled !== false }
}

/** Normalize a whole rule list, minting ids for entries that lack one. */
function normalizeRules(input) {
  if (!Array.isArray(input)) return { error: 'rules must be an array' }
  const rules = []
  const seen = new Set()
  for (const entry of input) {
    if (rules.length >= MAX_RULES) return { error: `too many rules (max ${MAX_RULES})` }
    const rule = sanitizeRule(entry)
    if (!rule) return { error: 'every rule needs non-empty text' }
    if (seen.has(rule.id)) rule.id = newId()
    seen.add(rule.id)
    rules.push(rule)
  }
  return { rules }
}

/**
 * Coerce anything read from disk into a valid store.
 *
 * Reading is lenient on purpose: a hand-edited file with one malformed entry
 * keeps every other rule instead of losing the whole list. Writing is strict
 * ({@link normalizeRules}), so the UI never persists a broken entry.
 */
function sanitizeStore(raw) {
  const base = defaultStore()
  if (!raw || typeof raw !== 'object') return base
  const rules = []
  const seen = new Set()
  for (const entry of Array.isArray(raw.rules) ? raw.rules : []) {
    if (rules.length >= MAX_RULES) break
    const rule = sanitizeRule(entry)
    if (!rule) continue
    if (seen.has(rule.id)) rule.id = newId()
    seen.add(rule.id)
    rules.push(rule)
  }
  return {
    version: 1,
    enabled: raw.enabled !== false,
    acknowledge: raw.acknowledge === true,
    rules,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  }
}

/**
 * The store is read on every prompt assembly, so it is cached and revalidated
 * by file identity instead of re-parsed per model step. An unreadable or
 * corrupt file keeps the last good value rather than silently dropping rules.
 */
let cached = null
let cachedStamp = ''

function loadStore() {
  let stat
  try {
    stat = fs.statSync(STORE_FILE)
  } catch {
    if (!cached) cached = defaultStore()
    return cached
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`
  if (cached && stamp === cachedStamp) return cached
  try {
    cached = sanitizeStore(JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')))
  } catch {
    if (!cached) cached = defaultStore()
  }
  cachedStamp = stamp
  return cached
}

/** Persist atomically (temp + rename) and refresh the cache. */
function commitStore(next) {
  const store = { ...sanitizeStore(next), updatedAt: new Date().toISOString() }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${STORE_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, STORE_FILE)
  cached = store
  try {
    const stat = fs.statSync(STORE_FILE)
    cachedStamp = `${stat.mtimeMs}:${stat.size}`
  } catch {
    cachedStamp = ''
  }
  return store
}

/** The rules that actually reach the model. */
function enabledRules(store) {
  return store.rules.filter((rule) => rule.enabled)
}

// ---------------------------------------------------------------------------
// The one rendering every caller shows
// ---------------------------------------------------------------------------

/**
 * The exact text that enters the system prompt. Empty when the feature is off
 * or no rule is enabled: `renderPrompt` drops empty sections, so a disabled
 * feature costs nothing at all.
 */
function renderSection(store) {
  const rules = enabledRules(store)
  if (!store.enabled || rules.length === 0) return ''
  const lines = [
    '## 全局规则（每次回答前必须逐条核对）',
    '',
    '以下规则由用户维护。在生成任何回答之前，先逐条核对本清单，并确保最终回答完全符合每一条；若某条规则与本次要求冲突，以规则为准，并在回答中说明冲突。',
    '',
  ]
  rules.forEach((rule, index) => lines.push(`${index + 1}. ${rule.text}`))
  lines.push('')
  lines.push(
    `（共 ${rules.length} 条启用规则，存储于 ${STORE_FILE}；可在「设置 → 全局规则」、${TOOL_NAME} 工具或 /${COMMAND_NAME} 命令中修改。）`,
  )
  lines.push('')
  if (store.acknowledge) {
    lines.push(
      '核对后，在回答的最后另起一行输出一行核对结果，格式：`规则检查：已核对 N 条`（N 为本清单条数）；若某条无法满足，改写这一行说明是哪一条、为什么。',
    )
  } else {
    // Silent by default: the check happens, but nothing about it is printed.
    lines.push('核对在内部完成即可：不要在回答里输出规则核对结果、规则编号或规则清单本身。')
  }
  return lines.join('\n')
}

/** Human/agent-readable status of the whole store. */
function describeStore(store) {
  const enabled = enabledRules(store).length
  const head = `全局规则：${store.enabled ? '已启用' : '已停用'}，共 ${store.rules.length} 条（启用 ${enabled} 条），回答里显示规则检查：${store.acknowledge ? '开' : '关'}。`
  if (store.rules.length === 0) {
    return `${head}\n还没有规则。用 action=add 添加，或在「设置 → 全局规则」里编辑。`
  }
  const list = store.rules
    .map((rule, index) => `${index + 1}. ${rule.enabled ? '' : '[停用] '}${rule.text.replace(/\n/g, ' ')}`)
    .join('\n')
  return `${head}\n${list}\n\n存储文件：${STORE_FILE}\n注入位置：系统提示第 ${SECTION_ORDER} 位（每一条规则都会出现在每一次请求里）`
}

// ---------------------------------------------------------------------------
// One mutation path for the tool and the command
// ---------------------------------------------------------------------------

/** Resolve a rule by 1-based index (preferred) or by id. */
function findRule(store, args) {
  const index = Number(args.index)
  if (Number.isInteger(index) && index >= 1 && index <= store.rules.length) return index - 1
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  if (id) {
    const found = store.rules.findIndex((rule) => rule.id === id)
    if (found >= 0) return found
    return -1
  }
  return -1
}

/**
 * Apply one action to a copy of the store.
 * @returns `{ store }` after a mutation, or `{ error }` naming what was wrong.
 */
function runAction(store, action, args) {
  const next = { ...store, rules: store.rules.map((rule) => ({ ...rule })) }
  switch (action) {
    case 'list':
      return { text: describeStore(store) }
    case 'add': {
      const text = cleanText(args.text)
      if (!text) return { error: 'add needs text' }
      if (next.rules.length >= MAX_RULES) return { error: `too many rules (max ${MAX_RULES})` }
      const rule = { id: newId(), text, enabled: true }
      next.rules.push(rule)
      return { store: commitStore(next), text: `已添加第 ${next.rules.length} 条规则。\n${describeStore(loadStore())}` }
    }
    case 'update': {
      const at = findRule(next, args)
      if (at < 0) return { error: 'update needs index (1-based) or id of an existing rule' }
      const text = cleanText(args.text)
      let touched = false
      if (text) {
        next.rules[at].text = text
        touched = true
      }
      if (args.ruleEnabled !== undefined) {
        next.rules[at].enabled = args.ruleEnabled !== false
        touched = true
      }
      if (!touched) return { error: 'update needs text and/or ruleEnabled' }
      return { store: commitStore(next), text: `已更新第 ${at + 1} 条规则。\n${describeStore(loadStore())}` }
    }
    case 'remove': {
      const at = findRule(next, args)
      if (at < 0) return { error: 'remove needs index (1-based) or id of an existing rule' }
      const [removed] = next.rules.splice(at, 1)
      return { store: commitStore(next), text: `已删除第 ${at + 1} 条规则：${removed.text.slice(0, 80)}\n${describeStore(loadStore())}` }
    }
    case 'clear': {
      if (next.rules.length === 0) return { error: 'there is no rule to clear' }
      const count = next.rules.length
      next.rules = []
      return { store: commitStore(next), text: `已清空 ${count} 条规则。\n${describeStore(loadStore())}` }
    }
    case 'replace': {
      const normalized = normalizeRules(args.rules)
      if (normalized.error) return { error: normalized.error }
      next.rules = normalized.rules
      return { store: commitStore(next), text: `已用 ${next.rules.length} 条规则替换整份清单。\n${describeStore(loadStore())}` }
    }
    case 'configure': {
      let touched = false
      if (args.enabled !== undefined) {
        next.enabled = args.enabled !== false
        touched = true
      }
      if (args.acknowledge !== undefined) {
        next.acknowledge = args.acknowledge === true
        touched = true
      }
      if (!touched) return { error: 'configure needs enabled and/or acknowledge' }
      return { store: commitStore(next), text: describeStore(loadStore()) }
    }
    default:
      return { error: `unknown action "${action}"` }
  }
}

// ---------------------------------------------------------------------------
// The Agent-facing tool
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTION = [
  '读取或修改「全局规则」——用户维护的一组规则，每次回答前都必须逐条核对。',
  'Read or change the user\'s global rules: a rule list injected into every request\'s system prompt that the agent must check before answering.',
  '',
  'action：',
  '- list：查看当前规则（默认动作）；',
  '- add：新增一条（需要 text）；',
  '- update：修改第 index 条（或 id），可给 text 和/或 ruleEnabled（单条启用/停用）；',
  '- remove：删除第 index 条（或 id）；',
  '- clear：清空全部规则；',
  '- replace：用 rules 数组整份替换（一行一条）；',
  '- configure：开关 enabled（是否注入系统提示）与 acknowledge（是否要求回答末尾附规则检查行）。',
  '',
  'index 从 1 开始。改动立即生效：下一次模型请求就会带上新规则。用户在设置页也能改同一份数据。',
].join('\n')

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'update', 'remove', 'clear', 'replace', 'configure'],
      description: 'Which operation to perform. Defaults to "list" when omitted.',
    },
    text: { type: 'string', description: 'Rule body for add, or the new body for update.' },
    id: { type: 'string', description: 'Rule id for update/remove (alternative to index).' },
    index: { type: 'integer', description: '1-based rule position for update/remove.' },
    rules: { type: 'array', items: { type: 'string' }, description: 'Complete rule list for replace, one rule per element.' },
    enabled: { type: 'boolean', description: 'configure: inject the rules into every system prompt.' },
    acknowledge: { type: 'boolean', description: 'configure: require a "规则检查：已核对 N 条" line at the end of every answer.' },
    ruleEnabled: { type: 'boolean', description: 'update: enable or disable that single rule.' },
  },
  required: ['action'],
}

/** Run one tool call against the same store the prompt section reads. */
async function runTool(args) {
  const input = args && typeof args === 'object' ? args : {}
  const action = typeof input.action === 'string' && input.action ? input.action : 'list'
  const result = runAction(loadStore(), action, input)
  if (result.error) throw new Error(`${TOOL_NAME}: ${result.error}`)
  return result.text
}

/** The registry-ready definition (plain JSON Schema, no build step). */
function toolDefinition() {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: (args) => runTool(args),
  }
}

// ---------------------------------------------------------------------------
// The /rules command
// ---------------------------------------------------------------------------

const COMMAND_HELP = [
  '全局规则（回答前逐条核对）用法：',
  '  /rules                     查看当前规则',
  '  /rules add <文本>          新增一条',
  '  /rules remove <序号>       删除第 N 条',
  '  /rules clear yes           清空全部',
  '  /rules on | off            启用 / 停用注入',
  '  /rules check on | off      回答里显示 / 不显示规则检查行',
  '  /rules help                显示这段说明',
  '',
  '也可以让我（Agent）用 global_rules 工具改，或在「设置 → 全局规则」里可视化编辑。',
].join('\n')

/** Parse one command line and route it through the shared action path. */
function runCommand(rawInput) {
  const input = String(rawInput || '').trim()
  const [verb = 'list', ...rest] = input.split(/\s+/)
  const tail = rest.join(' ').trim()
  const store = loadStore()

  const finish = (result) => (result.error
    ? { kind: 'error', text: `${result.error}\n\n${COMMAND_HELP}` }
    : { kind: 'success', text: result.text })

  switch (verb.toLowerCase()) {
    case '':
    case 'list':
      return finish({ text: describeStore(store) })
    case 'help':
      return { kind: 'success', text: COMMAND_HELP }
    case 'add':
      return finish(runAction(store, 'add', { text: tail }))
    case 'remove':
    case 'rm':
      return finish(runAction(store, 'remove', { index: Number(tail) }))
    case 'clear':
      return tail.toLowerCase() === 'yes'
        ? finish(runAction(store, 'clear', {}))
        : { kind: 'error', text: `清空全部 ${store.rules.length} 条规则不可撤销。确认请执行：/rules clear yes` }
    case 'on':
      return finish(runAction(store, 'configure', { enabled: true }))
    case 'off':
      return finish(runAction(store, 'configure', { enabled: false }))
    case 'check':
      if (tail.toLowerCase() === 'on') return finish(runAction(store, 'configure', { acknowledge: true }))
      if (tail.toLowerCase() === 'off') return finish(runAction(store, 'configure', { acknowledge: false }))
      return { kind: 'error', text: `用法：/rules check on 或 /rules check off\n\n${COMMAND_HELP}` }
    default:
      return { kind: 'error', text: `未知子命令「${verb}」。\n\n${COMMAND_HELP}` }
  }
}

/** Register the command only when the composition provides the service. */
function registerCommand(ctx) {
  ctx.inject(['commands'], (child) => {
    child.effect(() => child.commands.register({
      name: COMMAND_NAME,
      description: '查看/修改全局规则（每次回答前逐条核对）',
      input: { hint: 'list | add <文本> | remove <序号> | clear yes | on | off | check on|off' },
      handler: ({ rawInput }) => runCommand(rawInput),
    }))
  })
}

// ---------------------------------------------------------------------------
// HTTP route (the browser half's data path)
// ---------------------------------------------------------------------------

/**
 * Reject a request that did not come from this machine's own page. The Host
 * fence is authoritative when present; the local check keeps the route closed
 * on compositions that lack it.
 */
function rejectionStatus(ctx, req) {
  const connection = safeGet(ctx, 'connection')
  const fence = connection && typeof connection.requestRejection === 'function' ? connection : undefined
  let hostname = ''
  let authority = ''
  try {
    const url = new URL(`http://${String((req.headers && req.headers.host) || '')}`)
    hostname = url.hostname
    authority = url.host
  } catch {
    return 403
  }
  const headers = req.headers || {}
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
  const origin = headers.origin
  if (typeof origin === 'string' && origin && origin !== 'null') {
    try {
      if (new URL(origin).host !== authority) return 403
    } catch {
      return 403
    }
  }
  if (!fence) {
    const local = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    return local ? null : 403
  }
  try {
    const code = fence.requestRejection(req)
    if (code === undefined || code === null || code === false) return null
    return typeof code === 'number' ? code : 403
  } catch {
    return 403
  }
}

function safeGet(ctx, key) {
  try {
    return ctx.get ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** Read at most `limit` bytes of a request body. */
async function readBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > limit) throw new Error('too-large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** The JSON the browser half reads. */
function publicState(store) {
  const enabled = enabledRules(store).length
  return {
    enabled: store.enabled,
    acknowledge: store.acknowledge,
    rules: store.rules.map((rule) => ({ ...rule })),
    count: store.rules.length,
    enabledCount: enabled,
    preview: renderSection(store),
    updatedAt: store.updatedAt,
    path: STORE_FILE,
    sectionOrder: SECTION_ORDER,
    toolName: TOOL_NAME,
    commandName: COMMAND_NAME,
    limits: { maxRules: MAX_RULES, maxRuleChars: MAX_RULE_CHARS },
  }
}

/** Replace the state from the browser half. */
function applyPatch(store, patch) {
  if (!patch || typeof patch !== 'object') return { error: 'invalid-patch' }
  const next = { ...store, rules: store.rules.map((rule) => ({ ...rule })) }
  let touched = false
  if (patch.enabled !== undefined) {
    next.enabled = patch.enabled !== false
    touched = true
  }
  if (patch.acknowledge !== undefined) {
    next.acknowledge = patch.acknowledge === true
    touched = true
  }
  if (patch.rules !== undefined) {
    const normalized = normalizeRules(patch.rules)
    if (normalized.error) return { error: normalized.error }
    next.rules = normalized.rules
    touched = true
  }
  if (!touched) return { error: 'no recognized field' }
  return { store: commitStore(next) }
}

/** Serve the plugin's own routes for the life of the fiber. */
async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const route = url.pathname
  const method = req.method || 'GET'

  if (route === `${ROUTE_PREFIX}/state` && (method === 'GET' || method === 'HEAD')) {
    sendJson(res, 200, publicState(loadStore()))
    return
  }

  if (route === `${ROUTE_PREFIX}/state` && method === 'POST') {
    let patch
    try {
      patch = JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8') || '{}')
    } catch {
      sendJson(res, 400, { error: 'invalid-json' })
      return
    }
    const result = applyPatch(loadStore(), patch)
    if (result.error) {
      sendJson(res, 400, { error: result.error })
      return
    }
    sendJson(res, 200, publicState(result.store))
    return
  }

  sendJson(res, 404, { error: 'not-found' })
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Mount the prompt section, the routes, the tool, and the command.
 * @param ctx - host services named in {@link inject}.
 */
export function apply(ctx) {
  fs.mkdirSync(DATA_DIR, { recursive: true })

  // The rules reach the model here: the section text is a function of the
  // store, so it is recomputed for every assembly and an edit applies to the
  // next request. `interpolate: false` keeps rule text literally as written.
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    interpolate: false,
    text: () => renderSection(loadStore()),
  })

  ctx.effect(() => {
    const offTool = ctx.tools.register(toolDefinition())

    const offRoute = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        const rejected = rejectionStatus(ctx, req)
        if (rejected !== null) {
          try {
            res.writeHead(rejected)
            res.end()
          } catch {}
          return
        }
        // Returned so the carrier awaits the response; failures still answer 500.
        return handle(req, res).catch((error) => {
          try {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          } catch {}
        })
      },
    })

    registerCommand(ctx)
    announce(ctx)

    return () => {
      offTool()
      offRoute()
    }
  })
}

/**
 * One startup line for the Host log: it names the store, the rule count, and
 * whether the browser half composed — the three things a broken install loses.
 */
function announce(ctx) {
  const store = loadStore()
  let client = 'unknown'
  try {
    const modules = safeGet(ctx, 'clientModules')
    if (modules && typeof modules.clientPath === 'function') {
      client = modules.clientPath(PACKAGE_NAME) ? 'composed' : 'MISSING'
    }
  } catch {}
  console.error(
    `dsh-global-rules: ready rules=${enabledRules(store).length}/${store.rules.length} enabled=${store.enabled} acknowledge=${store.acknowledge} client=${client} store=${STORE_FILE}`,
  )
}
