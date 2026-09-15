// prompt-polish — interactive Tab-key prompt polishing for Hermes Desktop
//
// Press Tab (focus in composer, non-empty draft) to rewrite the draft into a
// high-quality task prompt. The Python bridge behind ctx.rest handles the
// engine chain: Hermes auxiliary model (primary) -> prompts.chat
// improve_prompt (when PROMPTS_API_KEY is set) -> community search fallback.
// The renderer never talks to external APIs directly (CORS); everything is
// proxied through /api/plugins/prompt-polish. UI strings ship as plugin
// i18n bundles (en + zh) and follow the app's display.language setting.
import {
  atom,
  Button,
  cn,
  COMPOSER_AREAS,
  GlyphSpinner,
  haptic,
  host,
  Kbd,
  KEYBINDS_AREA,
  PALETTE_AREA,
  STATUSBAR_AREAS,
  usePluginI18n,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'prompt-polish'
let pluginCtx = null
// Module-level translator for handlers/stores (non-reactive; the app's
// active locale is read at call time). Set in register().
let t = key => key

// ── state ────────────────────────────────────────────────────────────────
const initial = () => ({
  status: 'idle', // idle | loading | ready | error
  mode: '',     // improve | search | preview
  text: '',     // polished text / preview content
  items: [],    // search results
  error: '',
  seq: 0
})
const $st = atom(initial())
function set(patch) {
  $st.set({ ...$st.get(), ...patch, seq: $st.get().seq + 1 })
}

// ── composer DOM adapter (app contract selectors only) ───────────────────
function composerRoot() {
  return document.querySelector('[data-slot="composer-root"]:has([data-slot="composer-surface"])')
}
function composerInput() {
  const root = composerRoot()
  if (!root) return null
  return (
    root.querySelector('[data-slot="composer-surface"] [data-slot="composer-rich-input"][role="textbox"]') ||
    root.querySelector('[data-slot="composer-surface"] textarea:not([aria-hidden])')
  )
}
function readDraft() {
  const el = composerInput()
  if (!el) return ''
  return el instanceof HTMLTextAreaElement ? el.value : el.textContent || ''
}
function writeDraft(text) {
  const el = composerInput()
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (!setter) return false
    setter.call(el, text)
  } else {
    el.textContent = text
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.focus()
  if (el.isContentEditable) {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
  return true
}
function draftFocused(event) {
  const target = event?.target
  const el = composerInput()
  return Boolean(el && target instanceof Node && el.contains(target))
}

// ── actions ──────────────────────────────────────────────────────────────
async function runPolish() {
  const state = $st.get()
  if (state.status === 'loading') return
  const source = state.status === 'ready' && state.mode !== 'search' && state.text
    ? state.text
    : readDraft().trim()
  if (!source) {
    host.notify({ kind: 'info', message: t('notify.empty') })
    return
  }
  set({ status: 'loading', error: '' })
  try {
    const res = await pluginCtx.rest('/polish', {
      method: 'POST',
      body: { prompt: source },
      timeoutMs: 90_000
    })
    if (res?.mode === 'improve') set({ status: 'ready', mode: 'improve', text: res.text, items: [] })
    else if (res?.mode === 'search') set({ status: 'ready', mode: 'search', items: res.items || [], text: '' })
    else set({ status: 'error', error: res?.error || t('error.unknown') })
  } catch (err) {
    set({ status: 'error', error: String(err?.message || err) })
  }
}

async function useSearchResult(item) {
  if (!item?.id) return
  set({ status: 'loading' })
  try {
    const res = await pluginCtx.rest(`/prompt?id=${encodeURIComponent(item.id)}`, { timeoutMs: 30_000 })
    if (res?.ok && res.content) set({ status: 'ready', mode: 'preview', text: res.content })
    else set({ status: 'error', error: res?.error || t('search.fetchFail') })
  } catch (err) {
    set({ status: 'error', error: String(err?.message || err) })
  }
}

function applyToDraft() {
  const { mode, text } = $st.get()
  if (mode === 'search' || !text) return
  if (writeDraft(text)) {
    haptic('tap')
    set({ status: 'idle', mode: '', text: '', items: [] })
  }
}

function closeStrip() {
  $st.set(initial())
}

function tabKeyHandler(event) {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const state = $st.get()
  if (state.status === 'loading') {
    event.preventDefault()
    return
  }
  if (state.status === 'error') {
    if (!draftFocused(event)) return
    event.preventDefault()
    closeStrip()
    return
  }
  if (state.status === 'ready') {
    if (!draftFocused(event)) return
    event.preventDefault()
    runPolish() // iterate on the polished text
    return
  }
  // idle: take over only when focus is in the composer and the draft is non-empty
  const el = composerInput()
  const focused = el && event.target instanceof Node && el.contains(event.target)
  if (!focused) return
  if (!readDraft().trim()) return
  event.preventDefault()
  event.stopPropagation()
  runPolish()
}

function escKeyHandler(event) {
  if (event.key !== 'Escape') return
  if ($st.get().status === 'idle' || $st.get().status === 'loading') return
  event.preventDefault()
  event.stopPropagation()
  closeStrip()
}

// ── UI ───────────────────────────────────────────────────────────────────
const stripStyle = {
  border: '1px solid var(--ui-stroke-secondary)',
  borderRadius: 10,
  marginBottom: 6,
  overflow: 'hidden'
}
const textStyle = {
  color: 'var(--ui-text-secondary)',
  fontSize: '0.8125rem',
  lineHeight: 1.55,
  maxHeight: '9.5rem',
  overflowY: 'auto',
  padding: '8px 12px',
  whiteSpace: 'pre-wrap'
}
const barStyle = {
  alignItems: 'center',
  borderTop: '1px solid var(--ui-stroke-secondary)',
  display: 'flex',
  gap: 8,
  justifyContent: 'space-between',
  padding: '6px 10px'
}
const mono = { fontFamily: 'var(--ui-font-mono, ui-monospace, monospace)' }

function PolishedStrip({ state }) {
  const tr = usePluginI18n(ID)
  return jsxs('div', {
    style: stripStyle,
    children: [
      jsx('div', { style: textStyle, children: state.text }),
      jsxs('div', {
        style: barStyle,
        children: [
          jsxs('div', {
            style: { alignItems: 'center', color: 'var(--ui-text-quaternary)', display: 'flex', fontSize: '0.6875rem', gap: 6 },
            children: [
              jsx('span', { children: state.mode === 'improve' ? tr('strip.sourceImprove') : tr('strip.sourcePreview') }),
              jsx(Kbd, { children: 'Tab' }),
              jsx('span', { children: tr('strip.hintRepolish') }),
              jsx(Kbd, { children: 'Esc' }),
              jsx('span', { children: tr('strip.hintDismiss') })
            ]
          }),
          jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
            jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => runPolish(), children: tr('strip.btnAgain') }),
            jsx(Button, { size: 'xs', onClick: applyToDraft, children: tr('strip.btnApply') })
          ] })
        ]
      })
    ]
  })
}

