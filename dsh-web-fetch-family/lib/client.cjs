/**
 * dsh-web-fetch-family — browser half.
 *
 * Registers this bundle's page into the plugin manager's `plugins.bundle.config`
 * slot. That slot is keyed by the **npm package name**: the page renders it as
 * `renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })`
 * and only shows the section at all once a registration with that key exists
 * (`configured: ledger.bundles.has(openPkg.name)`). A key that is a Loader row id
 * instead of the package name renders nothing at all, without an error.
 *
 * No build step and no JSX: the file is served verbatim as a module factory, so
 * it is plain CommonJS over the platform React.
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-fetch-family',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    /** Same literal as the Host half's API_PREFIX. */
    const API = '/web-fetch-family/api'
    const LOCALE_NAMESPACE = 'settings.webFetchFamily'

    /** Simplified Chinese dictionary, and the key source of truth. */
    const zh = {
      title: '域名族规则',
      ipv4Only: '只使用 IPv4 的域名',
      ipv4OnlyHint: '每行一个域名。命中的域名只解析 IPv4 地址。',
      ipv4OnlyPlaceholder: 'example.com\n*.example.net',
      ipv6Only: '只使用 IPv6 的域名',
      ipv6OnlyHint: '每行一个域名。命中的域名只解析 IPv6 地址。',
      ipv6OnlyPlaceholder: 'example.org',
      both: '两张表',
      loading: '正在读取配置…',
      failedLoad: '读取配置失败。',
      retry: '重试',
      unsaved: '未保存',
      saved: '已保存',
      saving: '正在保存…',
      save: '保存',
      discard: '放弃修改',
      pathLabel: '设置文件：',
      loadErrorLabel: '文件有问题：',
      blank: '空白行会被忽略。',
      statusTitle: '状态',
      statusEnhanced: 'web-fetch-enhanced',
      statusThis: '本插件',
      statusConfig: '设置文件',
      enhancedInstalled: '已安装',
      enhancedEnabled: '已启用',
      enhancedDisabled: '已安装但未启用',
      enhancedMissing: '未安装',
      enhancedUnknown: '无法确定（没找到把本插件列入 bundles 的 profile）',
      enhancedWarn: 'web-fetch-enhanced 没有装或没有启用：web_fetch 走的可能不是它。本插件的族规则作用在 socket 层，仍然会生效，但如果你要的是「改 web_fetch 的行为」，先把 enhanced 打开。',
      armedYes: '已生效',
      armedNo: '未生效',
      ruleUnit: '条规则',
      diagTitle: '诊断一个网站',
      diagHint: '填域名（不要带协议、路径或端口）。诊断会实测这个域名在两族上的真实表现，并告诉你该动哪一层。探针直连 IP，所以不受上面规则影响。',
      diagPlaceholder: 'e621.net',
      diagRun: '测试',
      diagRunning: '正在测…',
      diagEvidence: '实测证据',
      diagSystemA: '系统解析 A',
      diagSystemAAAA: '系统解析 AAAA',
      diagPublicA: '公共 DoH A',
      diagPublicAAAA: '公共 DoH AAAA',
      diagDns: 'DNS 一致性',
      diagDnsYes: '与公共解析器一致',
      diagDnsNo: '与公共解析器不一致（被污染）',
      diagDnsUnknown: '无法判断（公共解析器没有回应）',
      diagV4: 'IPv4 握手',
      diagV6: 'IPv6 握手',
      diagClashDns: 'DNS 服务器',
      diagClashProxy: '代理环境变量',
      diagClashNone: '没有',
      diagOk: '通',
      diagFail: '不通',
      diagNoAnswer: '（无）',
      diagRecommend: '推荐设置',
      diagRecPlugin: '本插件',
      diagRecClash: 'Clash',
      diagRecEnhanced: 'web-fetch-enhanced',
      diagRecNone: '这一类问题没有对应的族规则——加规则不会有用。',
      diagRecAllowlist: 'web-fetch-enhanced 的 allowCidrs',
      diagAllowSuggest: '建议放行',
      diagAllowCurrent: '当前已有',
      diagAllowUnknown: '读不到（profile 的 cordis.patch.yml 里没有这一行）',
      diagAllowCovered: '建议的网段已经在里面了，不用加。',
      diagAllowCopy: '复制网段',
      diagAllowCopied: '已复制。去 web-fetch-enhanced 的设置里加进 allowCidrs。',
      diagAllowFailed: '复制失败，请手动选中上面那行文字。',
      applyRule: '填入上面的规则框',
      applied: '已填入上面的框，别忘了点保存。',
      modeLabel: '拦截范围',
      mode: '拦截范围',
      modeTargeted: '精准（Plan A）',
      modeGlobal: '全局（Plan B）',
      modeTargetedHint: '只在调用方自己解析过域名、并把自己的 lookup 交给了 socket 时才介入——那正是 web-fetch-enhanced 直连路径的特征。进程里其他任何连接连规则匹配都不做。',
      modeGlobalHint: '命中规则的连接一律改写，不管调用方有没有自己解析。覆盖更广（原生 provider 也算），代价是补丁会碰到每一处 TCP/TLS 连接，哪怕最后原样放过。',
      modeBypassed: '被精准模式放过'
    }

    /** English dictionary, same keys. */
    const en = {
      title: 'Domain families',
      ipv4Only: 'IPv4-only domains',
      ipv4OnlyHint: 'One domain per line. A match resolves to IPv4 addresses only.',
      ipv4OnlyPlaceholder: 'example.com\n*.example.net',
      ipv6Only: 'IPv6-only domains',
      ipv6OnlyHint: 'One domain per line. A match resolves to IPv6 addresses only.',
      ipv6OnlyPlaceholder: 'example.org',
      both: 'Both lists',
      loading: 'Loading configuration…',
      failedLoad: 'Could not read the configuration.',
      retry: 'Retry',
      unsaved: 'Unsaved',
      saved: 'Saved',
      saving: 'Saving…',
      save: 'Save',
      discard: 'Discard',
      pathLabel: 'Settings file:',
      loadErrorLabel: 'File problem:',
      blank: 'Blank lines are ignored.',
      statusTitle: 'Status',
      statusEnhanced: 'web-fetch-enhanced',
      statusThis: 'This plugin',
      statusConfig: 'Settings file',
      enhancedInstalled: 'installed',
      enhancedEnabled: 'enabled',
      enhancedDisabled: 'installed but not enabled',
      enhancedMissing: 'not installed',
      enhancedUnknown: 'unknown (no profile lists this plugin in its bundles)',
      enhancedWarn: 'web-fetch-enhanced is missing or switched off, so web_fetch may not be going through it. These rules act on the socket layer and still apply, but if your goal is to change web_fetch itself, enable it first.',
      armedYes: 'active',
      armedNo: 'inactive',
      ruleUnit: 'rules',
      diagTitle: 'Diagnose a site',
      diagHint: 'Enter a domain (no scheme, path, or port). The diagnosis measures how this domain really behaves on each family and says which layer to change. Probes connect to literals, so the rules above cannot influence them.',
      diagPlaceholder: 'e621.net',
      diagRun: 'Test',
      diagRunning: 'Testing…',
      diagEvidence: 'Measured evidence',
      diagSystemA: 'System A',
      diagSystemAAAA: 'System AAAA',
      diagPublicA: 'Public DoH A',
      diagPublicAAAA: 'Public DoH AAAA',
      diagDns: 'DNS agreement',
      diagDnsYes: 'matches the public resolver',
      diagDnsNo: 'does not match the public resolver (poisoned)',
      diagDnsUnknown: 'cannot tell (no public resolver answered)',
      diagV4: 'IPv4 handshake',
      diagV6: 'IPv6 handshake',
      diagClashDns: 'DNS servers',
      diagClashProxy: 'Proxy env',
      diagClashNone: 'none',
      diagOk: 'ok',
      diagFail: 'failed',
      diagNoAnswer: '(none)',
      diagRecommend: 'Recommended settings',
      diagRecPlugin: 'This plugin',
      diagRecClash: 'Clash',
      diagRecEnhanced: 'web-fetch-enhanced',
      diagRecNone: 'No family rule helps here — adding one would change nothing.',
      diagRecAllowlist: "web-fetch-enhanced's allowCidrs",
      diagAllowSuggest: 'Suggest allowing',
      diagAllowCurrent: 'Currently there',
      diagAllowUnknown: 'unreadable (no such line in the profile cordis.patch.yml)',
      diagAllowCovered: 'The suggested range is already there — nothing to add.',
      diagAllowCopy: 'Copy ranges',
      diagAllowCopied: 'Copied. Add them to allowCidrs in web-fetch-enhanced.',
      diagAllowFailed: 'Copy failed — select the line above by hand.',
      applyRule: 'Fill in the rules above',
      applied: 'Filled in above — remember to save.',
      modeLabel: 'Interception scope',
      mode: 'Interception scope',
      modeTargeted: 'Targeted (plan A)',
      modeGlobal: 'Global (plan B)',
      modeTargetedHint: 'Steps in only where the caller resolved the hostname itself and handed its own lookup to the socket — the pinned path of web-fetch-enhanced. Every other connection in the process is not even matched against the rules.',
      modeGlobalHint: 'Rewrites any connection whose host matches a rule, whether or not the caller resolved it. Broader coverage (the native provider included), at the cost of the patch seeing every TCP/TLS connect even when it passes straight through.',
      modeBypassed: 'Bypassed by targeted mode'
    }

    /**
     * One API call against the Host half.
     * @param path - route below the API prefix.
     * @param init - optional fetch init.
     * @returns the parsed JSON body; a rejected body carries `problems` when the
     * Host refused specific lines.
     */
    async function api(path, init) {
      const response = await fetch(`${API}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...init
      })
      const text = await response.text()
      let body
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        throw new Error(`${response.status}: ${text.slice(0, 200)}`)
      }
      if (!response.ok) {
        const error = new Error(body.error || `HTTP ${response.status}`)
        error.problems = body.problems
        throw error
      }
      return body
    }

    /** A rule list as textarea text. */
    const linesOf = (value) => (Array.isArray(value) ? value.join('\n') : '')

    const css = `
.wf-family-form{color:var(--dsw-alias-label-primary)}
.wf-family-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.wf-family-field+.wf-family-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.wf-family-label{font-size:13px;font-weight:500;line-height:1.5}
.wf-family-textarea{box-sizing:border-box;width:100%;min-height:88px;resize:vertical;padding:9px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-primary)}
.wf-family-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.wf-family-textarea:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.wf-family-hint,.wf-family-status,.wf-family-path{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.wf-family-failed{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.wf-family-problems{margin:0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary)}
.wf-family-footer{display:flex;align-items:center;gap:12px;padding:16px 0 4px}
.wf-family-failed,.wf-family-status{flex:1;min-width:0}
.wf-family-actions{margin-left:auto;display:flex;align-items:center;justify-content:flex-end;gap:8px}
.wf-family-button{appearance:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 14px;background:none;font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}
.wf-family-button:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.wf-family-save{border-color:transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.wf-family-save:hover:not(:disabled){border-color:transparent;color:var(--dsw-alias-bg-layer-3)}
.wf-family-button:disabled{opacity:.4;cursor:default}
.wf-family-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wf-family-box{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px 14px;margin:12px 0}
.wf-family-section-title{margin:0 0 8px;font-size:13px;font-weight:500;line-height:1.5}
.wf-family-box .wf-family-section-title:not(:first-child){margin-top:14px}
.wf-family-diag-row{display:flex;gap:12px;font-size:12px;line-height:1.7;padding:1px 0}
.wf-family-diag-key{flex:0 0 128px;color:var(--dsw-alias-label-tertiary)}
.wf-family-diag-val{flex:1;min-width:0;word-break:break-all;color:var(--dsw-alias-label-secondary)}
.wf-family-diag-good{flex:1;min-width:0;word-break:break-all;color:var(--dsw-alias-label-primary)}
.wf-family-diag-bad{flex:1;min-width:0;word-break:break-all;color:var(--dsw-alias-state-error-primary)}
.wf-family-input{box-sizing:border-box;flex:1;min-width:0;padding:6px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-primary)}
.wf-family-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.wf-family-probe{display:flex;gap:8px;align-items:center;margin:8px 0}
.wf-family-verdict{margin-top:12px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}
.wf-family-verdict-title{margin:0 0 4px;font-size:13px;font-weight:600;line-height:1.5}
.wf-family-rec{margin-top:10px}
.wf-family-rec-list{margin:4px 0 0;padding-left:18px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
@media(max-width:620px){.wf-family-footer{align-items:stretch;flex-direction:column}.wf-family-actions{width:100%;margin-left:0;flex-wrap:wrap}.wf-family-button{flex:1}.wf-family-diag-row{flex-direction:column;gap:0}.wf-family-diag-key{flex:none}.wf-family-probe{flex-direction:column;align-items:stretch}}
`

    /**
     * The bundle's configuration page: two rule lists, one save control.
     * Renders only this bundle's own document; drafts survive a refused save.
     */
    function FamilyPage({ t }) {
      const [phase, setPhase] = react.useState('loading')
      const [form, setForm] = react.useState({ mode: 'targeted', ipv4Only: '', ipv6Only: '' })
      const [saved, setSaved] = react.useState({ mode: 'targeted', ipv4Only: '', ipv6Only: '' })
      const [configPath, setConfigPath] = react.useState('')
      const [loadError, setLoadError] = react.useState(null)
      const [problems, setProblems] = react.useState([])
      const [notice, setNotice] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [attempt, setAttempt] = react.useState(0)
      const [status, setStatus] = react.useState(null)
      const [probeHost, setProbeHost] = react.useState('')
      const [probing, setProbing] = react.useState(false)
      const [diagnosis, setDiagnosis] = react.useState(null)
      const [probeError, setProbeError] = react.useState(null)
      const [applied, setApplied] = react.useState(false)
      const [copyNotice, setCopyNotice] = react.useState(null)

      react.useEffect(() => {
        let live = true
        setPhase('loading')
        setNotice(null)
        setProblems([])
        api('/config')
          .then((document) => {
            if (!live) return
            const next = {
              mode: document.mode === 'global' ? 'global' : 'targeted',
              ipv4Only: linesOf(document.ipv4Only),
              ipv6Only: linesOf(document.ipv6Only)
            }
            setForm(next)
            setSaved(next)
            setConfigPath(document.configPath ?? '')
            setLoadError(document.loadError ?? null)
            setPhase('ready')
          })
          .catch((error) => {
            if (!live) return
            setNotice({ kind: 'failed', text: error.message })
            setPhase('failed')
          })
        return () => {
          live = false
        }
      }, [attempt])

      // The status strip follows the saved document: every save re-reads it, so
      // "active / inactive" and the rule count can never drift from what is live.
      react.useEffect(() => {
        let live = true
        api('/status')
          .then((payload) => {
            if (live) setStatus(payload)
          })
          .catch(() => {
            if (live) setStatus(null)
          })
        return () => {
          live = false
        }
      }, [attempt, saved])

      const runProbe = async () => {
        if (probing || probeHost.trim() === '') return
        setProbing(true)
        setProbeError(null)
        setDiagnosis(null)
        setApplied(false)
        setCopyNotice(null)
        try {
          setDiagnosis(await api('/diagnose', { method: 'POST', body: JSON.stringify({ host: probeHost }) }))
        } catch (error) {
          setProbeError(error.message)
        } finally {
          setProbing(false)
        }
      }

      /** Stage the recommended rule into the textareas; saving stays a separate act. */
      const applyRecommendation = () => {
        const plugin = diagnosis?.verdict?.plugin
        if (!plugin) return
        setForm((previous) => {
          const lines = previous[plugin.list]
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
          if (lines.includes(plugin.rule)) return previous
          return { ...previous, [plugin.list]: [...lines, plugin.rule].join('\n') }
        })
        setProblems([])
        setNotice(null)
        setApplied(true)
      }

      /** Copy the ranges that still need allowlisting, ready to paste into enhanced. */
      const copyCidrs = async () => {
        const text = (diagnosis?.verdict?.allowlist?.missing ?? []).join('\n')
        if (text === '') return
        try {
          await globalThis.navigator.clipboard.writeText(text)
          setCopyNotice({ ok: true, text: t('diagAllowCopied') })
        } catch {
          setCopyNotice({ ok: false, text: t('diagAllowFailed') })
        }
      }

      const dirty =
        form.mode !== saved.mode ||
        form.ipv4Only !== saved.ipv4Only ||
        form.ipv6Only !== saved.ipv6Only

      const save = async () => {
        if (busy || !dirty) return
        setBusy(true)
        setNotice(null)
        setProblems([])
        try {
          const document = await api('/config', {
            method: 'POST',
            body: JSON.stringify({
              mode: form.mode,
              ipv4Only: form.ipv4Only.split(/\r?\n/),
              ipv6Only: form.ipv6Only.split(/\r?\n/)
            })
          })
          const next = { ipv4Only: linesOf(document.ipv4Only), ipv6Only: linesOf(document.ipv6Only) }
          setForm(next)
          setSaved(next)
          if (document.configPath) setConfigPath(document.configPath)
          setLoadError(null)
          setNotice({ kind: 'saved', text: t('saved') })
        } catch (error) {
          // The draft stays exactly as typed so the reported lines can be fixed.
          setProblems(Array.isArray(error.problems) ? error.problems : [])
          setNotice({ kind: 'failed', text: error.message })
        } finally {
          setBusy(false)
        }
      }

      const discard = () => {
        setForm(saved)
        setProblems([])
        setNotice(null)
      }

      if (phase === 'loading') {
        return h('p', { className: 'wf-family-status', role: 'status' }, t('loading'))
      }

      if (phase === 'failed') {
        return h('section', { className: 'wf-family-form', 'aria-label': t('title') }, [
          h('style', { key: 'style' }, css),
          h('p', { key: 'failed', className: 'wf-family-failed', role: 'alert' }, notice?.text ?? t('failedLoad')),
          h(
            'div',
            { key: 'actions', className: 'wf-family-footer' },
            h(
              'div',
              { className: 'wf-family-actions' },
              h(
                'button',
                { type: 'button', className: 'wf-family-button', onClick: () => setAttempt((value) => value + 1) },
                t('retry')
              )
            )
          )
        ])
      }

      const field = (key, label, hint, placeholder) =>
        h('div', { className: 'wf-family-field', key }, [
          h('label', { className: 'wf-family-label', htmlFor: `wf-family-${key}`, key: 'label' }, label),
          h('textarea', {
            id: `wf-family-${key}`,
            key: 'input',
            className: 'wf-family-textarea',
            value: form[key],
            disabled: busy,
            placeholder,
            spellCheck: false,
            autoCapitalize: 'none',
            'aria-describedby': `wf-family-${key}-hint`,
            onChange: (event) => {
              const value = event.target.value
              setForm((previous) => ({ ...previous, [key]: value }))
              setProblems([])
              setNotice(null)
            }
          }),
          h('p', { className: 'wf-family-hint', id: `wf-family-${key}-hint`, key: 'hint' }, hint)
        ])

      const problemList =
        problems.length === 0
          ? null
          : h(
              'ul',
              { className: 'wf-family-problems', key: 'problems' },
              problems.map((problem, index) =>
                h(
                  'li',
                  { key: index },
                  problem.line > 0
                    ? `${t(problem.list)} 第 ${problem.line} 行「${problem.text}」：${problem.reason}`
                    : `${t(problem.list)}「${problem.text}」：${problem.reason}`
                )
              )
            )

      /** One label/value line in the status or evidence block. */
      const row = (label, value, tone) =>
        h(
          'div',
          { className: 'wf-family-diag-row', key: label },
          h('span', { className: 'wf-family-diag-key' }, label),
          h('span', { className: tone ? `wf-family-diag-${tone}` : 'wf-family-diag-val' }, value)
        )

      const addresses = (list) =>
        Array.isArray(list) && list.length > 0 ? list.join(', ') : t('diagNoAnswer')

      const handshake = (probe) =>
        probe === null
          ? t('diagNoAnswer')
          : `${probe.ok ? t('diagOk') : t('diagFail')} · ${probe.error ?? probe.address} · ${probe.ms}ms`

      const enhancedLine = (() => {
        if (status === null) return t('loading')
        if (status.enhanced?.known !== true) return t('enhancedUnknown')
        if (!status.enhanced.installed) return t('enhancedMissing')
        const version = status.enhanced.version ? ` v${status.enhanced.version}` : ''
        return `${t('enhancedInstalled')}${version} · ${status.enhanced.enabled ? t('enhancedEnabled') : t('enhancedDisabled')}`
      })()
      // Reported, never enforced: the rules act on the socket layer either way.
      const enhancedAttention =
        status !== null &&
        status.enhanced?.known === true &&
        (!status.enhanced.installed || !status.enhanced.enabled)

      const statusBlock = h('div', { className: 'wf-family-box', key: 'status' }, [
        h('p', { className: 'wf-family-section-title', key: 'title' }, t('statusTitle')),
        row(t('statusEnhanced'), enhancedLine, enhancedAttention ? 'bad' : null),
        row(
          t('statusThis'),
          status === null
            ? t('loading')
            : status.armed
              ? `${t('armedYes')} · ${status.counts.ipv4Only + status.counts.ipv6Only} ${t('ruleUnit')}`
              : t('armedNo')
        ),
        row(t('statusConfig'), status?.configPath ?? configPath ?? '…'),
        row(t('modeLabel'), status?.mode === 'global' ? t('modeGlobal') : t('modeTargeted')),
        enhancedAttention
          ? h('p', { className: 'wf-family-hint', key: 'warn' }, t('enhancedWarn'))
          : null
      ])

      /**
       * The same technique under two gates: plan A steps in only where the caller
       * resolved the hostname and passed its own lookup, plan B steps in on any
       * matching connection. Saving is still a separate act.
       */
      const modeButton = (value, label) =>
        h(
          'button',
          {
            key: value,
            type: 'button',
            className: form.mode === value ? 'wf-family-button wf-family-save' : 'wf-family-button',
            'aria-pressed': form.mode === value,
            disabled: busy,
            onClick: () => {
              setForm((previous) => ({ ...previous, mode: value }))
              setNotice(null)
            }
          },
          label
        )

      const modeBlock = h('div', { className: 'wf-family-field', key: 'mode' }, [
        h('span', { className: 'wf-family-label', key: 'label' }, t('modeLabel')),
        h('div', { className: 'wf-family-probe', key: 'switch' }, [
          modeButton('targeted', t('modeTargeted')),
          modeButton('global', t('modeGlobal'))
        ]),
        h(
          'p',
          { className: 'wf-family-hint', key: 'hint' },
          form.mode === 'global' ? t('modeGlobalHint') : t('modeTargetedHint')
        ),
        status !== null && status.counters?.passedThrough > 0
          ? h(
              'p',
              { className: 'wf-family-hint', key: 'bypassed' },
              `${t('modeBypassed')}：${status.counters.passedThrough}`
            )
          : null
      ])

      const evidence = diagnosis === null ? null : diagnosis.evidence
      const verdict = diagnosis === null ? null : diagnosis.verdict
      const toneOf = (probe) => (probe === null ? null : probe.ok ? 'good' : 'bad')

      const diagnosisBlock = h('div', { className: 'wf-family-box', key: 'diagnosis' }, [
        h('p', { className: 'wf-family-section-title', key: 'title' }, t('diagTitle')),
        h('p', { className: 'wf-family-hint', key: 'hint' }, t('diagHint')),
        h('div', { className: 'wf-family-probe', key: 'probe' }, [
          h('input', {
            key: 'host',
            type: 'text',
            className: 'wf-family-input',
            value: probeHost,
            disabled: probing,
            placeholder: t('diagPlaceholder'),
            spellCheck: false,
            autoCapitalize: 'none',
            'aria-label': t('diagTitle'),
            onChange: (event) => {
              setProbeHost(event.target.value)
              setProbeError(null)
              setDiagnosis(null)
              setApplied(false)
              setCopyNotice(null)
            },
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              void runProbe()
            }
          }),
          h(
            'button',
            {
              key: 'run',
              type: 'button',
              className: 'wf-family-button wf-family-save',
              disabled: probing || probeHost.trim() === '',
              onClick: () => {
                void runProbe()
              }
            },
            probing ? t('diagRunning') : t('diagRun')
          )
        ]),
        probeError ? h('p', { className: 'wf-family-failed', role: 'alert', key: 'error' }, probeError) : null,
        diagnosis === null
          ? null
          : h('div', { className: 'wf-family-verdict', key: 'verdict' }, [
              h('p', { className: 'wf-family-verdict-title', key: 'vtitle' }, verdict.title),
              h('p', { className: 'wf-family-hint', key: 'vsummary' }, verdict.summary),

              h('p', { className: 'wf-family-section-title', key: 'etitle' }, t('diagEvidence')),
              row(t('diagSystemA'), addresses(evidence.systemA)),
              row(t('diagSystemAAAA'), addresses(evidence.systemAAAA)),
              row(t('diagPublicA'), addresses(evidence.publicA)),
              row(t('diagPublicAAAA'), addresses(evidence.publicAAAA)),
              row(
                t('diagDns'),
                evidence.dnsConsistent === null
                  ? t('diagDnsUnknown')
                  : evidence.dnsConsistent
                    ? t('diagDnsYes')
                    : t('diagDnsNo'),
                evidence.dnsConsistent === null ? null : evidence.dnsConsistent ? 'good' : 'bad'
              ),
              row(t('diagV4'), handshake(evidence.v4), toneOf(evidence.v4)),
              row(t('diagV6'), handshake(evidence.v6), toneOf(evidence.v6)),
              row(t('diagClashDns'), addresses(diagnosis.clash?.dnsServers)),
              row(
                t('diagClashProxy'),
                diagnosis.clash?.hasProxyEnv
                  ? Object.entries(diagnosis.clash.proxyEnv)
                      .map(([key, value]) => `${key}=${value}`)
                      .join(', ')
                  : t('diagClashNone')
              ),

              h('p', { className: 'wf-family-section-title', key: 'rtitle' }, t('diagRecommend')),
              verdict.plugin === null
                ? h('p', { className: 'wf-family-hint', key: 'noplugin' }, t('diagRecNone'))
                : h('div', { className: 'wf-family-rec', key: 'plugin' }, [
                    h(
                      'p',
                      { className: 'wf-family-hint', key: 'text' },
                      `${t('diagRecPlugin')}：${verdict.plugin.list} ← ${verdict.plugin.rule}`
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'wf-family-button', onClick: applyRecommendation, key: 'apply' },
                      t('applyRule')
                    )
                  ]),
              verdict.allowlist === null
                ? null
                : h('div', { className: 'wf-family-rec', key: 'allowlist' }, [
                    h('p', { className: 'wf-family-hint', key: 'label' }, t('diagRecAllowlist')),
                    row(
                      t('diagAllowSuggest'),
                      verdict.allowlist.suggest.join(', '),
                      verdict.allowlist.missing.length === 0 ? 'good' : null
                    ),
                    row(
                      t('diagAllowCurrent'),
                      verdict.allowlist.current === null
                        ? t('diagAllowUnknown')
                        : verdict.allowlist.current.length === 0
                          ? t('diagNoAnswer')
                          : verdict.allowlist.current.join(', ')
                    ),
                    verdict.allowlist.missing.length === 0
                      ? h('p', { className: 'wf-family-hint', key: 'covered' }, t('diagAllowCovered'))
                      : h(
                          'div',
                          { className: 'wf-family-actions', key: 'copy' },
                          h(
                            'button',
                            { type: 'button', className: 'wf-family-button', onClick: () => void copyCidrs() },
                            t('diagAllowCopy')
                          )
                        ),
                    copyNotice === null
                      ? null
                      : h(
                          'p',
                          {
                            className: copyNotice.ok ? 'wf-family-hint' : 'wf-family-failed',
                            role: 'status',
                            key: 'copynotice'
                          },
                          copyNotice.text
                        )
                  ]),
              verdict.clashHint === ''
                ? null
                : h('div', { className: 'wf-family-rec', key: 'clash' }, [
                    h('p', { className: 'wf-family-hint', key: 'label' }, t('diagRecClash')),
                    h('p', { className: 'wf-family-hint', key: 'text' }, verdict.clashHint)
                  ]),
              verdict.enhancedHint === ''
                ? null
                : h('div', { className: 'wf-family-rec', key: 'enhanced' }, [
                    h('p', { className: 'wf-family-hint', key: 'label' }, t('diagRecEnhanced')),
                    h('p', { className: 'wf-family-hint', key: 'text' }, verdict.enhancedHint)
                  ]),
              verdict.notes.length === 0
                ? null
                : h(
                    'ul',
                    { className: 'wf-family-rec-list', key: 'notes' },
                    verdict.notes.map((text, index) => h('li', { key: index }, text))
                  ),
              applied ? h('p', { className: 'wf-family-hint', role: 'status', key: 'applied' }, t('applied')) : null
            ])
      ])

      return h('section', { className: 'wf-family-form', 'aria-label': t('title'), 'aria-busy': busy }, [
        h('style', { key: 'style' }, css),
        statusBlock,
        loadError
          ? h('p', { className: 'wf-family-failed', role: 'status', key: 'load-error' }, `${t('loadErrorLabel')} ${loadError}`)
          : null,
        modeBlock,
        field('ipv4Only', t('ipv4Only'), t('ipv4OnlyHint'), t('ipv4OnlyPlaceholder')),
        field('ipv6Only', t('ipv6Only'), t('ipv6OnlyHint'), t('ipv6OnlyPlaceholder')),
        problemList,
        h('p', { className: 'wf-family-path', key: 'path' }, `${t('pathLabel')} ${configPath || '…'}`),
        h('div', { className: 'wf-family-footer', key: 'footer' }, [
          notice?.kind === 'failed'
            ? h('p', { className: 'wf-family-failed', role: 'alert', key: 'notice' }, notice.text)
            : h(
                'p',
                { className: 'wf-family-status', role: 'status', key: 'notice' },
                busy ? t('saving') : dirty ? t('unsaved') : notice?.kind === 'saved' ? t('saved') : ''
              ),
          h('div', { className: 'wf-family-actions', key: 'actions' }, [
            h(
              'button',
              { type: 'button', className: 'wf-family-button', disabled: busy || !dirty, onClick: discard, key: 'discard' },
              t('discard')
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'wf-family-button wf-family-save',
                disabled: busy || !dirty,
                onClick: () => {
                  void save()
                },
                key: 'save'
              },
              busy ? t('saving') : t('save')
            )
          ])
        ]),
        diagnosisBlock
      ])
    }

    const name = 'web-fetch-family-client'
    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NAMESPACE)
      ctx.effect(
        () => ctx.locale.register(LOCALE_NAMESPACE, { en, zh }),
        'web-fetch-family: settings dictionaries'
      )
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            // Keyed by npm package name: that is what the plugin manager looks up.
            key: 'dsh-web-fetch-family',
            locale: LOCALE_NAMESPACE,
            inject: () => ({ t })
          },
          FamilyPage
        )
      )
    }

    exports.FamilyPage = FamilyPage
    exports.api = api
    exports.apply = apply
    exports.inject = inject
    exports.linesOf = linesOf
    exports.name = name
    return module.exports
  }
})
