/**
 * dsh-chat-rewrite — browser half.
 *
 * Two contributions:
 *
 *   1. `conversation.chat.assistant-actions` — a red trash control on every
 *      finalized assistant message. It resolves which human round that answer
 *      belongs to and opens the rewrite panel already confirming it.
 *   2. `shell.overlay` — the root-scoped rewrite panel. It survives the
 *      session tab: when the Host still owns the session it waits for the tab
 *      to close, then finishes the rewrite.
 *
 * All rewriting happens in the Host half; this half only renders and fetches.
 * No build step: this file is the shipped artifact, matching the module
 * protocol DSH consumes (`window.__ModuleLoader__.load({ id, factory })`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-chat-rewrite',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    // Shell-seeded primitives give the action the same tooltip and glyph as the
    // shipped row controls; a missing table entry degrades to a local glyph.
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }
    const Tooltip = primitives?.Tooltip
    const TrashIcon = primitives?.IconTrashOutlineRegular

    /** Locale namespace owned by this plugin. */
    const NS = 'chatRewrite'
    /** Prefix of the Host half's JSON surface. */
    const API = '/chat-rewrite/api'
    const STYLE_ID = 'dsh-chat-rewrite-actions'

    /**
     * Install the action-row styling once. The row's own CSS module belongs to
     * another package, so this reproduces its geometry with theme tokens and
     * adds the red affordance this destructive action needs.
     *
     * The stylesheet goes through the client `styles` builtin when the shell
     * exposes it, so it is torn down with this client run; the `<style>` element
     * is only the fallback for a shell without that builtin.
     * @param {object} ctx - Client context.
     */
    function ensureStyles(ctx) {
      const css = [
        '.dsh-cr-action{display:inline-flex;align-items:center;justify-content:center;',
        'width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;',
        'color:var(--dsw-alias-state-error-primary);opacity:.62;cursor:pointer;',
        'transition:opacity .12s ease,background-color .12s ease}',
        '.dsh-cr-action:hover,.dsh-cr-action:focus-visible{opacity:1;',
        'background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)}',
        '.dsh-cr-action:disabled{opacity:.3;cursor:default;background:transparent}',
        '.dsh-cr-action svg{width:16px;height:16px;display:block}',
      ].join('')
      const sheet = ctx?.get?.('styles')
      if (sheet !== null && sheet !== undefined && typeof sheet.insert === 'function') {
        ctx.effect(() => sheet.insert(css), 'chat-rewrite: action styles')
        return
      }
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = css
      document.head.appendChild(style)
    }

    const zh = {
      'action.delete': '删除这条回答及其之后',
      'queue.done': '该会话正被 DSH 占用，改写已排队：重启桌面版后会自动生效（届时会在任何会话打开之前执行）。',
      'queue.uncaptured': '这个会话是在插件加载之前就打开的，本进程内拿不到它的释放能力：已排队，重启桌面版后自动完成；重启后新打开的会话就能当场删。',
      'queue.badge': '已排队，重启后生效',
      'panel.title': '会话改写',
      'panel.loading': '正在读取会话…',
      'panel.empty': '这个会话里没有可回退的真人轮次。',
      'panel.scope': '真改写磁盘上的会话日志 · 不是界面隐藏',
      'panel.live': '该会话已在本进程打开：改写时会先释放它、再自动重新载入，所以是**当场生效**的。',
      'panel.unsupported': '该会话是历史格式 v{version}，暂不支持（先在 DSH 里打开一次让它升级到 v4）。',
      'panel.notFound': '找不到该会话的日志文件。',
      'panel.backups': '备份',
      'panel.backupNow': '备份当前状态',
      'panel.noBackups': '还没有备份。备份需要你手动点「备份当前状态」。',
      'panel.backupHint': '备份是手动的：改写不会自动备份，也不会自动删除你建的备份。',
      'panel.restore': '还原',
      'panel.deleteBackup': '删除',
      'panel.purgeAll': '清空备份',
      'backup.deleteTitle': '删除备份',
      'backup.deleteHint': '删除 {stamp} 这份备份。删掉后无法再用它还原。',
      'backup.purgeHint': '删除这个会话的全部备份。删掉后无法用它还原任何一次改写。',
      'backup.confirm': '确认删除',
      'result.backupCreated': '已备份（{stamp}）。',
      'result.backupDeleted': '备份 {stamp} 已删除。',
      'result.backupsPurged': '已清空 {count} 份备份。',
      'panel.afterApply': '改完了。重新打开该会话即可看到新的历史。',
      'row.answered': '有回答',
      'row.unanswered': '无回答',
      'row.last': '最后一轮',
      'row.reanswer': '重答这条',
      'row.rewind': '回到这条之前',
      'row.reanswerInherited': '重答这条（会把分叉点移到这里，继承的历史变短）',
      'row.rewindInherited': '回到这条之前（会把分叉点移到这里，继承的历史变短）',
      'row.first': '第一轮，无可回退的历史',
      'row.inherited': '继承自父会话（分叉前的历史），不能删',
      'row.inheritedBadge': '继承',
      'row.inherited': '继承自父会话（分叉前的历史），不能删',
      'row.inheritedBadge': '继承',
      'confirm.title': '确认改写',
      'confirm.before': '将删除第 {turn} 轮及其之后的全部内容（约 {dropped} 轮）。',
      'confirm.after': '将保留第 {turn} 轮的提问，删除它之后的所有回答与工具调用。',
      'confirm.note': '不会自动备份。想留后路就先点「备份当前状态」。',
      'confirm.live': '该会话已打开：确认后会先释放它、改写文件，然后自动重新载入界面。',
      'confirm.yes': '确认改写',
      'confirm.no': '取消',
      'result.before': '已回到第 {round} 轮之前（{events} 条事件）。重新打开该会话即可看到。',
      'result.after': '已删除第 {turn} 轮之后的回答（{events} 条事件）。重新打开该会话即可看到。',
      'result.restored': '已还原备份 {stamp}。',
      'error.SESSION_BUSY': '这条回复还在生成中，等它结束后再删。',
      'error.SESSION_IS_LIVE': '该会话正被 DSH 占用，暂时无法当场释放。',
      'error.SESSION_NOT_FOUND': '找不到该会话的日志文件。',
      'error.UNSUPPORTED_GENERATION': '该会话是历史格式，暂不支持。',
      'error.ANCHOR_NOT_FOUND': '这一轮已经不在日志里了，请刷新。',
      'error.NOT_REWINDABLE': '第一轮没有可回退的历史。',
      'error.NOTHING_TO_DROP': '这一轮之后没有可删除的内容。',
      'error.BUILD_FAILED': '生成截断日志失败，原件未改动。',
      'error.DECODE_FAILED': '日志解码失败，原件未改动。',
      'error.default': '操作失败：{code}',
      'common.close': '关闭',
      'common.refresh': '刷新',
    }

    const en = {
      'action.delete': 'Delete this answer and everything after',
      'queue.done': 'This session is held by DSH, so the rewrite is queued: restart the desktop app and it applies automatically, before any session opens.',
      'queue.uncaptured': 'This session was opened before the plugin loaded, so its release capability is not available in this process: queued for the next start. Sessions opened after a restart delete instantly.',
      'queue.badge': 'Queued · applies after restart',
      'panel.title': 'Conversation rewrite',
      'panel.loading': 'Reading the session…',
      'panel.empty': 'This session has no human round to rewind to.',
      'panel.scope': 'Rewrites the stored log on disk · not a UI overlay',
      'panel.live': 'This session is open in this process: the rewrite releases it first and then reloads it automatically, so it applies on the spot.',
      'panel.unsupported': 'This session uses historical format v{version}; open it once so DSH upgrades it to v4 first.',
      'panel.notFound': 'No stored log for this session.',
      'panel.backups': 'Backups',
      'panel.backupNow': 'Back up now',
      'panel.noBackups': 'No backups yet. Backups are created only when you press "Back up now".',
      'panel.backupHint': 'Backups are manual: rewrites never create one, and never delete yours.',
      'panel.restore': 'Restore',
      'panel.deleteBackup': 'Delete',
      'panel.purgeAll': 'Clear backups',
      'backup.deleteTitle': 'Delete backup',
      'backup.deleteHint': 'Delete backup {stamp}. It can no longer be restored afterwards.',
      'backup.purgeHint': 'Delete every backup of this session. No rewrite can be restored afterwards.',
      'backup.confirm': 'Delete',
      'result.backupCreated': 'Backed up ({stamp}).',
      'result.backupDeleted': 'Backup {stamp} deleted.',
      'result.backupsPurged': 'Cleared {count} backups.',
      'panel.afterApply': 'Done. Reopen the session to see the new history.',
      'row.answered': 'answered',
      'row.unanswered': 'no answer',
      'row.last': 'last round',
      'row.reanswer': 'Re-answer this',
      'row.rewind': 'Rewind to before this',
      'row.reanswerInherited': 'Re-answer this (moves the fork point here, inheriting less)',
      'row.rewindInherited': 'Rewind to before this (moves the fork point here, inheriting less)',
      'row.first': 'First round: nothing earlier to return to',
      'row.inherited': 'Inherited from the parent session (pre-fork history); cannot be deleted',
      'row.inheritedBadge': 'inherited',
      'row.inherited': 'Inherited from the parent session (pre-fork history); cannot be deleted',
      'row.inheritedBadge': 'inherited',
      'confirm.title': 'Confirm rewrite',
      'confirm.before': 'Deletes round {turn} and everything after it (about {dropped} rounds).',
      'confirm.after': 'Keeps the prompt of round {turn} and deletes every answer and tool call after it.',
      'confirm.note': 'No automatic backup. Press "Back up now" first if you want a way back.',
      'confirm.live': 'This session is open: confirming releases it, rewrites the file and reloads the view automatically.',
      'confirm.yes': 'Rewrite',
      'confirm.no': 'Cancel',
      'result.before': 'Rewound to before round {round} ({events} events). Reopen the session to see it.',
      'result.after': 'Dropped the answers after round {turn} ({events} events). Reopen the session to see it.',
      'result.restored': 'Restored backup {stamp}.',
      'error.SESSION_BUSY': 'That reply is still generating; delete it once it finishes.',
      'error.SESSION_IS_LIVE': 'The session is held by DSH and cannot be released right now.',
      'error.SESSION_NOT_FOUND': 'No stored log for this session.',
      'error.UNSUPPORTED_GENERATION': 'Historical session format is unsupported.',
      'error.ANCHOR_NOT_FOUND': 'That round is no longer in the log; refresh.',
      'error.NOT_REWINDABLE': 'The first round has nothing earlier to return to.',
      'error.NOTHING_TO_DROP': 'Nothing after that round to delete.',
      'error.BUILD_FAILED': 'Could not build the truncated log; the original is untouched.',
      'error.DECODE_FAILED': 'The log could not be decoded; the original is untouched.',
      'error.default': 'Failed: {code}',
      'common.close': 'Close',
      'common.refresh': 'Refresh',
    }

    /** Replace `{name}` placeholders. */
    function fill(template, params) {
      if (params === undefined) return String(template)
      return String(template).replace(/\{(\w+)\}/gu, (whole, name) => (
        params[name] === undefined ? whole : String(params[name])
      ))
    }

    /** Fallback when the slot renderer supplies no `t`. */
    function fallbackT(key, params) {
      return fill(zh[key] ?? en[key] ?? key, params)
    }

    /** Format a byte count for the panel subtitle. */
    function bytesText(bytes) {
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    }

    /**
     * Minimal observable source for the shared "which session is being edited"
     * fact. The renderer binds it as a `use<Name>` hook from the inject face.
     */
    function createTargetStore() {
      let value = null
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        open: (payload) => {
          value = payload
          for (const listener of listeners) listener()
        },
        close: () => {
          value = null
          for (const listener of listeners) listener()
        },
      }
    }

    /** Call the Host half and normalise failures into `{ ok, data }`. */
    async function call(path, init) {
      let response
      try {
        response = await fetch(`${API}${path}`, init)
      } catch (error) {
        return { ok: false, data: { error: 'NETWORK', detail: String(error?.message ?? error) } }
      }
      let data
      try {
        data = await response.json()
      } catch {
        data = { error: 'BAD_RESPONSE' }
      }
      return { ok: response.ok, data }
    }

    /**
     * Panel styling, calibrated by sampling the running app's pixels:
     *
     *   --dsw-alias-bg-base     #151517  application background
     *   --dsw-alias-bg-layer-1  #232324
     *   --dsw-alias-bg-layer-2  #2c2c2e  input box and user message card
     *   --dsw-alias-bg-layer-3  #353638  chips and raised controls
     *
     * The dialog therefore takes the application background (`bg-base`, the
     * darkest tone), nested cards use the same surface DSH gives its input box
     * and message cards (`layer-2`), and buttons sit one step above that
     * (`layer-3`) so a control never reads as part of the panel.
     */
    const styles = {
      overlay: {
        position: 'fixed', inset: 0, zIndex: 2147483000, background: 'var(--dsw-alias-bg-mask-1)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      },
      panel: {
        width: 'min(760px, 100%)', maxHeight: 'min(82vh, 760px)', display: 'flex', flexDirection: 'column',
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        borderRadius: 'var(--dsw-radius-panel, 28px)', boxShadow: 'var(--dsw-elevation-prominent)',
        overflow: 'hidden', border: 'none', fontSize: 13,
      },
      header: {
        display: 'flex', alignItems: 'baseline', gap: 10, padding: '14px 18px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      subtle: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      body: { padding: '10px 18px', overflow: 'auto', flex: 1, minHeight: 0 },
      banner: {
        margin: '0 0 10px', padding: '8px 10px', borderRadius: 'var(--dsw-radius-sm, 8px)', fontSize: 12, lineHeight: 1.5,
        background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent)',
      },
      item: {
        display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      badge: {
        display: 'inline-block', padding: '1px 6px', borderRadius: 4, fontSize: 11,
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap',
      },
      preview: { flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 },
      smallButton: {
        height: 24, padding: '0 8px', border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm, 8px)',
        background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)',
        font: 'inherit', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
      },
      primary: {
        height: 28, padding: '0 12px', border: 'none', borderRadius: 'var(--dsw-radius-sm, 8px)',
        // Same fill the shipped dialogs use for their primary action; the label
        // follows the theme through bg-base (light text on dark accents and the
        // other way round), so it stays readable in both themes.
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-bg-base)',
        font: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer',
      },
      footer: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px 14px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      spacer: { flex: 1 },
      confirm: {
        margin: '10px 0 0', padding: 10, fontSize: 12, lineHeight: 1.6,
        background: 'var(--dsw-alias-bg-layer-2)', border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md, 10px)',
      },
      ok: { color: 'var(--dsw-alias-state-success-primary)' },
      bad: { color: 'var(--dsw-alias-state-error-primary)' },
      link: {
        background: 'transparent', border: 0, color: 'var(--dsw-alias-brand-primary)', cursor: 'pointer',
        font: 'inherit', fontSize: 12, padding: 0,
      },
      list: { listStyle: 'none', margin: 0, padding: 0 },
      /** Translucent success/error fill for result notices. */
      noticeOk: {
        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent)',
      },
      noticeBad: {
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)',
      },
    }

    /** Local glyph used when the shell does not seed the icon table. */
    function FallbackTrashIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M3 4.5h10' }),
      h('path', { d: 'M6.5 4.5V3h3v1.5' }),
      h('path', { d: 'M4.5 4.5l.55 8.2a1 1 0 0 0 1 .8h4.9a1 1 0 0 0 1-.8l.55-8.2' }),
      h('path', { d: 'M6.6 6.8v4.2M9.4 6.8v4.2' }))
    }

    /**
     * Per-message delete action: resolves which human round this answer belongs
     * to, then opens the rewrite panel already confirming that round.
     * @param {object} props - slot props: `sessionId`, `messageId`, open callback, `t`.
     * @returns {object} the delete control.
     */
    function AssistantDeleteAction(props) {
      const { sessionId, messageId, open } = props
      const t = typeof props.t === 'function' ? props.t : fallbackT
      const [busy, setBusy] = React.useState(false)
      const label = t('action.delete')
      const button = h('button', {
        type: 'button',
        className: 'dsh-cr-action',
        'aria-label': label,
        'aria-busy': busy || undefined,
        disabled: busy,
        onClick: () => {
          if (busy) return
          setBusy(true)
          void (async () => {
            const result = await call(
              `/rewrite-resolve?sessionId=${encodeURIComponent(String(sessionId))}`
              + `&messageId=${encodeURIComponent(String(messageId))}`,
            )
            setBusy(false)
            if (result.ok && result.data?.anchor !== undefined) {
              open({ sessionId, pending: { anchor: result.data.anchor, mode: 'after' } })
              return
            }
            open({
              sessionId,
              notice: result.data?.error === 'ROUND_NOT_FOUND' ? 'ROUND_NOT_FOUND' : 'INTERNAL',
            })
          })()
        },
      }, TrashIcon === undefined ? h(FallbackTrashIcon) : h(TrashIcon))
      return Tooltip === undefined
        ? button
        : h(Tooltip, { label, side: 'bottom' }, button)
    }

    /**
     * Root-scoped rewrite panel. Renders nothing until a session is targeted.
     * @param {object} props - slot props plus the shared target hook and close callback.
     * @returns {object|null} the panel element, or null.
     */
    function RewritePanel(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT
      const { useRewriteTarget, close, reload } = props
      const target = useRewriteTarget((value) => value)
      const sessionId = target?.sessionId

      const [state, setState] = React.useState({ status: 'idle' })
      const [pending, setPending] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [backups, setBackups] = React.useState([])
      const [showBackups, setShowBackups] = React.useState(false)
      const [confirmBackup, setConfirmBackup] = React.useState(null)
      const [generation, setGeneration] = React.useState(0)

      React.useEffect(() => {
        if (sessionId === undefined) return undefined
        let alive = true
        setState({ status: 'loading' })
        setPending(null)
        setNotice(null)
        void (async () => {
          const result = await call(`/rewrite-inspect?sessionId=${encodeURIComponent(String(sessionId))}`)
          if (!alive) return
          setState({ status: 'ready', data: result.data, ok: result.ok })
          const list = await call(`/rewrite-backups?sessionId=${encodeURIComponent(String(sessionId))}`)
          if (!alive) return
          setBackups(Array.isArray(list.data?.backups) ? list.data.backups : [])
        })()
        return () => { alive = false }
      }, [sessionId, generation])

      const data = state.status === 'ready' ? state.data : undefined
      const anchors = Array.isArray(data?.anchors) ? data.anchors : []
      const live = data?.live === true
      // A live session is not a blocker: the edit is queued for the next
      // application start, so the buttons must stay enabled.
      const blocked = !state.ok || data?.error !== undefined
      const [queued, setQueued] = React.useState(false)
      const refresh = () => { setGeneration((value) => value + 1) }

      // A delete button on one message targets that round directly: open into
      // its confirmation instead of making the user find it in the list again.
      const wanted = target?.pending
      const wantedRef = React.useRef(null)
      React.useEffect(() => {
        if (wanted === undefined || wanted === null) return
        if (wantedRef.current === wanted) return
        wantedRef.current = wanted
        setQueued(false)
        setNotice(null)
        setPending({ anchor: wanted.anchor, mode: wanted.mode ?? 'after', dropped: 1 })
      }, [wanted])

      React.useEffect(() => {
        const code = target?.notice
        if (typeof code !== 'string') return
        setNotice({ ok: false, text: t(`error.${code}`, { code }) })
      }, [target?.notice, t])

      const applyPending = React.useCallback(async (item) => {
        setNotice(null)
        const result = await call('/rewrite-apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            promptSeq: item.anchor.promptSeq,
            mode: item.mode,
            confirm: true,
          }),
        })
        if (result.ok) {
          setPending(null)
          setQueued(false)
          // Both paths invalidate the displayed history: a released agent is
          // gone, and an evicted cached view is stale. Either way the transcript
          // must be re-read from the rewritten file.
          const invalidated = result.data?.released === true || result.data?.evicted === true
          setNotice({
            ok: true,
            text: item.mode === 'before'
              ? fill(t('result.before'), { round: item.anchor.turn, events: result.data.eventsAfter })
              : fill(t('result.after'), { turn: item.anchor.turn, events: result.data.eventsAfter }),
          })
          if (invalidated && typeof reload === 'function') {
            try { reload(sessionId) } catch { /* the notice still tells the user to reopen */ }
          }
          refresh()
          return
        }
        if (result.data?.error === 'SESSION_BUSY') {
          setPending(null)
          setQueued(false)
          setNotice({ ok: false, text: t('error.SESSION_BUSY') })
          refresh()
          return
        }
        if (result.data?.error === 'SESSION_IS_LIVE' || result.data?.error === 'SESSION_UNCAPTURED') {
          // A session the Host owns but whose agent predates the interception
          // cannot be released in place; queue it for the next start, where the
          // queue drains before any session opens.
          const queuedResult = await call('/rewrite-queue', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, turn: item.anchor.turn, mode: item.mode }),
          })
          setPending(null)
          if (queuedResult.ok) {
            setQueued(true)
            setNotice({
              ok: true,
              text: result.data.error === 'SESSION_UNCAPTURED' ? t('queue.uncaptured') : t('queue.done'),
            })
          } else {
            const code = queuedResult.data?.error ?? 'INTERNAL'
            setNotice({ ok: false, text: t(`error.${code}`, { code }) })
          }
          refresh()
          return
        }
        setPending(null)
        setQueued(false)
        const code = result.data?.error ?? 'INTERNAL'
        setNotice({ ok: false, text: t(`error.${code}`, { code }) })
        refresh()
      }, [sessionId, t])

      const restore = async (stamp) => {
        setNotice(null)
        const result = await call('/rewrite-restore', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, stamp, confirm: true }),
        })
        if (result.ok) setNotice({ ok: true, text: fill(t('result.restored'), { stamp }) })
        else {
          const code = result.data?.error ?? 'INTERNAL'
          setNotice({ ok: false, text: t(`error.${code}`, { code }) })
        }
        refresh()
      }

      /** Take a manual backup of the current log. */
      const createBackupNow = async () => {
        setNotice(null)
        const result = await call('/rewrite-backup-create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        if (result.ok) {
          setShowBackups(true)
          setNotice({ ok: true, text: fill(t('result.backupCreated'), { stamp: result.data.stamp }) })
        } else {
          const code = result.data?.error ?? 'INTERNAL'
          setNotice({ ok: false, text: t(`error.${code}`, { code }) })
        }
        refresh()
      }

      /** Remove one backup, or every backup of this session. */
      const deleteBackups = async (target) => {
        setNotice(null)
        const purge = target.kind === 'purge'
        const result = await call(purge ? '/rewrite-backup-purge' : '/rewrite-backup-delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(purge
            ? { sessionId, confirm: true }
            : { sessionId, stamp: target.stamp, confirm: true }),
        })
        setConfirmBackup(null)
        if (result.ok) {
          setNotice({
            ok: true,
            text: purge
              ? fill(t('result.backupsPurged'), { count: result.data.removed ?? 0 })
              : fill(t('result.backupDeleted'), { stamp: target.stamp }),
          })
        } else {
          const code = result.data?.error ?? 'INTERNAL'
          setNotice({ ok: false, text: t(`error.${code}`, { code }) })
        }
        refresh()
      }

      const rows = anchors.slice().reverse().map((anchor, index) => h('li', {
        key: `${anchor.turn}-${anchor.promptSeq}`,
        style: styles.item,
      },
        h('span', { style: { ...styles.badge, minWidth: 44, textAlign: 'center' } }, `#${anchor.turn}`),
        h('div', { style: styles.preview },
          h('div', null, anchor.preview.length > 0 ? anchor.preview : '—'),
          h('div', { style: { ...styles.subtle, marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' } },
            h('span', { style: styles.badge }, anchor.answered ? t('row.answered') : t('row.unanswered')),
            anchor.lastTurn ? h('span', { style: styles.badge }, t('row.last')) : null,
          ),
        ),
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('button', {
            type: 'button',
            style: styles.smallButton,
            disabled: blocked || !anchor.answered || anchor.deletable === false,
            title: anchor.deletable === false
              ? t('row.inherited')
              : anchor.answered ? t('row.reanswer') : t('row.unanswered'),
            onClick: () => { setNotice(null); setPending({ anchor, mode: 'after', dropped: index + 1 }) },
          }, t('row.reanswer')),
          h('button', {
            type: 'button',
            style: styles.smallButton,
            disabled: blocked || !anchor.rewindable,
            title: anchor.rewindable ? t('row.rewind') : t('row.first'),
            onClick: () => { setNotice(null); setPending({ anchor, mode: 'before', dropped: index + 1 }) },
          }, t('row.rewind')),
        ),
      ))

      const confirmBox = pending === null ? null : h('div', { style: styles.confirm },
        h('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('confirm.title')),
        h('div', null, pending.mode === 'before'
          ? fill(t('confirm.before'), { turn: pending.anchor.turn, dropped: pending.dropped })
          : fill(t('confirm.after'), { turn: pending.anchor.turn })),
        h('div', { style: { ...styles.subtle, marginTop: 4 } }, t('confirm.note')),
        live ? h('div', { style: { ...styles.subtle, marginTop: 4 } }, t('confirm.live')) : null,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
          h('button', {
            type: 'button',
            style: styles.primary,
            onClick: () => { void applyPending(pending) },
          }, t('confirm.yes')),
          h('button', { type: 'button', style: styles.smallButton, onClick: () => { setPending(null) } }, t('confirm.no')),
        ),
      )

      const queuedBox = !queued ? null : h('div', {
        style: { ...styles.banner, ...styles.noticeOk },
      }, h('strong', null, `${t('queue.badge')} `), t('queue.done'))

        const backupList = showBackups
        ? (backups.length === 0
            ? h('div', { style: { ...styles.subtle, marginTop: 8 } }, t('panel.noBackups'))
            : h('div', { style: { marginTop: 8 } },
                h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 4 } },
                  h('button', {
                    type: 'button', style: styles.link, disabled: blocked,
                    onClick: () => { setConfirmBackup({ kind: 'purge' }) },
                  }, t('panel.purgeAll')),
                ),
                h('ul', { style: { ...styles.list, maxHeight: 160, overflow: 'auto' } },
                  backups.map((backup) => h('li', {
                    key: backup.stamp,
                    style: { display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0', fontSize: 12 },
                  },
                    h('span', { style: { flex: 1, fontFamily: 'ui-monospace, monospace' } }, backup.stamp),
                    h('span', { style: styles.subtle },
                      backup.mode === 'before' ? 'rewind' : backup.mode === 'after' ? 're-answer' : ''),
                    h('span', { style: styles.subtle }, backup.bytes === undefined ? '' : bytesText(backup.bytes)),
                    h('button', {
                      type: 'button', style: styles.link, disabled: blocked,
                      onClick: () => { void restore(backup.stamp) },
                    }, t('panel.restore')),
                    h('button', {
                      type: 'button',
                      style: { ...styles.link, color: 'var(--dsw-alias-state-error-primary)' },
                      disabled: blocked,
                      onClick: () => { setConfirmBackup({ kind: 'one', stamp: backup.stamp }) },
                    }, t('panel.deleteBackup')),
                  ))),
              ))
        : null

      const backupConfirmBox = confirmBackup === null ? null : h('div', { style: styles.confirm },
        h('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('backup.deleteTitle')),
        h('div', null, confirmBackup.kind === 'purge'
          ? t('backup.purgeHint')
          : fill(t('backup.deleteHint'), { stamp: confirmBackup.stamp })),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
          h('button', {
            type: 'button',
            style: styles.primary,
            onClick: () => { void deleteBackups(confirmBackup) },
          }, t('backup.confirm')),
          h('button', { type: 'button', style: styles.smallButton, onClick: () => { setConfirmBackup(null) } }, t('confirm.no')),
        ),
      )

      if (sessionId === undefined) return null

      return h('div', {
        style: styles.overlay,
        onMouseDown: (event) => { if (event.target === event.currentTarget) close() },
      },
      h('div', { style: styles.panel, role: 'dialog', 'aria-label': t('panel.title') },
        h('div', { style: styles.header },
          h('h2', { style: styles.title }, t('panel.title')),
          h('span', { style: styles.subtle },
            data === undefined
              ? t('panel.loading')
              : `${data.title ?? sessionId} · ${data.events ?? '?'} 事件 · ${data.turns ?? '?'} 轮 · ${bytesText(data.bytes ?? 0)}`),
          h('span', { style: styles.spacer }),
          h('button', { type: 'button', style: styles.smallButton, onClick: refresh }, t('common.refresh')),
          h('button', { type: 'button', style: styles.smallButton, onClick: () => { close() } }, t('common.close')),
        ),
        h('div', { style: styles.body },
          state.status === 'loading' ? h('div', { style: styles.subtle }, t('panel.loading')) : null,
          live ? h('div', { style: styles.banner }, t('panel.live')) : null,
          data?.error === 'UNSUPPORTED_GENERATION'
            ? h('div', { style: styles.banner }, fill(t('panel.unsupported'), { version: data.version })) : null,
          data?.error === 'SESSION_NOT_FOUND'
            ? h('div', { style: styles.banner }, t('panel.notFound')) : null,
          notice === null ? null : h('div', {
            style: { ...styles.banner, ...(notice.ok ? styles.noticeOk : styles.noticeBad) },
          }, h('span', { style: notice.ok ? styles.ok : styles.bad }, notice.text)),
          pending === null && notice !== null && notice.ok
            ? h('div', { style: { ...styles.subtle, marginTop: 6 } }, t('panel.afterApply')) : null,
          queuedBox,
          confirmBox,
          anchors.length === 0 && data !== undefined && data.error === undefined
            ? h('div', { style: { ...styles.subtle, marginTop: 10 } }, t('panel.empty')) : null,
          anchors.length === 0 ? null : h('ul', { style: { ...styles.list, marginTop: 10 } }, rows),
          h('div', { style: { marginTop: 12 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              h('button', {
                type: 'button', style: styles.link,
                onClick: () => { setShowBackups((value) => !value) },
              }, `${t('panel.backups')} (${backups.length})`),
              h('button', {
                type: 'button',
                style: styles.smallButton,
                disabled: blocked,
                onClick: () => { void createBackupNow() },
              }, t('panel.backupNow')),
            ),
            h('div', { style: { ...styles.subtle, marginTop: 4 } }, t('panel.backupHint')),
            backupList,
            backupConfirmBox,
          ),
        ),
        h('div', { style: styles.footer }, h('span', { style: styles.subtle }, t('panel.scope'))),
      ))
    }

    const inject = ['slots', 'locale']

    /**
     * Register dictionaries, the per-message delete action and the root overlay.
     * @param {object} ctx - browser context carrying slots and locale.
     */
    function apply(ctx) {
      const target = createTargetStore()
      ensureStyles(ctx)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'chat-rewrite: dictionaries')
      /**
       * Reopen one session's history on the client so a released-and-rewritten
       * session shows the new transcript without a page reload.
       * @param {string} sessionId - Session whose history to reopen.
       */
      const reload = (sessionId) => {
        try {
          const sessions = ctx.get('sessions')
          const session = sessions?.binding?.(sessionId)?.session
          if (typeof session?.resync === 'function') void session.resync()
        } catch {
          // The result notice already tells the user to reopen the session.
        }
      }
      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'chat-rewrite-delete',
        order: 100,
        locale: NS,
        inject: () => ({ open: (payload) => { target.open(payload) } }),
      }, AssistantDeleteAction))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'chat-rewrite-panel',
        locale: NS,
        inject: () => ({
          hooks: { rewriteTarget: target },
          close: () => { target.close() },
          reload,
        }),
      }, RewritePanel))
    }

    exports.AssistantDeleteAction = AssistantDeleteAction
    exports.RewritePanel = RewritePanel
    exports.apply = apply
    exports.inject = inject
    exports.name = 'chat-rewrite'
    return module.exports
  },
})