function SearchStrip({ state }) {
  const tr = usePluginI18n(ID)
  const body = state.items.length
    ? jsxs('div', {
        style: { display: 'grid', gap: 2, maxHeight: '13rem', overflowY: 'auto', padding: '4px 6px' },
        children: state.items.map((item, i) =>
          jsxs('button', {
            type: 'button',
            onClick: () => useSearchResult(item),
            style: {
              background: 'transparent',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              display: 'grid',
              gap: 2,
              padding: '6px 8px',
              textAlign: 'left',
              width: '100%'
            },
            className: cn('hover:bg-(--ui-surface-secondary)'),
            children: [
              jsxs('div', { style: { display: 'flex', gap: 8, minWidth: 0 }, children: [
                jsx('span', { style: { ...mono, color: 'var(--ui-text-quaternary)', flex: 'none' }, children: String(i + 1) }),
                jsx('span', { style: { color: 'var(--ui-text-secondary)', flex: '1 1 auto', fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: item.title })
              ] }),
              item.preview
                ? jsx('div', { style: { color: 'var(--ui-text-quaternary)', fontSize: '0.6875rem', lineHeight: 1.5, overflow: 'hidden', padding: '0 0 0 1.6em', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: item.preview })
                : null
            ]
          })
        )
      })
    : jsx('div', { style: { ...textStyle, color: 'var(--ui-text-quaternary)' }, children: tr('search.none') })
  return jsxs('div', { style: stripStyle, children: [
    jsx('div', { style: { ...textStyle, color: 'var(--ui-text-quaternary)', maxHeight: 'none' }, children: tr('search.fallback') }),
    body,
    jsxs('div', { style: barStyle, children: [
      jsx('div', { style: { alignItems: 'center', color: 'var(--ui-text-quaternary)', display: 'flex', fontSize: '0.6875rem', gap: 6 }, children: tr('search.hint') }),
      jsx(Button, { size: 'xs', variant: 'ghost', onClick: closeStrip, children: tr('search.btnClose') })
    ] })
  ] })
}

function ErrorStrip({ state }) {
  const tr = usePluginI18n(ID)
  return jsxs('div', { style: stripStyle, children: [
    jsx('div', { style: { ...textStyle, color: 'var(--ui-text-secondary)' }, children: state.error || tr('error.unreachable') }),
    jsxs('div', { style: barStyle, children: [
      jsx('span', { style: { color: 'var(--ui-text-quaternary)', fontSize: '0.6875rem' }, children: tr('error.hint') }),
      jsx(Button, { size: 'xs', variant: 'ghost', onClick: closeStrip, children: tr('search.btnClose') })
    ] })
  ] })
}

function PolishOverlay() {
  const tr = usePluginI18n(ID)
  const state = useValue($st)
  if (state.status === 'idle') return null
  if (state.status === 'loading') {
    return jsxs('div', { style: { ...stripStyle, display: 'flex' }, children: [
      jsxs('div', { style: { alignItems: 'center', display: 'flex', gap: 8, padding: '10px 12px' }, children: [
        jsx(GlyphSpinner, {}),
        jsx('span', { style: { color: 'var(--ui-text-tertiary)', fontSize: '0.75rem' }, children: tr('loading.text') })
      ] })
    ] })
  }
  if (state.status === 'error') return jsx(ErrorStrip, { state })
  return state.mode === 'search' ? jsx(SearchStrip, { state }) : jsx(PolishedStrip, { state })
}

function PolishChip() {
  const tr = usePluginI18n(ID)
  const state = useValue($st)
  return jsx('button', {
    type: 'button',
    title: tr('chip.title'),
    className: cn(
      'px-1.5 text-[0.6875rem]',
      state.status !== 'idle' ? 'text-(--ui-accent)' : 'text-(--ui-text-quaternary)'
    ),
    onClick: () => host.notify({ kind: 'info', message: tr('chip.notify') }),
    children: 'PP'
  })
}

// ── locale bundles ───────────────────────────────────────────────────────
// NOTE: the SDK resolves keys by dot-path *into a nested tree*
// (`resolvePath('chip.notify')` → STRINGS[locale].chip.notify). Flat quoted
// keys do NOT work — they fall through to the raw key string.
const STRINGS = {
  en: {
    notify: { empty: 'Write a draft first, then press Tab to polish it.' },
    error: {
      unknown: 'Unknown error',
      unreachable: 'Polishing service unreachable',
      hint: 'Tab to retry · Esc to dismiss'
    },
    loading: { text: 'Polishing prompt…' },
    strip: {
      sourceImprove: 'Prompt polish',
      sourcePreview: 'Community prompt · full text',
      hintRepolish: 're-polish',
      hintDismiss: 'dismiss',
      btnAgain: 'Again',
      btnApply: 'Apply to draft'
    },
    search: {
      fetchFail: 'Failed to fetch full text',
      fallback: 'Local polishing unavailable — showing community search results.',
      none: 'No similar prompts found in the community.',
      hint: 'Click a result to adopt it',
      btnClose: 'Close'
    },
    chip: {
      title: 'Prompt Polish loaded — press Tab in the composer to polish the draft',
      notify: 'Prompt Polish loaded: write a draft in the composer, then press Tab to polish (Ctrl+Shift+P as backup).'
    },
    palette: {
      label: 'Polish composer draft',
      detailReady: 'Polish the current draft',
      detailEmpty: 'Composer is empty'
    },
    keybind: { label: 'Polish composer draft (prompt-polish)' }
  },
  zh: {
    notify: { empty: '先写点内容，再按 Tab 润色。' },
    error: {
      unknown: '未知错误',
      unreachable: '润色服务不可达',
      hint: 'Tab 重试 · Esc 关闭'
    },
    loading: { text: '正在润色提示词…' },
    strip: {
      sourceImprove: '提示词润色',
      sourcePreview: '社区提示词 · 全文',
      hintRepolish: '再润色',
      hintDismiss: '关闭',
      btnAgain: '再来一次',
      btnApply: '应用到草稿'
    },
    search: {
      fetchFail: '取全文失败',
      fallback: '本地润色暂不可用，转社区检索结果。',
      none: '社区里没有相近的提示词。',
      hint: '点击采用社区提示词',
      btnClose: '关闭'
    },
    chip: {
      title: 'Prompt Polish 已加载 — 焦点在输入框按 Tab 润色草稿',
      notify: 'Prompt Polish 已加载：在输入框写好草稿后按 Tab 润色（Ctrl+Shift+P 备用）。'
    },
    palette: {
      label: '润色输入框草稿',
      detailReady: '润色当前草稿',
      detailEmpty: '输入框为空'
    },
    keybind: { label: '润色输入框草稿（prompt-polish）' }
  }
}

// ── registration ─────────────────────────────────────────────────────────
export default {
  id: ID,
  name: 'Prompt Polish',
  register(ctx) {
    pluginCtx = ctx
    ctx.i18n.register(STRINGS)
    t = ctx.i18n.t
    // Window capture layer: keydown propagates window→document→target, so we
    // run before any document-level capture listeners (e.g. a competing Tab
    // plugin); stopPropagation then keeps the Tab out of their hands.
    window.addEventListener('keydown', tabKeyHandler, true)
    document.addEventListener('keydown', escKeyHandler, true)
    ctx.onDispose(() => {
      window.removeEventListener('keydown', tabKeyHandler, true)
      document.removeEventListener('keydown', escKeyHandler, true)
      pluginCtx = null
      $st.set(initial())
    })
    ctx.registerMany([
      {
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 140,
        render: () => jsx(PolishChip, {})
      },
      {
        id: 'strip',
        area: COMPOSER_AREAS.top,
        render: () => jsx(PolishOverlay, {})
      },
      {
        id: 'palette-polish',
        area: PALETTE_AREA,
        data: {
          id: 'prompt-polish.run',
          action: 'prompt-polish.run',
          label: t('palette.label'),
          keywords: ['polish', 'prompt', 'prompts.chat'],
          detail: () => (readDraft().trim() ? t('palette.detailReady') : t('palette.detailEmpty')),
          run: runPolish
        }
      },
      {
        id: 'keybind-polish',
        area: KEYBINDS_AREA,
        data: {
          id: 'prompt-polish.run',
          label: t('keybind.label'),
          category: 'composer',
          defaults: ['mod+shift+p'],
          run: runPolish
        }
      }
    ])
  }
}
