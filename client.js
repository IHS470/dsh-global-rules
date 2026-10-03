/**
 * dsh-global-rules — browser half.
 *
 * One job: the Settings page 「全局规则」, which edits the Host-owned rule list
 * that every request's system prompt carries. The Host half owns the store, the
 * prompt section, the `global_rules` tool and the `/rules` command; this half
 * reads the same state over `/dsh-global-rules/state` and writes it back, so
 * the page, the tool and the command can never disagree.
 *
 * The page also shows the exact text the model will receive, because "did my
 * rules really reach the prompt" is the one question the editor must answer.
 */

window.__ModuleLoader__.load({
  id: 'dsh-global-rules',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const PREFIX = '/dsh-global-rules'
    const PAGE_STYLE_ID = 'dsh-global-rules-page-style'

    const zh = {
      nav: '全局规则',
      title: '全局规则',
      intro: '这里维护的规则会注入每一步请求的系统提示，Agent 在回答任何问题前都必须逐条核对。设置页、global_rules 工具和 /rules 命令改的都是同一份数据。',
      enable: '启用全局规则',
      enableHint: '关闭后系统提示里不再注入规则（规则内容仍保留）',
      acknowledge: '回答里显示规则检查',
      acknowledgeHint: '要求 Agent 在每次回答末尾附一行「规则检查：已核对 N 条」',
      rules: '规则清单',
      rulesCount: (on, total) => `启用 ${on} / 共 ${total} 条`,
      add: '新增规则',
      bulkEdit: '编辑为文本',
      bulkHint: '一行一条规则；行号与左侧列表一一对应，停用状态按行号保留。',
      applyBulk: '应用到列表',
      cancelBulk: '取消',
      moveUp: '上移',
      moveDown: '下移',
      remove: '删除',
      enableRule: '启用这条规则',
      rulePlaceholder: '例如：回答里不要用「首先/其次/最后」这类套话。',
      empty: '还没有规则。点「新增规则」或「编辑为文本」开始写。',
      preview: '模型实际看到的内容',
      previewStale: '（有未保存修改，下面是上次保存的内容）',
      previewEmpty: '（当前没有启用任何规则，系统提示里不会出现这一段）',
      save: '保存',
      revert: '撤销修改',
      unsaved: '有未保存的修改',
      saved: '已保存，下一条回答就会带上新规则。',
      loading: '正在读取全局规则…',
      loadError: '无法读取全局规则。',
      saveError: '保存失败：',
      retry: '重试',
      store: '存储文件',
      limits: (maxRules, maxChars) => `每条最多 ${maxChars} 字，最多 ${maxRules} 条；改动立即生效，无需重启。`,
      toolHint: '在对话里让 Agent 改：global_rules 工具；或直接输入 /rules 查看。',
    }
    const en = {
      nav: 'Global rules',
      title: 'Global rules',
      intro: 'These rules are injected into every request\'s system prompt, and the agent must check each one before answering anything. This page, the global_rules tool, and the /rules command all edit the same data.',
      enable: 'Enable global rules',
      enableHint: 'When off, the rules stay stored but are no longer injected',
      acknowledge: 'Show the rule check in answers',
      acknowledgeHint: 'Asks the agent to end every answer with a "规则检查：已核对 N 条" line',
      rules: 'Rules',
      rulesCount: (on, total) => `${on} of ${total} enabled`,
      add: 'Add rule',
      bulkEdit: 'Edit as text',
      bulkHint: 'One rule per line; line numbers map to the list on the left, and disabled rows keep their state by position.',
      applyBulk: 'Apply to list',
      cancelBulk: 'Cancel',
      moveUp: 'Move up',
      moveDown: 'Move down',
      remove: 'Delete',
      enableRule: 'Enable this rule',
      rulePlaceholder: 'For example: never open an answer with filler like "Great question!".',
      empty: 'No rules yet. Use "Add rule" or "Edit as text" to write the first one.',
      preview: 'What the model actually receives',
      previewStale: '(unsaved changes — this is the last saved text)',
      previewEmpty: '(no enabled rule, so this block is absent from the system prompt)',
      save: 'Save',
      revert: 'Discard changes',
      unsaved: 'Unsaved changes',
      saved: 'Saved — the next answer already carries the new rules.',
      loading: 'Loading global rules…',
      loadError: 'Could not load the global rules.',
      saveError: 'Save failed: ',
      retry: 'Retry',
      store: 'Store file',
      limits: (maxRules, maxChars) => `Up to ${maxChars} characters per rule and ${maxRules} rules; changes apply immediately, no restart.`,
      toolHint: 'Ask the agent to change them with the global_rules tool, or type /rules to inspect them.',
    }

    /** The resolved locale rides <html lang>; a page without it uses the navigator. */
    function copy() {
      const lang = `${document.documentElement?.lang || ''}${navigator.language || ''}`
      return lang.toLowerCase().startsWith('zh') ? zh : en
    }

    function h(tag, props, ...children) {
      return React.createElement(tag, props, ...children)
    }

    function message(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** Local row identity; the Host remints duplicates, so uniqueness here is enough. */
    function newId() {
      return `r-${Math.random().toString(36).slice(2, 10)}`
    }

    async function request(path, options) {
      const response = await fetch(path, { cache: 'no-store', ...options })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        const error = new Error((body && body.error) || `request failed (${response.status})`)
        error.status = response.status
        throw error
      }
      return body
    }

    function Toggle(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: `dsh-gr-switch${props.checked ? ' is-on' : ''}`,
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        disabled: props.disabled,
        onClick: () => {
          if (!props.disabled) props.onChange(!props.checked)
        },
      })
    }

    function Row(props) {
      return h('section', { className: 'dsh-gr-card dsh-gr-row' },
        h('div', { className: 'dsh-gr-rowtext' },
          h('h3', null, props.title),
          props.hint ? h('p', null, props.hint) : null),
        props.children)
    }

    /** The editable shape; ids survive a save so the Host never reorders rows. */
    function draftFrom(snapshot) {
      return {
        enabled: snapshot.enabled !== false,
        acknowledge: snapshot.acknowledge === true,
        rules: (Array.isArray(snapshot.rules) ? snapshot.rules : []).map((rule) => ({
          id: rule.id,
          text: String(rule.text ?? ''),
          enabled: rule.enabled !== false,
        })),
      }
    }

    function sameDraft(a, b) {
      return JSON.stringify(a) === JSON.stringify(b)
    }

    function RulesSection() {
      const text = copy()
      // Re-render on a locale change so every copy() above re-reads <html lang>.
      const [, bumpLocale] = React.useState(0)
      React.useEffect(() => {
        if (typeof MutationObserver !== 'function' || !document.documentElement) return undefined
        const observer = new MutationObserver(() => bumpLocale((count) => count + 1))
        observer.observe(document.documentElement, { attributeFilter: ['lang'] })
        return () => observer.disconnect()
      }, [])

      const [remote, setRemote] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [status, setStatus] = React.useState('loading')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [mode, setMode] = React.useState('list')
      const [bulk, setBulk] = React.useState('')

      const dirty = !!draft && !!remote && !sameDraft(draft, draftFrom(remote))
      // A background reload must never clobber unsaved edits; the listener reads
      // this through a ref so it stays current without re-subscribing.
      const dirtyRef = React.useRef(false)
      dirtyRef.current = dirty

      const load = React.useCallback(async (force) => {
        try {
          const snapshot = await request(`${PREFIX}/state`)
          setRemote(snapshot)
          setStatus('ready')
          setError('')
          if (force || !dirtyRef.current) setDraft(draftFrom(snapshot))
        } catch (err) {
          setStatus((prev) => (prev === 'ready' ? prev : 'error'))
          setError(message(err))
        }
      }, [])

      React.useEffect(() => {
        void load(false)
        const onFocus = () => void load(false)
        window.addEventListener?.('focus', onFocus)
        return () => window.removeEventListener?.('focus', onFocus)
      }, [load])

      async function save() {
        if (!draft) return
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const snapshot = await request(`${PREFIX}/state`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              enabled: draft.enabled,
              acknowledge: draft.acknowledge,
              rules: draft.rules
                .map((rule) => ({ id: rule.id, text: rule.text.trim(), enabled: rule.enabled }))
                .filter((rule) => rule.text.length > 0),
            }),
          })
          setRemote(snapshot)
          setDraft(draftFrom(snapshot))
          setMode('list')
          setNotice(text.saved)
        } catch (err) {
          setError(`${text.saveError}${message(err)}`)
        } finally {
          setBusy(false)
        }
      }

      function editRules(change) {
        setNotice('')
        setDraft((prev) => (prev ? { ...prev, rules: change(prev.rules) } : prev))
      }

      function updateRule(index, patch) {
        editRules((rules) => rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)))
      }

      function moveRule(index, delta) {
        editRules((rules) => {
          const target = index + delta
          if (target < 0 || target >= rules.length) return rules
          const next = rules.slice()
          const [moved] = next.splice(index, 1)
          next.splice(target, 0, moved)
          return next
        })
      }

      function removeRule(index) {
        editRules((rules) => rules.filter((_rule, at) => at !== index))
      }

      function addRule() {
        editRules((rules) => [...rules, { id: newId(), text: '', enabled: true }])
        setMode('list')
      }

      function openBulk() {
        setBulk((draft ? draft.rules.map((rule) => rule.text) : []).join('\n'))
        setMode('text')
      }

      /** Line n maps to row n: edited text keeps that row's id and state. */
      function applyBulk() {
        const lines = bulk.split('\n')
        editRules(() => {
          const next = []
          lines.forEach((line, index) => {
            const body = line.trim()
            if (!body) return
            const previous = draft && draft.rules[index]
            next.push({
              id: previous ? previous.id : newId(),
              text: body,
              enabled: previous ? previous.enabled : true,
            })
          })
          return next
        })
        setMode('list')
      }

      const rules = draft ? draft.rules : []
      const enabledCount = rules.filter((rule) => rule.enabled && rule.text.trim()).length
      const preview = remote ? String(remote.preview || '') : ''
      const disabled = busy || !draft

      function ruleRow(rule, index) {
        const rows = Math.min(10, Math.max(2, rule.text.split('\n').length))
        return h('div', { className: `dsh-gr-rule${rule.enabled ? '' : ' is-off'}`, key: rule.id || String(index) },
          h('div', { className: 'dsh-gr-rulehead' },
            h(Toggle, {
              checked: rule.enabled,
              label: `${text.enableRule} #${index + 1}`,
              disabled,
              onChange: (enabled) => updateRule(index, { enabled }),
            }),
            h('span', { className: 'dsh-gr-rulenum' }, `#${index + 1}`),
            h('div', { className: 'dsh-gr-ruletools' },
              h('button', {
                type: 'button', className: 'dsh-gr-icon', title: text.moveUp, 'aria-label': `${text.moveUp} #${index + 1}`,
                disabled: disabled || index === 0, onClick: () => moveRule(index, -1),
              }, '↑'),
              h('button', {
                type: 'button', className: 'dsh-gr-icon', title: text.moveDown, 'aria-label': `${text.moveDown} #${index + 1}`,
                disabled: disabled || index === rules.length - 1, onClick: () => moveRule(index, 1),
              }, '↓'),
              h('button', {
                type: 'button', className: 'dsh-gr-icon dsh-gr-danger', title: text.remove, 'aria-label': `${text.remove} #${index + 1}`,
                disabled, onClick: () => removeRule(index),
              }, '✕'))),
          h('textarea', {
            className: 'dsh-gr-input',
            rows: String(rows),
            value: rule.text,
            placeholder: text.rulePlaceholder,
            disabled,
            spellCheck: false,
            onChange: (event) => updateRule(index, { text: event.target.value }),
          }))
      }

      return h('div', { className: 'dsh-gr-page' },
        h('h2', { className: 'dsh-gr-title' }, text.title),
        h('p', { className: 'dsh-gr-intro' }, text.intro),
        status === 'error' ? h('p', { className: 'dsh-gr-error', role: 'alert' }, `${text.loadError} ${error}`) : null,
        status === 'error'
          ? h('button', { type: 'button', className: 'dsh-gr-button', onClick: () => void load(true) }, text.retry)
          : null,
        error && status !== 'error' ? h('p', { className: 'dsh-gr-error', role: 'alert' }, error) : null,
        !draft
          ? h('p', { className: 'dsh-gr-intro' }, text.loading)
          : h('div', { className: 'dsh-gr-body' },
            h(Row, {
              title: text.enable,
              hint: text.enableHint,
            }, h(Toggle, {
              checked: draft.enabled,
              label: text.enable,
              disabled,
              onChange: (enabled) => {
                setNotice('')
                setDraft((prev) => (prev ? { ...prev, enabled } : prev))
              },
            })),
            h(Row, {
              title: text.acknowledge,
              hint: text.acknowledgeHint,
            }, h(Toggle, {
              checked: draft.acknowledge,
              label: text.acknowledge,
              disabled,
              onChange: (acknowledge) => {
                setNotice('')
                setDraft((prev) => (prev ? { ...prev, acknowledge } : prev))
              },
            })),
            h('section', { className: 'dsh-gr-card' },
              h('div', { className: 'dsh-gr-head' },
                h('div', { className: 'dsh-gr-rowtext' },
                  h('h3', null, text.rules),
                  h('p', null, text.rulesCount(enabledCount, rules.length))),
                h('div', { className: 'dsh-gr-actions' },
                  mode === 'list'
                    ? h('button', { type: 'button', className: 'dsh-gr-button', disabled, onClick: addRule }, text.add)
                    : null,
                  mode === 'list'
                    ? h('button', { type: 'button', className: 'dsh-gr-button dsh-gr-ghost', disabled, onClick: openBulk }, text.bulkEdit)
                    : null,
                  mode === 'text'
                    ? h('button', { type: 'button', className: 'dsh-gr-button', disabled, onClick: applyBulk }, text.applyBulk)
                    : null,
                  mode === 'text'
                    ? h('button', { type: 'button', className: 'dsh-gr-button dsh-gr-ghost', onClick: () => setMode('list') }, text.cancelBulk)
                    : null)),
              mode === 'text'
                ? h('div', { className: 'dsh-gr-bulk' },
                  h('p', { className: 'dsh-gr-hint' }, text.bulkHint),
                  h('textarea', {
                    className: 'dsh-gr-input dsh-gr-bulkinput',
                    rows: '14',
                    value: bulk,
                    disabled,
                    spellCheck: false,
                    onChange: (event) => setBulk(event.target.value),
                  }))
                : rules.length === 0
                  ? h('p', { className: 'dsh-gr-hint' }, text.empty)
                  : h('div', { className: 'dsh-gr-rules' }, rules.map(ruleRow))),
            h('div', { className: 'dsh-gr-footer' },
              h('button', {
                type: 'button',
                className: 'dsh-gr-button dsh-gr-primary',
                disabled: disabled || !dirty,
                onClick: () => void save(),
              }, text.save),
              h('button', {
                type: 'button',
                className: 'dsh-gr-button dsh-gr-ghost',
                disabled: disabled || !dirty,
                onClick: () => {
                  setNotice('')
                  setMode('list')
                  if (remote) setDraft(draftFrom(remote))
                },
              }, text.revert),
              dirty ? h('span', { className: 'dsh-gr-dirty' }, text.unsaved) : null,
              notice ? h('span', { className: 'dsh-gr-note', role: 'status' }, notice) : null),
            h('section', { className: 'dsh-gr-card' },
              h('h3', null, text.preview),
              dirty ? h('p', { className: 'dsh-gr-hint' }, text.previewStale) : null,
              preview
                ? h('pre', { className: 'dsh-gr-preview' }, preview)
                : h('p', { className: 'dsh-gr-hint' }, text.previewEmpty)),
            h('p', { className: 'dsh-gr-hint' },
              `${text.store}: ${remote ? remote.path : ''}`),
            h('p', { className: 'dsh-gr-hint' },
              `${text.limits(remote ? remote.limits.maxRules : 200, remote ? remote.limits.maxRuleChars : 2000)} ${text.toolHint}`)))
    }

    const STYLE_SHEET = `
.dsh-gr-page { display: flex; flex-direction: column; gap: 14px; max-width: 860px; color: inherit; }
.dsh-gr-title { margin: 0; font-size: 20px; }
.dsh-gr-intro, .dsh-gr-hint, .dsh-gr-page p { margin: 4px 0 0; color: color-mix(in srgb, currentColor 68%, transparent); font-size: 13px; line-height: 1.5; }
.dsh-gr-error { color: var(--dsw-alias-state-error-primary, #d33); }
.dsh-gr-note { color: var(--dsw-alias-state-success-primary, #1a7f37); font-size: 13px; }
.dsh-gr-dirty { color: var(--dsw-alias-state-warn-primary, #b26a00); font-size: 13px; }
.dsh-gr-body { display: flex; flex-direction: column; gap: 12px; }
.dsh-gr-card { border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 12px; padding: 14px 16px; }
.dsh-gr-card h3 { margin: 0; font-size: 14px; }
.dsh-gr-row, .dsh-gr-head { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
.dsh-gr-rowtext { min-width: 0; }
.dsh-gr-actions, .dsh-gr-footer { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dsh-gr-footer { margin-top: 2px; }
.dsh-gr-button { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); background: transparent; color: inherit; border-radius: 8px; padding: 6px 10px; font: inherit; font-size: 13px; cursor: pointer; }
.dsh-gr-button:disabled { opacity: .5; cursor: default; }
.dsh-gr-ghost { border-color: transparent; }
.dsh-gr-primary { border-color: transparent; background: var(--dsw-alias-brand-primary, #3964fe); color: #fff; }
.dsh-gr-switch { width: 40px; height: 24px; border-radius: 999px; border: 0; background: color-mix(in srgb, currentColor 18%, transparent); position: relative; flex: none; cursor: pointer; }
.dsh-gr-switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .2); transition: transform 120ms ease; }
.dsh-gr-switch.is-on { background: var(--dsw-alias-brand-primary, #3964fe); }
.dsh-gr-switch.is-on::after { transform: translateX(16px); }
.dsh-gr-switch:disabled { opacity: .5; cursor: default; }
.dsh-gr-rules { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.dsh-gr-rule { border: 1px solid color-mix(in srgb, currentColor 12%, transparent); border-radius: 10px; padding: 8px 10px; background: color-mix(in srgb, currentColor 3%, transparent); }
.dsh-gr-rule.is-off { opacity: .62; }
.dsh-gr-rulehead { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.dsh-gr-rulenum { font-size: 12px; color: color-mix(in srgb, currentColor 55%, transparent); }
.dsh-gr-ruletools { margin-left: auto; display: flex; gap: 4px; }
.dsh-gr-icon { border: 1px solid transparent; background: transparent; color: inherit; border-radius: 6px; width: 26px; height: 24px; font: inherit; font-size: 12px; line-height: 1; cursor: pointer; }
.dsh-gr-icon:hover:not(:disabled) { border-color: color-mix(in srgb, currentColor 20%, transparent); }
.dsh-gr-icon:disabled { opacity: .35; cursor: default; }
.dsh-gr-danger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary, #d33); }
.dsh-gr-input { width: 100%; box-sizing: border-box; border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 13px; line-height: 1.5; padding: 7px 9px; resize: vertical; }
.dsh-gr-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #3964fe); }
.dsh-gr-bulkinput { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dsh-gr-bulk { margin-top: 12px; }
.dsh-gr-preview { margin: 10px 0 0; padding: 12px; border-radius: 10px; border: 1px solid color-mix(in srgb, currentColor 14%, transparent); background: color-mix(in srgb, currentColor 5%, transparent); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; }
`

    /** The sheet is page-owned: inserted once, removed when the plugin unloads. */
    function ensurePageStyle() {
      if (document.getElementById(PAGE_STYLE_ID)) return null
      const node = document.createElement('style')
      node.id = PAGE_STYLE_ID
      node.textContent = STYLE_SHEET
      document.head.append(node)
      return node
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(() => {
        const node = ensurePageStyle()
        return () => {
          if (node && node.isConnected) node.remove()
        }
      })

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'global-rules',
        order: 55,
        label: () => copy().nav,
        inject: () => ({}),
      }, RulesSection))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
