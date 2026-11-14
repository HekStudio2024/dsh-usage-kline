window.__ModuleLoader__.load({
  id: 'dsh-usage-kline',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const API = '/dsh-usage-kline/api'

    // ---------------------------------------------------------------------
    // Terminal palette. The artwork below keeps its own dark, saturated
    // palette independent of the host theme, like a trading terminal does.
    // ---------------------------------------------------------------------
    const T = {
      bg: '#070a12',
      panel: '#0a0f1a',
      panelHead: '#0d1421',
      row: '#0a0f19',
      rowAlt: '#0b111c',
      grid: '#111a2b',
      gridSoft: '#0e1626',
      border: '#16233a',
      text: '#c8d2e0',
      textHi: '#e6edf7',
      dim: '#5f6d84',
      faint: '#39465c',
      up: '#2ee6a0',
      down: '#ff4d6a',
      upDim: '#1a8f68',
      downDim: '#a3324a',
      cyan: '#4dd7e8',
      gold: '#f3c64f',
      white: '#f0f4fb',
    }
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
    const STAGE_HEIGHTS = { 40: 240, 90: 300 }
    const RANGES = [7, 14, 30, 60, 90]
    const BUCKETS = [
      { key: 'cachedInput', label: '缓存命中', color: T.cyan },
      { key: 'uncachedInput', label: '缓存未命中', color: T.gold },
      { key: 'output', label: '输出', color: T.up },
      { key: 'request', label: '请求数', color: T.down },
    ]

    // ---------------------------------------------------------------------
    // Formatting
    // ---------------------------------------------------------------------
    function clampDigits(value) {
      const size = Math.abs(value)
      return size >= 100 ? 1 : size >= 1 ? 2 : size >= 0.01 ? 4 : 6
    }

    function amount(value, digits) {
      if (!Number.isFinite(value)) return '—'
      return value.toLocaleString('en-US', { minimumFractionDigits: digits ?? clampDigits(value), maximumFractionDigits: digits ?? clampDigits(value) })
    }

    function money(value, currency, digits) {
      if (!Number.isFinite(value)) return '—'
      return `${currency === 'USD' ? '$' : '¥'}${amount(value, digits)}`
    }

    function compact(value) {
      if (!Number.isFinite(value)) return '—'
      if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}B`
      if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}K`
      return String(Math.round(value))
    }

    function timeOf(ms) {
      const date = new Date(ms)
      return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':')
    }

    function shortDay(day) {
      const [, month, date] = day.split('-')
      return `${Number(month)}/${Number(date)}`
    }

    function clockOf(ms) {
      const date = new Date(ms)
      return {
        time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`,
        date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
        weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()],
      }
    }

    async function requestJson(path) {
      const response = await fetch(`${API}${path}`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      const text = await response.text()
      let value
      try {
        value = JSON.parse(text)
      } catch {
        value = undefined
      }
      if (!response.ok) throw new Error(value?.error ?? `request failed (${response.status})`)
      return value
    }

    // ---------------------------------------------------------------------
    // Data
    // ---------------------------------------------------------------------
    function useUsageFeed(onRevision) {
      const handler = useRef(onRevision)
      handler.current = onRevision
      useEffect(() => {
        let timer
        let source
        try {
          source = new EventSource(`${API}/events`)
          source.onmessage = () => {
            clearTimeout(timer)
            timer = setTimeout(() => handler.current(), 1500)
          }
          source.onerror = () => {
            source?.close()
            source = undefined
          }
        } catch (error) {
          void error
          source = undefined
        }
        return () => {
          clearTimeout(timer)
          source?.close()
        }
      }, [])
    }

    function useSummary() {
      const [summary, setSummary] = useState(undefined)
      const load = useCallback(async () => {
        try {
          const [overview, account] = await Promise.allSettled([requestJson('/overview?days=7'), requestJson('/account')])
          if (overview.status === 'fulfilled') {
            setSummary({ overview: overview.value, account: account.status === 'fulfilled' ? account.value : undefined })
          }
        } catch (error) {
          void error
        }
      }, [])
      useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), 60_000)
        return () => clearInterval(timer)
      }, [load])
      useUsageFeed(() => void load())
      return summary
    }

    function useClock() {
      const [clock, setClock] = useState(() => clockOf(Date.now()))
      useEffect(() => {
        const timer = setInterval(() => setClock(clockOf(Date.now())), 1000)
        return () => clearInterval(timer)
      }, [])
      return clock
    }

    // ---------------------------------------------------------------------
    // Candlestick stage: grid, candles, volume histogram, MA overlay, last
    // price tag, crosshair with scales and axis labels.
    // ---------------------------------------------------------------------
    function TradingStage({ t, mode, metric, series, dayLabels, height, currency }) {
      const box = useRef(null)
      const [width, setWidth] = useState(560)
      const [hover, setHover] = useState(-1)
      useEffect(() => {
        const node = box.current
        if (node === null || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver((entries) => {
          for (const entry of entries) setWidth(Math.max(240, Math.round(entry.contentRect.width)))
        })
        observer.observe(node)
        return () => observer.disconnect()
      }, [])

      const price = height - 62
      const volumeHeight = 46
      const pad = { left: 8, right: 58, top: 8, bottom: 20 }
      const chartWidth = Math.max(80, width - pad.left - pad.right)
      const chartHeight = Math.max(40, price - pad.top - 4)
      const volumeTop = price
      const active = hover >= 0 ? series[hover] : series[series.length - 1]
      const isCandles = mode === 'candles'

      const bounds = useMemo(() => {
        let low = Infinity
        let high = -Infinity
        for (const item of series) {
          if (item.empty) continue
          low = Math.min(low, isCandles ? item.low : item.value)
          high = Math.max(high, isCandles ? item.high : item.value)
        }
        if (!Number.isFinite(low)) return { low: 0, high: 1 }
        if (high - low < 1e-12) {
          const spread = Math.max(Math.abs(high) * 0.3, metric === 'cost' ? 0.01 : 1)
          return { low: Math.max(0, low - spread), high: high + spread }
        }
        const margin = (high - low) * 0.08
        return { low: Math.max(0, low - margin), high: high + margin }
      }, [series, isCandles, metric])

      const step = chartWidth / Math.max(1, series.length)
      const bodyWidth = Math.max(2, Math.min(18, step * 0.6))
      const yOf = (value) => pad.top + chartHeight - ((value - bounds.low) / (bounds.high - bounds.low)) * chartHeight
      const tickLines = []
      for (let index = 0; index <= 4; index += 1) {
        const value = bounds.low + ((bounds.high - bounds.low) * index) / 4
        tickLines.push({ y: yOf(value), value })
      }
      const maxVolume = series.reduce((peak, item) => Math.max(peak, item.volume ?? 0), 0) || 1
      const ma = series.map((item) => item.value ?? 0)
      const moving = ma.map((_, index, list) => {
        const window = list.slice(Math.max(0, index - 4), index + 1)
        return window.reduce((sum, value) => sum + value, 0) / window.length
      })
      const labelStep = Math.max(1, Math.ceil(series.length / Math.max(3, Math.floor(chartWidth / 64))))

      const onMove = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        const index = Math.floor((event.clientX - rect.left - pad.left) / step)
        setHover(index >= 0 && index < series.length ? index : -1)
      }

      const readout = [
        [t('open'), active === undefined ? 0 : active.open],
        [t('high'), active === undefined ? 0 : active.high],
        [t('low'), active === undefined ? 0 : active.low],
        [t('close'), active === undefined ? 0 : active.close],
        ['MA5', moving[hover >= 0 ? hover : series.length - 1] ?? 0],
      ]

      const labelOf = (day, index) => (mode === 'intraday' ? timeOf(day) : shortDay(day))

      return React.createElement(
        'div',
        { ref: box, style: { width: '100%', userSelect: 'none' } },
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 14, alignItems: 'baseline', padding: '6px 8px 4px', fontFamily: MONO, fontSize: 10.5, color: T.dim, whiteSpace: 'nowrap', overflow: 'hidden' } },
          readout.map(([label, value]) =>
            React.createElement(
              'span',
              { key: label, style: { color: label === 'MA5' ? T.gold : T.dim } },
              label,
              ' ',
              metric === 'cost' ? money(value, currency, 4) : compact(value),
            ),
          ),
          React.createElement('span', { style: { marginLeft: 'auto', color: T.faint } }, `${series.filter((item) => !item.empty).length} / ${series.length}`),
        ),
        React.createElement(
          'svg',
          {
            width: '100%',
            height,
            viewBox: `0 0 ${width} ${height}`,
            style: { display: 'block' },
            onMouseMove: onMove,
            onMouseLeave: () => setHover(-1),
          },
          // frame
          React.createElement('rect', { x: 0.5, y: 0.5, width: width - 1, height: height - 1, fill: 'none', stroke: T.grid, strokeWidth: 1 }),
          tickLines.map((line, index) =>
            React.createElement(
              'g',
              { key: `tick-${index}` },
              React.createElement('line', { x1: pad.left, x2: pad.left + chartWidth, y1: line.y, y2: line.y, stroke: T.grid, strokeWidth: 1 }),
              React.createElement(
                'text',
                { x: width - pad.right + 6, y: line.y + 3.5, fontSize: 9.5, fill: T.dim, fontFamily: MONO },
                metric === 'cost' ? amount(line.value, 4) : compact(line.value),
              ),
            ),
          ),
          React.createElement('line', { x1: pad.left, x2: pad.left + chartWidth, y1: volumeTop, y2: volumeTop, stroke: T.grid, strokeWidth: 1 }),
          React.createElement('text', { x: pad.left + 4, y: volumeTop - 4, fontSize: 9, fill: T.dim, fontFamily: MONO }, 'VOL'),
          React.createElement('text', { x: width - pad.right - 4, y: volumeTop - 4, fontSize: 9, fill: T.faint, fontFamily: MONO, textAnchor: 'end' }, t('volume')),
          // MA line
          React.createElement('polyline', {
            fill: 'none',
            stroke: T.gold,
            strokeWidth: 1,
            opacity: 0.75,
            points: moving.map((value, index) => `${pad.left + step * (index + 0.5)},${yOf(value)}`).join(' '),
          }),
          series.map((item, index) => {
            const x = pad.left + step * (index + 0.5)
            if (item.empty === true) {
              return React.createElement('line', { key: `e-${index}`, x1: x, x2: x, y1: volumeTop - 2, y2: volumeTop - 7, stroke: T.faint, strokeWidth: 1 })
            }
            const rising = item.close >= item.open
            const color = rising ? T.up : T.down
            const bodyTop = Math.min(yOf(item.open), yOf(item.close))
            const bodyHeight = Math.max(1.4, Math.abs(yOf(item.close) - yOf(item.open)))
            const volumeHeightValue = Math.max(1, (item.volume / maxVolume) * (volumeHeight - 4))
            return React.createElement(
              'g',
              { key: `c-${index}`, opacity: hover === -1 || hover === index ? 1 : 0.65 },
              isCandles
                ? React.createElement(
                    React.Fragment,
                    null,
                    React.createElement('line', { x1: x, x2: x, y1: yOf(item.high), y2: yOf(item.low), stroke: color, strokeWidth: 1.1 }),
                    React.createElement('rect', {
                      x: x - bodyWidth / 2,
                      y: bodyTop,
                      width: bodyWidth,
                      height: bodyHeight,
                      fill: rising ? 'none' : color,
                      stroke: color,
                      strokeWidth: 1.1,
                    }),
                  )
                : React.createElement('rect', {
                    x: x - bodyWidth / 2,
                    y: yOf(Math.max(item.value, 0)),
                    width: bodyWidth,
                    height: Math.max(1.4, yOf(bounds.low) - yOf(item.value)),
                    fill: T.cyan,
                    opacity: 0.85,
                  }),
              React.createElement('rect', {
                x: x - bodyWidth / 2,
                y: volumeTop + (volumeHeight - volumeHeightValue),
                width: bodyWidth,
                height: volumeHeightValue,
                fill: color,
                opacity: 0.75,
              }),
            )
          }),
          // last price tag
          series.length > 0 && series[series.length - 1].empty !== true
            ? React.createElement(
                'g',
                null,
                React.createElement('line', {
                  x1: pad.left,
                  x2: pad.left + chartWidth,
                  y1: yOf(series[series.length - 1].close),
                  y2: yOf(series[series.length - 1].close),
                  stroke: series[series.length - 1].close >= series[series.length - 1].open ? T.up : T.down,
                  strokeDasharray: '2 3',
                  opacity: 0.5,
                }),
                React.createElement('rect', {
                  x: width - pad.right + 1,
                  y: yOf(series[series.length - 1].close) - 8,
                  width: pad.right - 4,
                  height: 16,
                  fill: series[series.length - 1].close >= series[series.length - 1].open ? T.upDim : T.downDim,
                  rx: 1.5,
                }),
                React.createElement(
                  'text',
                  { x: width - pad.right + 4, y: yOf(series[series.length - 1].close) + 3.5, fontSize: 9.5, fill: T.white, fontFamily: MONO },
                  metric === 'cost' ? amount(series[series.length - 1].close, 4) : compact(series[series.length - 1].close),
                ),
              )
            : null,
          hover >= 0 && series[hover].empty !== true
            ? React.createElement(
                'g',
                { pointerEvents: 'none' },
                React.createElement('line', { x1: pad.left + step * (hover + 0.5), x2: pad.left + step * (hover + 0.5), y1: pad.top, y2: volumeTop + volumeHeight, stroke: T.dim, strokeDasharray: '3 3', opacity: 0.8 }),
                React.createElement('line', { x1: pad.left, x2: pad.left + chartWidth, y1: yOf(series[hover].close), y2: yOf(series[hover].close), stroke: T.dim, strokeDasharray: '3 3', opacity: 0.5 }),
              )
            : null,
          // x labels
          series.map((item, index) =>
            index % labelStep === (series.length - 1) % labelStep && item.empty !== true
              ? React.createElement(
                  'text',
                  { key: `x-${index}`, x: pad.left + step * (index + 0.5), y: height - 5, fontSize: 9, fill: hover === index ? T.textHi : T.dim, fontFamily: MONO, textAnchor: 'middle' },
                  labelOf(item.day, index),
                )
              : null,
          ),
          React.createElement('text', { x: pad.left + 4, y: pad.top + 10, fontSize: 9.5, fill: T.faint, fontFamily: MONO }, dayLabels),
        ),
      )
    }

    function sparkline(series, width, height, color) {
      if (series.length === 0) return null
      const values = series.map((item) => item.close ?? 0)
      const low = Math.min(...values)
      const high = Math.max(...values)
      const span = high - low < 1e-12 ? 1 : high - low
      const points = values.map((value, index) => `${(index / Math.max(1, values.length - 1)) * (width - 2) + 1},${height - 2 - ((value - low) / span) * (height - 4)}`)
      return React.createElement('polyline', { points: points.join(' '), fill: 'none', stroke: color, strokeWidth: 1, opacity: 0.9 })
    }

    // ---------------------------------------------------------------------
    // Per-conversation usage table: every conversation in the range with its
    // id, spend and tokens. Right-clicking a row offers "Open conversation".
    // ---------------------------------------------------------------------
    /** Navigates to the conversation when the page hosts `uiWorkspace`. */
    function openSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      const root = pageContextHolder
      if (root === undefined || root === null) return false
      let workspace
      try {
        workspace = root.get('uiWorkspace')
      } catch (error) {
        void error
        return false
      }
      if (workspace === undefined || workspace === null || typeof workspace.openSession !== 'function') return false
      try {
        workspace.openSession(sessionId)
        return true
      } catch (error) {
        void error
        return false
      }
    }

    /** The guarded client context, captured in `apply` for page-level actions. */
    let pageContextHolder

    /** Looks the client Workspace face up, or `undefined` when it is absent. */
    function workspaceFace() {
      const root = pageContextHolder
      if (root === undefined || root === null) return undefined
      try {
        return root.get('uiWorkspace')
      } catch (error) {
        void error
        return undefined
      }
    }

    /**
     * Removes one conversation. The Harness exposes archiving rather than
     * deletion for Sessions, so this archives it (it leaves the Workspace and
     * can be restored from the archived list) and reports a human-readable
     * outcome instead of pretending the log was deleted.
     */
    async function deleteConversation(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, message: '对话 ID 无效' }
      // Hide it from this panel first: archiving only moves the Session out of
      // the Workspace list, while the checkpoint scan would still find its log.
      let hidden = false
      try {
        const response = await fetch(`${API}/remove`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        hidden = response.ok
      } catch (error) {
        void error
      }
      const workspace = workspaceFace()
      let archived = false
      if (workspace !== undefined && workspace !== null && typeof workspace.archiveSession === 'function') {
        try {
          await workspace.archiveSession(sessionId)
          archived = true
        } catch (error) {
          void error
        }
      }
      const label = sessionId.replace(/^session-/, '').slice(0, 8)
      if (hidden) return { ok: true, message: `已删除 ${label}${archived ? '（已归档）' : ''}`, sessionId }
      if (archived) return { ok: true, message: `已归档 ${label}`, sessionId }
      return { ok: false, message: '删除失败：当前客户端无法隐藏该对话' }
    }
    function SessionMenu({ t, anchor, onJump, onClose, onDelete }) {
      const [pending, setPending] = useState(undefined)
      const node = useRef(null)
      // The menu closes on an explicit dismissal only: a click inside it, the
      // Escape key, or a pointerdown that started outside it *after* it opened.
      // Listening for `mousedown` (not `pointerdown`) skips the very event that
      // opened the menu, which would otherwise close it immediately for rows
      // whose right-click target differs from the row element.
      useEffect(() => {
        const openedAt = Date.now()
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        const onPointer = (event) => {
          if (Date.now() - openedAt < 200) return
          const target = event.target
          if (node.current !== null && typeof node.current.contains === 'function' && node.current.contains(target)) return
          onClose()
        }
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('mousedown', onPointer, true)
        return () => {
          window.removeEventListener('keydown', onKey, true)
          window.removeEventListener('mousedown', onPointer, true)
        }
      }, [onClose])
      const item = (label, run, disabled) =>
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: disabled === true,
            onContextMenu: (event) => event.preventDefault(),
            onClick: (event) => {
              event.stopPropagation()
              if (disabled !== true) run()
              onClose()
            },
            style: {
              display: 'block',
              width: '100%',
              padding: '6px 10px',
              background: 'transparent',
              border: 'none',
              color: disabled === true ? T.faint : T.text,
              fontFamily: MONO,
              fontSize: 11,
              textAlign: 'left',
              cursor: disabled === true ? 'default' : 'pointer',
            },
          },
          label,
        )
      const remove = (sessionId) => {
        setPending(sessionId)
        Promise.resolve(onDelete(sessionId))
          .catch(() => undefined)
          .finally(() => setPending(undefined))
      }
      // `position: fixed` keeps the menu on the viewport even inside the
      // scrolling card, and no portal is needed because the panel itself is not
      // transformed; a high z-index lifts it above sibling cards.
      return React.createElement(
        'div',
        {
          ref: node,
          'data-session-menu': '',
          role: 'menu',
          onContextMenu: (event) => event.preventDefault(),
          style: {
            position: 'fixed',
            top: Math.max(8, Math.min(anchor.y, (window.innerHeight || 800) - 170)),
            left: Math.max(8, Math.min(anchor.x, (window.innerWidth || 1200) - 220)),
            zIndex: 2147483000,
            minWidth: 200,
            background: T.panelHead,
            border: `1px solid ${T.border}`,
            boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
            padding: '3px 0',
            pointerEvents: 'auto',
            fontFamily: MONO,
          },
        },
        React.createElement('div', { style: { padding: '4px 10px', color: T.faint, fontSize: 9.5, borderBottom: `1px solid ${T.gridSoft}`, wordBreak: 'break-all' } }, anchor.sessionId),
        item('跳转至该对话', onJump, anchor.available !== true),
        item(pending === anchor.sessionId ? '正在删除…' : '删除该对话', () => remove(anchor.sessionId), pending === anchor.sessionId || anchor.deletable !== true),
        item('复制对话 ID', () => {
          try {
            window.navigator.clipboard?.writeText(anchor.sessionId)
          } catch (error) {
            void error
          }
        }),
        anchor.available === true ? null : React.createElement('div', { style: { padding: '2px 10px 4px', color: T.faint, fontSize: 9, borderTop: `1px solid ${T.gridSoft}` } }, '导航服务不可用'),
      )
    }

    /**
     * Compares every usage source this Harness can show. The sources are fixed,
     * so the same block appears whatever the range holds:
     *   session logs      - what a session's own runs reported (request context)
     *   projection checkpoints - the durable tokenUsage fold per Session
     *   live requests     - calls recorded while the page was open
     *   page totals      - the priced sum the terminal shows
     *   account balance  - the Platform wallets (recharged / granted)
     *   Platform usage   - the account's own usage page (opaque to this Host)
     */
    function OverviewCompare({ t, data, account, currency, range }) {
      const totals = data?.totals ?? { cost: 0, tokens: 0, requests: 0, buckets: {} }
      const buckets = totals.buckets ?? {}
      const inputs = (buckets.cacheRead ?? 0) + (buckets.uncached ?? 0)
      const hitRate = inputs <= 0 ? 0 : ((buckets.cacheRead ?? 0) / inputs) * 100
      const sources = data?.sourceTotals ?? { checkpoint: { cost: 0, tokens: 0, requests: 0 }, live: { cost: 0, tokens: 0, requests: 0 } }
      const conversations = data?.lifetimeConversations ?? data?.conversations ?? []
      const usable = (account?.usable ?? []).find((entry) => entry.currency === currency) ?? (account?.usable ?? [])[0]
      const rows = [
        {
          key: 'checkpoint',
          source: '投影检查点',
          label: 'session-projcache/tokenUsage',
          basis: '会话级累计（模型归属取本会话最新路由）',
          tokens: sources.checkpoint?.tokens ?? 0,
          requests: sources.checkpoint?.requests ?? 0,
          cost: sources.checkpoint?.cost ?? 0,
          note: `${data?.logs ?? 0} 个检查点`,
        },
        {
          key: 'live',
          source: '实时请求',
          label: 'llm/stream 瀑布记录',
          basis: '页面打开后发生的调用',
          tokens: sources.live?.tokens ?? 0,
          requests: sources.live?.requests ?? 0,
          cost: sources.live?.cost ?? 0,
          note: `${data?.liveCount ?? 0} 条实时样本`,
        },
        {
          key: 'total',
          source: '本页合计',
          label: '上述两者之和',
          basis: '按官方单价、按时段估算',
          tokens: totals.tokens ?? 0,
          requests: totals.requests ?? 0,
          cost: totals.cost ?? 0,
          note: `输入命中率 ${hitRate.toFixed(1)}%`,
        },
        {
          key: 'balance',
          source: '账户余额',
          label: '平台钱包',
          basis: '充值余额 + 赠送余额',
          tokens: null,
          requests: null,
          cost: null,
          note:
            usable === undefined
              ? account?.status === 'signed-out'
                ? '未登录'
                : '不可用'
              : `充值 ${money(usable.charged ?? 0, usable.currency, 2)} · 赠送 ${money(usable.granted ?? 0, usable.currency, 2)}`,
        },
        {
          key: 'platform',
          source: '平台用量页',
          label: 'platform.deepseek.com/usage',
          basis: '官方账单口径',
          tokens: null,
          requests: null,
          cost: null,
          note: '需登录平台页查看（含搜索抓取等按次费用）',
        },
      ]
      const columns = '96px minmax(130px, 1.5fr) minmax(120px, 1.6fr) 96px 76px 88px'
      const conversationCount = conversations.length
      return React.createElement(
        'div',
        { style: { margin: '0 6px 6px', background: T.panel, border: `1px solid ${T.border}` }, 'data-usage-compare': '' },
        React.createElement(
          'div',
          { style: head({}) },
          React.createElement('span', { style: { color: T.textHi, fontWeight: 600 } }, '用量对比'),
          React.createElement('span', { style: { color: T.faint, fontSize: 10 } }, '可查看来源 · 同口径'),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement('span', { style: { color: T.dim, fontSize: 10 } }, `范围 ${range} 天 · 估算 ${money(totals.cost ?? 0, currency, 4)}`),
          account?.usageUrl
            ? React.createElement(
                'button',
                {
                  type: 'button',
                  onClick: () => window.open(account.usageUrl, '_blank', 'noopener,noreferrer'),
                  style: { ...buttonStyle(false, T.cyan), marginLeft: 6 },
                  title: account.usageUrl,
                },
                '打开平台用量',
              )
            : null,
        ),
        React.createElement(
          'div',
          { style: { display: 'grid', gridTemplateColumns: columns, gap: 8, padding: '4px 8px', color: T.faint, fontSize: 9.5, borderBottom: `1px solid ${T.gridSoft}` } },
          React.createElement('span', null, '来源'),
          React.createElement('span', null, '数据位置'),
          React.createElement('span', null, '口径 / 明细'),
          React.createElement('span', { style: { textAlign: 'right' } }, 'Token'),
          React.createElement('span', { style: { textAlign: 'right' } }, '请求'),
          React.createElement('span', { style: { textAlign: 'right' } }, '金额/备注'),
        ),
        rows.map((row, index) =>
          React.createElement(
            'div',
            { key: row.key, style: { display: 'grid', gridTemplateColumns: columns, gap: 8, padding: '3px 8px', background: index % 2 === 0 ? T.row : T.rowAlt, fontSize: 10.5, alignItems: 'center' } },
            React.createElement('span', { style: { color: row.key === 'total' ? T.gold : T.text } }, row.source),
            React.createElement('span', { style: { color: T.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.label),
            React.createElement('span', { style: { color: T.faint, fontSize: 9.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.note),
            React.createElement('span', { style: { textAlign: 'right', color: T.dim } }, row.tokens === null ? '—' : compact(row.tokens)),
            React.createElement('span', { style: { textAlign: 'right', color: T.dim } }, row.requests === null ? '—' : String(row.requests)),
            React.createElement(
              'span',
              { style: { textAlign: 'right', color: row.cost === null ? T.faint : row.key === 'total' ? T.down : T.cyan, fontSize: 10 } },
              row.cost === null ? '—' : money(row.cost, currency, 4),
            ),
          ),
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 14, padding: '4px 8px', borderTop: `1px solid ${T.border}`, color: T.faint, fontSize: 9.5, flexWrap: 'wrap' } },
          React.createElement('span', null, `会话记录 ${conversationCount} 个对话`),
          React.createElement('span', null, `缓存命中 ${compact(buckets.cacheRead ?? 0)}`),
          React.createElement('span', null, `缓存未命中 ${compact(buckets.uncached ?? 0)}`),
          React.createElement('span', null, `输出 ${compact(buckets.output ?? 0)}`),
          React.createElement(
            'span',
            { style: { color: data?.scan?.readable > 0 ? T.faint : T.down } },
            data?.scan === undefined
              ? '扫描状态 未知'
              : data.scan.error === undefined
                ? `扫描 ${data.scan.directory || '（未解析到目录）'} · 来源 ${data.scan.homeSource ?? '—'} · 找到 ${data.scan.files} 个检查点 · 可读 ${data.scan.readable}${data.scan.malformed > 0 ? ` · 损坏 ${data.scan.malformed}` : ''}`
                : `扫描失败 ${data.scan.error} · ${data.scan.directory}`,
          ),
          React.createElement('span', { style: { color: T.dim } }, `本页估算仅覆盖 ${conversationCount} 个对话与实时调用；平台用量页包含本机未记录的调用`),
        ),
      )
    }

    /**
     * Ranks every conversation of one Workspace in the current range. The list
     * is scoped by the Workspace picker above it: "全部工作区" ranks every
     * conversation, a specific Workspace ranks only its own sessions.
     */
    function WorkspaceRanking({ t, data, currency, onJump, onDelete, onOpenTab, listHeight }) {
      // Every conversation ever recorded, so a Workspace ranks its whole history;
      // the range above only filters the charts.
      const conversations = data?.lifetimeConversations ?? data?.conversations ?? []
      const [scope, setScope] = useState('all')
      const [anchor, setAnchor] = useState(undefined)
      const [notice, setNotice] = useState(undefined)
      const jump = (id) => onJump(id) === true
      // Opening the menu must not navigate: a right-click reports whether the
      // conversation can be opened, and the menu's own item performs the jump.
      const canJump = (id) => typeof onJump === 'function' && typeof id === 'string' && id !== ''
      const openAt = (x, y, row) => {
        const next = { x, y, sessionId: row.sessionId, available: canJump(row.sessionId), deletable: typeof onDelete === 'function' }
        // Defer past the dispatching event: a dismiss listener the menu installs
        // during this same dispatch could otherwise close it immediately.
        window.setTimeout(() => setAnchor(next), 0)
      }
      const workspaces = useMemo(() => {
        const map = new Map()
        let loose = 0
        for (const row of conversations) {
          if (row.workspace === null || row.workspace === undefined) {
            loose += 1
            continue
          }
          const entry = map.get(row.workspace.id) ?? { id: row.workspace.id, title: row.workspace.title, path: row.workspace.path, cost: 0, count: 0 }
          entry.cost += row.cost
          entry.count += 1
          map.set(row.workspace.id, entry)
        }
        return { list: [...map.values()].sort((left, right) => right.cost - left.cost), loose }
      }, [conversations])

      const scoped = useMemo(() => {
        if (scope === 'all') return conversations
        if (scope === 'loose') return conversations.filter((row) => row.workspace === null || row.workspace === undefined)
        return conversations.filter((row) => row.workspace?.id === scope)
      }, [conversations, scope])
      const active = workspaces.list.find((entry) => entry.id === scope)
      const scopedCost = scoped.reduce((sum, row) => sum + row.cost, 0)
      const scopedTokens = scoped.reduce((sum, row) => sum + row.tokens, 0)
      const scopedRequests = scoped.reduce((sum, row) => sum + row.requests, 0)
      const leader = scoped.length === 0 ? 1e-9 : Math.max(scoped[0].cost, 1e-9)
      const columns = '34px 132px minmax(110px, 1.5fr) 84px 92px 64px 56px 70px'

      return React.createElement(
        'div',
        { style: { margin: '0 6px 6px', background: T.panel, border: `1px solid ${T.border}` }, 'data-workspace-ranking': '' },
        React.createElement(
          'div',
          { style: head({ flexWrap: 'wrap', rowGap: 4 }) },
          React.createElement('span', { style: { color: T.textHi, fontWeight: 600 } }, '工作区对话用量排名'),
          React.createElement('span', { style: { color: T.faint, fontSize: 10 } }, '全部历史 · 按金额'),
          React.createElement(
            'select',
            {
              value: scope,
              onChange: (event) => setScope(event.target.value),
              title: '按工作区筛选',
              style: { background: T.bg, color: T.text, border: `1px solid ${T.border}`, fontFamily: MONO, fontSize: 10.5, padding: '1px 4px', maxWidth: 220 },
            },
            React.createElement('option', { value: 'all' }, `全部工作区 (${conversations.length})`),
            workspaces.list.map((entry) =>
              React.createElement('option', { key: entry.id, value: entry.id }, `${entry.title} (${entry.count})`),
            ),
            workspaces.loose > 0 ? React.createElement('option', { value: 'loose' }, `未归类 (${workspaces.loose})`) : null,
          ),
          React.createElement('span', { style: { flex: 1 } }),
          active === undefined ? null : React.createElement('span', { style: { color: T.faint, fontSize: 9.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 } }, active.path),
          React.createElement('span', { style: { color: T.dim, fontSize: 10 } }, `${scoped.length} 个对话 · ${scopedRequests} 次请求`),
          React.createElement('span', { style: { color: T.down, fontSize: 10 } }, `${money(scopedCost, currency, 4)}`),
          React.createElement('span', { style: { color: T.cyan, fontSize: 10 } }, `${compact(scopedTokens)} tok`),
        ),
        React.createElement(
          'div',
          { style: { display: 'grid', gridTemplateColumns: columns, gap: 8, padding: '4px 8px', color: T.faint, fontSize: 9.5, borderBottom: `1px solid ${T.gridSoft}` } },
          React.createElement('span', null, '名次'),
          React.createElement('span', null, '对话 ID'),
          React.createElement('span', null, '标题 / 工作区'),
          React.createElement('span', { style: { textAlign: 'right' } }, '金额'),
          React.createElement('span', { style: { textAlign: 'right' } }, 'Token'),
          React.createElement('span', { style: { textAlign: 'right' } }, '请求'),
          React.createElement('span', { style: { textAlign: 'right' } }, '占比'),
          React.createElement('span', { style: { textAlign: 'right' } }, '操作'),
        ),
        React.createElement(
          'div',
          { style: { maxHeight: listHeight, overflow: 'auto' } },
          scoped.length === 0
            ? React.createElement('div', { style: { padding: '14px 10px', color: T.dim, fontSize: 11 } }, t('empty'))
            : scoped.map((row, index) =>
                React.createElement(
                  'div',
                  {
                    key: row.sessionId,
                    'data-session-row': row.sessionId,
                    onContextMenu: (event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      openAt(event.clientX, event.clientY, row)
                    },                    style: { position: 'relative', display: 'grid', gridTemplateColumns: columns, gap: 8, alignItems: 'center', padding: '3px 8px', background: index % 2 === 0 ? T.row : T.rowAlt, fontSize: 10.5 },
                  },
                  React.createElement('div', { style: { position: 'absolute', inset: '2px auto 2px 0', width: `${Math.max(4, (row.cost / leader) * 100)}%`, background: index < 3 ? T.upDim : T.downDim, opacity: index < 3 ? 0.18 : 0.1, pointerEvents: 'none' } }),
                  React.createElement('span', { style: { color: index < 3 ? T.gold : T.faint, fontWeight: index < 3 ? 700 : 400 } }, String(index + 1).padStart(2, '0')),
                  React.createElement('span', { title: row.sessionId, style: { color: row.open ? T.cyan : T.text, fontSize: 9.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.sessionId.replace(/^session-/, '')),
                  React.createElement(
                    'span',
                    { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    row.label,
                    React.createElement('span', { style: { color: T.faint, marginLeft: 6, fontSize: 9.5 } }, row.workspace?.title ?? '未归类'),
                  ),
                  React.createElement('span', { style: { textAlign: 'right', color: T.down } }, money(row.cost, currency, 4)),
                  React.createElement('span', { style: { textAlign: 'right', color: T.dim } }, compact(row.tokens)),
                  React.createElement('span', { style: { textAlign: 'right', color: T.dim } }, String(row.requests)),
                  React.createElement('span', { style: { textAlign: 'right', color: T.cyan } }, `${scopedCost <= 0 ? '0.0' : ((row.cost / scopedCost) * 100).toFixed(1)}%`),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      onClick: () => {
                        if (!jump(row.sessionId)) onOpenTab()
                      },
                      style: { ...buttonStyle(false, T.gold), fontSize: 9.5, padding: '0 6px', justifySelf: 'end' },
                    },
                    '跳转',
                  ),
                ),
              ),
        ),
        notice === undefined
          ? null
          : React.createElement('div', { style: { padding: '3px 8px', fontSize: 9.5, color: notice.ok === true ? T.up : T.down, borderTop: `1px solid ${T.gridSoft}` } }, notice.message),
        anchor === undefined
          ? null
          : React.createElement(SessionMenu, {
              key: `${anchor.sessionId}@${anchor.x},${anchor.y}`,
              t,
              anchor,
              onClose: () => setAnchor(undefined),
              onJump: () => { if (!jump(anchor.sessionId)) onOpenTab() },
              onDelete: async (sessionId) => {
                const result = typeof onDelete === 'function' ? await onDelete(sessionId) : { ok: false, message: '当前客户端无法归档该对话' }
                setNotice(result)
                return result
              },
            }),
      )
    }

    function TurnTable({ t, turns, currency, metric }) {
      const rows = turns?.turns ?? []
      if (rows.length === 0) return null
      const columns = '56px 96px 90px 84px 84px 84px'
      const ledger = rows.reduce(
        (sum, row) => ({
          cost: sum.cost + row.cost,
          input: sum.input + row.buckets.uncached,
          cacheRead: sum.cacheRead + row.buckets.cacheRead,
          output: sum.output + row.buckets.output,
        }),
        { cost: 0, input: 0, cacheRead: 0, output: 0 },
      )
      const turnsCount = new Set(rows.map((row) => row.turn)).size
      return React.createElement(
        'div',
        { style: { margin: '0 6px 6px', background: T.panel, border: `1px solid ${T.border}` } },
        React.createElement(
          'div',
          { style: head({}) },
          React.createElement('span', { style: { color: T.textHi, fontWeight: 600 } }, '本次对话用量'),
          React.createElement('span', { style: { color: T.faint, fontSize: 10 } }, '逐轮统计'),
          React.createElement('span', { style: { color: T.dim, fontSize: 10 } }, `${turnsCount} 轮 · ${rows.length} 次请求`),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement('span', { style: { color: T.up, fontSize: 10 } }, `缓存 ${compact(ledger.cacheRead)}`),
          React.createElement('span', { style: { color: T.gold, fontSize: 10 } }, `输入 ${compact(ledger.input)}`),
          React.createElement('span', { style: { color: T.cyan, fontSize: 10 } }, `输出 ${compact(ledger.output)}`),
          React.createElement('span', { style: { color: T.down, fontSize: 10 } }, `合计 ${money(ledger.cost, currency, 4)}`),
        ),
        React.createElement(
          'div',
          { style: { display: 'grid', gridTemplateColumns: columns, gap: 8, padding: '4px 8px', color: T.faint, fontSize: 9.5, borderBottom: `1px solid ${T.gridSoft}` } },
          React.createElement('span', null, '轮次'),
          React.createElement('span', null, '时间'),
          React.createElement('span', { style: { textAlign: 'right' } }, 'Token'),
          React.createElement('span', { style: { textAlign: 'right' } }, '缓存命中'),
          React.createElement('span', { style: { textAlign: 'right' } }, '输入'),
          React.createElement('span', { style: { textAlign: 'right' } }, metric === 'cost' ? '金额' : '输出'),
        ),
        rows.map((row, index) =>
          React.createElement(
            'div',
            {
              key: `${row.turn}-${row.step}-${index}`,
              style: { display: 'grid', gridTemplateColumns: columns, gap: 8, padding: '2px 8px', background: index % 2 === 0 ? T.row : T.rowAlt, fontSize: 10.5 },
            },
            React.createElement('span', { style: { color: T.gold } }, `T${row.turn}.${row.step}`),
            React.createElement('span', { style: { color: T.faint, fontSize: 9.5 } }, timeOf(row.time)),
            React.createElement('span', { style: { textAlign: 'right' } }, compact(row.tokens)),
            React.createElement('span', { style: { textAlign: 'right', color: T.dim } }, compact(row.buckets.cacheRead)),
            React.createElement('span', { style: { textAlign: 'right', color: T.dim } }, compact(row.buckets.uncached)),
            React.createElement('span', { style: { textAlign: 'right', color: metric === 'cost' ? T.down : T.dim } }, metric === 'cost' ? money(row.cost, currency, 4) : compact(row.buckets.output)),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // The page
    // ---------------------------------------------------------------------
    const cell = (style) => ({ padding: '3px 8px', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...style })
    const head = (style) => ({ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', background: T.panelHead, borderBottom: `1px solid ${T.border}`, ...style })
    const tag = (color) => ({ color, border: `1px solid ${color}55`, borderRadius: 2, padding: '0 5px', fontSize: 10 })
    const buttonStyle = (active, color) => ({ background: active ? color : 'transparent', color: active ? T.bg : T.dim, border: `1px solid ${active ? color : T.border}`, borderRadius: 2, padding: '1px 8px', fontSize: 10, cursor: 'pointer', fontFamily: MONO, fontWeight: active ? 600 : 400 })

    function UsageChartPage({ t, sessionId }) {
      const clock = useClock()
      const [range, setRange] = useState(30)
      const [mode, setMode] = useState('candles')
      const [metric, setMetric] = useState('cost')
      const [bucket, setBucket] = useState('cachedInput')
      const [selected, setSelected] = useState(0)
      const [data, setData] = useState(undefined)
      const [status, setStatus] = useState('loading')
      const [failure, setFailure] = useState(undefined)
      const [nonce, setNonce] = useState(0)
      const [turns, setTurns] = useState(undefined)
      const [account, setAccount] = useState(undefined)

      useEffect(() => {
        let cancelled = false
        const current = typeof sessionId === 'string' && sessionId !== '' ? `&sessionId=${encodeURIComponent(sessionId)}` : ''
        requestJson(`/overview?days=${range}${current}`)
          .then((value) => {
            if (cancelled) return
            setData(value)
            setStatus('ready')
            setFailure(undefined)
          })
          .catch((error) => {
            if (cancelled) return
            setStatus('error')
            setFailure(String(error?.message ?? error))
          })
        return () => {
          cancelled = true
        }
      }, [range, nonce, sessionId])

      // The comparison reads the account wallets alongside the page totals.
      useEffect(() => {
        let cancelled = false
        requestJson('/account')
          .then((value) => {
            if (!cancelled) setAccount(value)
          })
          .catch(() => undefined)
        return () => {
          cancelled = true
        }
      }, [nonce])

      // The turn-by-turn table needs the open Session id, which only the slots
      // pass; the page renders without one.
      useEffect(() => {
        let cancelled = false
        if (typeof sessionId !== 'string' || sessionId === '') return () => undefined
        requestJson(`/turns?sessionId=${encodeURIComponent(sessionId)}`)
          .then((value) => {
            if (!cancelled) setTurns(value)
          })
          .catch(() => undefined)
        return () => {
          cancelled = true
        }
      }, [range, nonce, sessionId])

      useUsageFeed(() => setNonce((value) => value + 1))
      const refresh = () => setNonce((value) => value + 1)

      const seriesList = data?.series ?? []
      const current = seriesList[Math.min(selected, Math.max(0, seriesList.length - 1))]
      const currency = data?.currency ?? 'CNY'
      const positions = data?.priced ?? []
      const priceOf = (value, digits) => (metric === 'cost' ? money(value, currency, digits) : compact(value))

      /** The main stage: the selected model's daily candles, or today's calls. */
      const stage = useMemo(() => {
        if (current === undefined || data === undefined) return []
        if (mode === 'intraday') {
          return current.todayCandles.map((call) => ({
            day: call.time,
            open: call.open,
            close: call.close,
            high: call.high,
            low: call.low,
            value: metric === 'cost' ? call.open : call.tokens,
            volume: call.tokens,
            empty: false,
          }))
        }
        const byDay = new Map(current.candles.map((candle) => [candle.day, candle]))
        const todayKey = data.today
        const keys = []
        for (let index = range - 1; index >= 0; index -= 1) {
          keys.push(new Date(Date.parse(`${todayKey}T00:00:00Z`) - index * 86400000).toISOString().slice(0, 10))
        }
        return keys.map((key) => {
          const candle = byDay.get(key)
          if (candle === undefined) return { day: key, empty: true, open: 0, close: 0, high: 0, low: 0, value: 0, volume: 0 }
          return {
            day: key,
            open: metric === 'cost' ? candle.open : candle.openTokens,
            close: metric === 'cost' ? candle.close : candle.closeTokens,
            high: metric === 'cost' ? candle.high : candle.highTokens,
            low: metric === 'cost' ? candle.low : candle.lowTokens,
            value: metric === 'cost' ? candle.close : candle.closeTokens,
            volume: candle.tokens,
            empty: false,
          }
        })
      }, [current, data, mode, metric, range])

      const dayChange = useMemo(() => {
        if (current === undefined || current.candles.length < 2) return 0
        const candles = current.candles
        return candles[candles.length - 1].close - candles[candles.length - 2].close
      }, [current])

      const lastTrade = current === undefined || current.todayCandles.length === 0
        ? undefined
        : current.todayCandles[current.todayCandles.length - 1]
      const totals = data?.totals ?? { cost: 0, tokens: 0, requests: 0, buckets: {} }
      const bucketRows = BUCKETS.map((entry) => ({
        ...entry,
        value: bucket === 'request' ? totals.requests : (totals.buckets ?? {})[entry.key] ?? 0,
      }))
      const dayValues = stage.filter((item) => item.empty !== true)
      const todayOpen = dayValues.length === 0 ? 0 : dayValues[0].open
      const todayHigh = stage.reduce((peak, item) => Math.max(peak, item.high ?? 0), 0)
      const todayLow = stage.reduce((trough, item) => Math.min(trough, item.low ?? Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY)
      const todayVolume = stage.reduce((sum, item) => sum + (item.volume ?? 0), 0)
      const rankings = [...seriesList].sort((left, right) => right.summary.cost - left.summary.cost)
      const leader = rankings.length === 0 ? 1e-9 : Math.max(rankings[0].summary.cost, 1e-9)
      const recentTicks = positions.slice(-9).reverse()

      const stampCells = (candleSeries) =>
        candleSeries.slice(-9).map((call, index) =>
          React.createElement('rect', {
            key: index,
            x: index * 10,
            y: call.close >= call.open ? 1 : 5,
            width: 6,
            height: 7,
            fill: call.close >= call.open ? T.up : T.down,
            opacity: 0.9,
          }),
        )

      if (status === 'loading' && data === undefined) {
        return React.createElement('div', { style: { padding: 20, color: T.dim, fontFamily: MONO, background: T.bg } }, t('loading'))
      }
      if (status === 'error' && data === undefined) {
        return React.createElement(
          'div',
          { style: { padding: 20, color: T.down, fontFamily: MONO, background: T.bg } },
          failure,
          ' ',
          React.createElement('button', { type: 'button', onClick: refresh, style: buttonStyle(false, T.gold) }, '重试'),
        )
      }

      return React.createElement(
        'div',
        {
          'data-usage-kline-terminal': '',
          style: { width: '100%', height: '100%', overflow: 'auto', background: T.bg, color: T.text, fontFamily: MONO, fontSize: 12, border: `1px solid ${T.border}`, boxSizing: 'border-box' },
        },
        // title bar
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, height: 34, padding: '0 10px', background: T.panelHead, borderBottom: `1px solid ${T.border}` } },
          React.createElement('span', { style: { color: T.gold, fontWeight: 700, letterSpacing: 1 } }, '▮ 用量行情终端'),
          React.createElement('span', { style: { color: T.faint, fontSize: 10 } }, 'USAGE · TERMINAL'),
          React.createElement('span', { style: { ...tag(T.up), fontSize: 10 } }, `● 实时 ${data?.liveCount ?? 0}`),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement('span', { style: { color: T.dim, fontSize: 10 } }, '周期'),
          RANGES.map((value) =>
            React.createElement('button', { key: value, type: 'button', onClick: () => setRange(value), style: buttonStyle(range === value, T.gold) }, `${value}D`),
          ),
          React.createElement('button', { type: 'button', onClick: refresh, style: { ...buttonStyle(false, T.gold), marginLeft: 6 } }, '刷新'),
          React.createElement(
            'span',
            { style: { marginLeft: 8, textAlign: 'right', lineHeight: 1.1 } },
            React.createElement('div', { style: { color: T.white, fontSize: 13, fontWeight: 600 } }, clock.time),
            React.createElement('div', { style: { color: T.faint, fontSize: 9 } }, `${clock.date} ${clock.weekday}`),
          ),
        ),
        // body
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'stretch', gap: 6, padding: 6 } },
          // watchlist
          React.createElement(
            'div',
            { style: { width: 250, flex: 'none', background: T.panel, border: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column' } },
            React.createElement(
              'div',
              { style: head({}) },
              React.createElement('span', { style: { color: T.textHi, fontWeight: 600 } }, '自选行情'),
              React.createElement('span', { style: { color: T.faint, fontSize: 10 } }, 'WATCHLIST'),
              React.createElement('span', { style: { marginLeft: 'auto', color: T.dim, fontSize: 10 } }, `${seriesList.length} 项`),
            ),
            React.createElement(
              'div',
              { style: { display: 'grid', gridTemplateColumns: '56px 1fr 34px 58px', gap: 4, padding: '3px 8px', color: T.faint, fontSize: 10, borderBottom: `1px solid ${T.gridSoft}` } },
              React.createElement('span', null, '代码'),
              React.createElement('span', null, '模型 / 名称'),
              React.createElement('span', { style: { textAlign: 'right' } }, '走势'),
              React.createElement('span', { style: { textAlign: 'right' } }, '金额'),
            ),
            React.createElement('div', { style: { padding: '3px 8px', color: T.dim, fontSize: 10, background: T.gridSoft } }, '▌ 模型'),
            seriesList.length === 0
              ? React.createElement('div', { style: { padding: 10, color: T.dim, fontSize: 11 } }, t('empty'))
              : seriesList.map((entry, index) =>
                  React.createElement(
                    'button',
                    {
                      key: entry.model,
                      type: 'button',
                      onClick: () => setSelected(index),
                      style: { display: 'grid', gridTemplateColumns: '56px 1fr 34px 58px', gap: 4, alignItems: 'center', width: '100%', padding: '3px 8px', background: index === selected ? '#13233d' : 'transparent', border: 'none', borderLeft: `2px solid ${index === selected ? T.gold : 'transparent'}`, color: T.text, fontSize: 11, textAlign: 'left', cursor: 'pointer', fontFamily: MONO },
                    },
                    React.createElement('span', { style: { color: T.faint, fontSize: 9.5 } }, String(index + 1).padStart(6, '0')),
                    React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.model),
                    React.createElement('svg', { width: 32, height: 14 }, sparkline(entry.candles.slice(-8), 32, 14, entry.summary.change >= 0 ? T.up : T.down)),
                    React.createElement(
                      'span',
                      { style: { textAlign: 'right', lineHeight: 1.15 } },
                      React.createElement('div', null, amount(entry.summary.cost, 2)),
                      React.createElement('div', { style: { fontSize: 9, color: entry.summary.change >= 0 ? T.up : T.down } }, `${entry.summary.change >= 0 ? '+' : ''}${amount(entry.summary.change, 2)}`),
                    ),
                  ),
                ),
            React.createElement('div', { style: { padding: '3px 8px', color: T.dim, fontSize: 10, background: T.gridSoft, marginTop: 4 } }, '▌ 统计'),
            bucketRows.map((row, index) =>
              React.createElement(
                'button',
                {
                  key: row.key,
                  type: 'button',
                  onClick: () => setBucket(row.key),
                  style: { display: 'grid', gridTemplateColumns: '56px 1fr auto', gap: 4, width: '100%', padding: '2px 8px', background: bucket === row.key ? '#13233d' : index % 2 === 0 ? T.row : T.rowAlt, border: 'none', color: T.text, fontSize: 10.5, cursor: 'pointer', fontFamily: MONO, textAlign: 'left' },
                },
                React.createElement('span', { style: { color: T.faint } }, String(600519 + index)),
                React.createElement('span', { style: { color: T.dim } }, row.label),
                React.createElement('span', { style: { color: row.color, textAlign: 'right' } }, bucket === 'request' ? String(row.value) : compact(row.value)),
              ),
            ),
          ),
          // stage
          React.createElement(
            'div',
            { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: T.panel, border: `1px solid ${T.border}` } },
            React.createElement(
              'div',
              { style: head({}) },
              React.createElement('span', { style: { color: T.textHi, fontSize: 15, fontWeight: 700 } }, current === undefined ? '—' : current.model),
              React.createElement('span', { style: { color: T.faint, fontSize: 10 } }, 'USAGE'),
              React.createElement('span', { style: tag(T.gold) }, metric === 'cost' ? currency : 'TOKEN'),
              React.createElement('span', { style: { flex: 1 } }),
              React.createElement('button', { type: 'button', onClick: () => setMode('candles'), style: buttonStyle(mode === 'candles', T.gold) }, '日K'),
              React.createElement('button', { type: 'button', onClick: () => setMode('intraday'), style: buttonStyle(mode === 'intraday', T.gold) }, '分时'),
              React.createElement('button', { type: 'button', onClick: () => setMetric('cost'), style: buttonStyle(metric === 'cost', T.cyan) }, '金额'),
              React.createElement('button', { type: 'button', onClick: () => setMetric('tokens'), style: buttonStyle(metric === 'tokens', T.cyan) }, 'Token'),
            ),
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'flex-end', gap: 12, padding: '8px 10px 2px' } },
              React.createElement(
                'div',
                null,
                React.createElement('div', { style: { fontSize: 26, fontWeight: 700, color: T.down, lineHeight: 1.05 } }, amount(current === undefined ? 0 : current.summary.cost, 2)),
                React.createElement('div', { style: { color: T.dim, fontSize: 10.5, marginTop: 2 } }, '累计金额'),
              ),
              React.createElement(
                'div',
                { style: { color: dayChange >= 0 ? T.up : T.down, fontSize: 11, paddingBottom: 4 } },
                `${dayChange >= 0 ? '+' : ''}${money(dayChange, currency, 4)}`,
                React.createElement('div', { style: { fontSize: 9.5, color: T.faint } }, t('change')),
              ),
              React.createElement(
                'div',
                { style: { flex: 1, display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 6, fontSize: 10 } },
                [
                  ['今开', todayOpen, false],
                  ['最高', todayHigh, false],
                  ['最低', Number.isFinite(todayLow) ? todayLow : 0, true],
                  ['请求', totals.requests, null],
                  ['成交', todayVolume, null],
                ].map(([label, value, isLow], index) =>
                  React.createElement(
                    'div',
                    { key: label, style: { textAlign: index === 0 ? 'left' : 'right' } },
                    React.createElement('div', { style: { color: T.faint } }, label),
                    React.createElement('div', { style: { color: isLow === true ? T.down : T.text } }, index === 3 ? `${value}` : index === 4 ? compact(value) : priceOf(value, 4)),
                  ),
                ),
              ),
            ),
            React.createElement(TradingStage, {
              t,
              mode,
              metric,
              series: stage,
              height: STAGE_HEIGHTS[range] ?? 240,
              currency,
              dayLabels: mode === 'intraday' ? '今日分时' : `${range} 日 K 线`,
            }),
            React.createElement(
              'div',
              { style: { padding: '0 10px 8px', color: T.faint, fontSize: 10 } },
              lastTrade === undefined
                ? t('estimate')
                : `最后成交 ${timeOf(lastTrade.time)} · ${priceOf(lastTrade.open, 4)} · ${t('estimate')}`,
            ),
          ),
          // rankings
          React.createElement(
            'div',
            { style: { width: 280, flex: 'none', display: 'flex', flexDirection: 'column', gap: 6 } },
            React.createElement(
              'div',
              { style: { background: T.panel, border: `1px solid ${T.border}` } },
              React.createElement(
                'div',
                { style: head({}) },
                React.createElement('span', { style: { color: T.textHi, fontWeight: 600 } }, '主力动向'),
                React.createElement('span', { style: { color: T.faint, fontSize: 10 } }, '按模型'),
                React.createElement('span', { style: { marginLeft: 'auto', color: T.dim, fontSize: 10 } }, 'TOP 10'),
              ),
              rankings.slice(0, 10).map((entry, index) =>
                React.createElement(
                  'div',
                  { key: entry.model, style: { display: 'grid', gridTemplateColumns: '16px 1fr 52px', gap: 4, alignItems: 'center', padding: '3px 8px', background: index === 0 ? '#13233d' : 'transparent', fontSize: 11 } },
                  React.createElement('span', { style: { color: T.gold, fontSize: 10 } }, String(index + 1).padStart(2, '0')),
                  React.createElement(
                    'div',
                    { style: { position: 'relative', height: 16, overflow: 'hidden' } },
                    React.createElement('div', { style: { position: 'absolute', inset: '2px 0', width: `${Math.max(6, Math.round((entry.summary.cost / leader) * 100))}%`, background: entry.summary.change >= 0 ? T.upDim : T.downDim, opacity: 0.22 } }),
                    React.createElement('span', { style: { position: 'absolute', left: 4, top: 1, color: T.text } }, entry.model),
                  ),
                  React.createElement('span', { style: { color: T.down, textAlign: 'right', fontSize: 10.5 } }, money(entry.summary.cost, currency, 2)),
                ),
              ),
              React.createElement('div', { style: { padding: '4px 8px', color: T.dim, fontSize: 10, borderTop: `1px solid ${T.border}` } }, `合计 ${money(totals.cost, currency, 2)} · ${totals.requests} 笔`),
            ),
            React.createElement(
              'div',
              { style: { background: T.panel, border: `1px solid ${T.border}`, flex: 1, display: 'flex', flexDirection: 'column' } },
              React.createElement(
                'div',
                { style: head({}) },
                React.createElement('span', { style: { color: T.textHi, fontWeight: 600 } }, '逐笔成交'),
                React.createElement('span', { style: { color: T.faint, fontSize: 10 } }, 'LIVE TAPE'),
                React.createElement('span', { style: { marginLeft: 'auto', color: T.dim, fontSize: 10 } }, `${positions.length}`),
              ),
              recentTicks.length === 0
                ? React.createElement('div', { style: { padding: 10, color: T.dim, fontSize: 11 } }, t('empty'))
                : recentTicks.map((position, index) =>
                    React.createElement(
                      'div',
                      { key: `${position.time}-${index}`, style: { display: 'flex', gap: 6, padding: '2px 8px', fontSize: 10.5, background: index % 2 === 0 ? T.row : T.rowAlt } },
                      React.createElement('span', { style: { color: T.down } }, timeOf(position.time)),
                      React.createElement('span', { style: { color: T.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, position.model),
                      React.createElement('span', { style: { color: metric === 'cost' ? T.up : T.gold } }, priceOf(position.cost, 4)),
                    ),
                  ),
            ),
          ),
        ),
        // secondary table
        React.createElement(
          'div',
          { style: { margin: '0 6px 6px', background: T.panel, border: `1px solid ${T.border}` } },
          React.createElement(
            'div',
            { style: head({}) },
            React.createElement('span', { style: { color: T.textHi, fontWeight: 600 } }, '个股列表'),
            React.createElement('span', { style: { color: T.faint, fontSize: 10 } }, '按模型统计'),
            React.createElement('span', { style: { color: T.dim, fontSize: 10 } }, `${seriesList.length} 个模型 · ${data?.logs ?? 0} 个会话`),
            React.createElement('span', { style: { flex: 1 } }),
            RANGES.map((value) =>
              React.createElement('button', { key: value, type: 'button', onClick: () => setRange(value), style: buttonStyle(range === value, T.gold) }, `${value}D`),
            ),
          ),
          React.createElement(
            'div',
            { style: { display: 'grid', gridTemplateColumns: '70px minmax(110px, 1.4fr) 90px 90px 70px 80px 64px 110px', gap: 8, padding: '4px 8px', color: T.faint, fontSize: 10, borderBottom: `1px solid ${T.gridSoft}` } },
            React.createElement('span', null, '代码'),
            React.createElement('span', null, '名称 / 模型'),
            React.createElement('span', { style: { textAlign: 'right' } }, '累计金额'),
            React.createElement('span', { style: { textAlign: 'right' } }, '涨跌'),
            React.createElement('span', { style: { textAlign: 'right' } }, '请求数'),
            React.createElement('span', { style: { textAlign: 'right' } }, 'Token'),
            React.createElement('span', { style: { textAlign: 'right' } }, '占比'),
            React.createElement('span', { style: { textAlign: 'center' } }, 'K线走势'),
          ),
          seriesList.length === 0
            ? React.createElement('div', { style: { padding: '14px 10px', color: T.dim, fontSize: 11 } }, t('empty'))
            : seriesList.map((entry, index) =>
                React.createElement(
                  'button',
                  {
                    key: entry.model,
                    type: 'button',
                    onClick: () => setSelected(index),
                    style: { display: 'grid', gridTemplateColumns: '70px minmax(110px, 1.4fr) 90px 90px 70px 80px 64px 110px', gap: 8, width: '100%', alignItems: 'center', padding: '4px 8px', background: index === selected ? '#13233d' : index % 2 === 0 ? T.row : T.rowAlt, border: 'none', color: T.text, fontSize: 11, cursor: 'pointer', fontFamily: MONO, textAlign: 'left' },
                  },
                  React.createElement('span', { style: { color: T.faint } }, String(600011 + index)),
                  React.createElement('span', { style: { color: T.gold } }, `★ ${entry.model}`),
                  React.createElement('span', { style: { textAlign: 'right' } }, money(entry.summary.cost, currency, 4)),
                  React.createElement('span', { style: { textAlign: 'right', color: entry.summary.change >= 0 ? T.up : T.down } }, `${entry.summary.change >= 0 ? '▲' : '▼'}${amount(Math.abs(entry.summary.change), 4)}`),
                  React.createElement('span', { style: { textAlign: 'right', color: T.dim } }, String(entry.summary.requests)),
                  React.createElement('span', { style: { textAlign: 'right', color: T.dim } }, compact(entry.summary.tokens)),
                  React.createElement('span', { style: { textAlign: 'right', color: T.cyan } }, `${totals.cost <= 0 ? '0.0' : ((entry.summary.cost / totals.cost) * 100).toFixed(1)}%`),
                  React.createElement('svg', { width: 96, height: 14 }, stampCells(entry.todayCandles)),
                ),
              ),
        ),
        // The flat "对话用量" table is intentionally not rendered: the
        // per-Workspace ranking below covers every conversation with the same
        // ID, spend and token columns.
        // per-turn table for the open conversation
        React.createElement(TurnTable, { t, turns, currency, metric }),
        // ranking of every conversation of the selected Workspace
        React.createElement(WorkspaceRanking, {
          t,
          data,
          currency,
          onJump: openSession,
          onDelete: async (sessionId) => {
            const result = await deleteConversation(sessionId)
            if (result.ok === true) setNonce((value) => value + 1)
            return result
          },
          onOpenTab: () => openVia(pageContextHolder),
          listHeight: 260,
        }),
        // cross-source comparison of everything the Harness can show
        React.createElement(OverviewCompare, { t, data, account, currency, range }),
        // status bar
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 12, alignItems: 'center', padding: '3px 10px', color: T.faint, fontSize: 10, borderTop: `1px solid ${T.border}`, background: T.panelHead } },
          React.createElement('span', null, `采样 ${data?.liveCount ?? 0} 条实时`),
          React.createElement('span', null, `会话 ${data?.logs ?? 0}`),
          React.createElement('span', null, '状态 已连接'),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement('span', { style: { color: data?.peakNow === true ? T.down : T.up } }, data?.peakNow === true ? '计价 · 高峰时段' : '计价 · 空闲时段'),
          React.createElement('span', null, data?.error === undefined ? '数据 正常' : `数据 异常：${data.error}`),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Locale dictionaries; the slot owners pass a manifest-bound `t` prop.
    // ---------------------------------------------------------------------
    const zh = {
      title: '用量行情',
      open: '打开用量行情',
      loading: '正在加载用量…',
      empty: '该范围内暂无用量记录',
      estimate: '金额按官方单价估算，非实际账单',
      change: '较前一日',
      open: '开',
      high: '高',
      low: '低',
      close: '收',
      volume: '量',
    }
    const en = {
      title: 'Usage chart',
      open: 'Open the usage chart',
      loading: 'Loading usage…',
      empty: 'No usage recorded in this range yet.',
      estimate: 'Prices are estimates from official rates, not a bill.',
      change: 'vs previous day',
      open: 'Open',
      high: 'High',
      low: 'Low',
      close: 'Close',
      volume: 'Vol',
    }

    function interpolate(text, params) {
      if (text === undefined || text === null) return ''
      if (params === undefined) return String(text)
      return String(text).replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole))
    }

    function bindLocale(ctx) {
      let locale
      try {
        locale = ctx.get('locale')
      } catch (error) {
        void error
        locale = undefined
      }
      if (locale === undefined || locale === null) {
        return () => (key) => interpolate(zh[key] ?? key)
      }
      try {
        const dispose = locale.register('usage-kline', { zh, en })
        if (typeof dispose === 'function') ctx.effect(() => dispose, 'usage-kline: locale dictionary')
      } catch (error) {
        void error
      }
      return () => {
        try {
          const bound = locale.bind('usage-kline')
          return (key) => interpolate(bound(key))
        } catch {
          return (key) => interpolate(zh[key] ?? key)
        }
      }
    }

    const PANEL_KIND = 'usage-kline'
    const TAB_ID = 'dsh-usage-kline/tab'
    const PANEL_ID = 'usage-kline'
    const SLOT_NAMES = ['sidebar.panellist', 'main', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'conversation.composer.dock']

    function hasSlot(ctx, name) {
      let slots
      try {
        slots = ctx.get('slots')
      } catch (error) {
        void error
        return undefined
      }
      if (slots === undefined || slots === null || typeof slots.declare !== 'function') return undefined
      try {
        slots.declare(name)
        return true
      } catch (error) {
        void error
        return false
      }
    }

    function CandleGlyph({ size = 14 }) {
      return React.createElement(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true, style: { flex: 'none' } },
        React.createElement('line', { x1: 3.5, y1: 2, x2: 3.5, y2: 6, stroke: '#2ee6a0', strokeWidth: 1.2 }),
        React.createElement('rect', { x: 2, y: 6.5, width: 3, height: 4, rx: 0.5, fill: 'none', stroke: '#2ee6a0', strokeWidth: 1.1 }),
        React.createElement('line', { x1: 3.5, y1: 10.5, x2: 3.5, y2: 14, stroke: '#2ee6a0', strokeWidth: 1.2 }),
        React.createElement('line', { x1: 8, y1: 3, x2: 8, y2: 7, stroke: '#ff4d6a', strokeWidth: 1.2 }),
        React.createElement('rect', { x: 6.5, y: 7.5, width: 3, height: 4, rx: 0.5, fill: '#ff4d6a' }),
        React.createElement('line', { x1: 8, y1: 11.5, x2: 8, y2: 14.5, stroke: '#ff4d6a', strokeWidth: 1.2 }),
        React.createElement('line', { x1: 12.5, y1: 4, x2: 12.5, y2: 7, stroke: '#2ee6a0', strokeWidth: 1.2 }),
        React.createElement('rect', { x: 11, y: 7.5, width: 3, height: 3.5, rx: 0.5, fill: 'none', stroke: '#2ee6a0', strokeWidth: 1.1 }),
        React.createElement('line', { x1: 12.5, y1: 11, x2: 12.5, y2: 13.5, stroke: '#2ee6a0', strokeWidth: 1.2 }),
      )
    }

    function openVia(ctx, options) {
      try {
        const tabs = ctx.get('sidebarRightTabs')
        if (tabs !== undefined && tabs !== null && typeof tabs.openTab === 'function') {
          return Promise.resolve(tabs.openTab(PANEL_KIND, { revealIfOpened: true, ...(options ?? {}) }))
        }
        const layout = ctx.get('layout')
        layout?.openRightbar?.(true, false)
      } catch (error) {
        void error
      }
      return Promise.resolve()
    }

    function installTabType(ctx, t) {
      let tabs
      try {
        tabs = ctx.get('sidebarRightTabs')
      } catch (error) {
        void error
        return false
      }
      if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') return false
      try {
        ctx.effect(
          () => tabs.register({ id: TAB_ID, kind: PANEL_KIND, priority: 'extension', title: () => t('title'), keepMounted: true }),
          'usage-kline: workspace tab type',
        )
        return true
      } catch (error) {
        void error
        return false
      }
    }

    /**
     * The chip under the composer: recharged balance as a green negative, the
     * usable balance (recharged + granted) as a red positive, and today's spend.
     */
    function DockButton({ t, ctx }) {
      const summary = useSummary()
      const [busy, setBusy] = useState(false)
      const account = summary?.account
      const currency = summary?.overview?.currency ?? 'CNY'
      const usable = (account?.usable ?? []).find((entry) => entry.currency === currency) ?? (account?.usable ?? [])[0]
      const charged = usable?.charged ?? 0
      const usableTotal = usable === undefined ? undefined : (usable.charged ?? 0) + (usable.granted ?? 0)
      const series = summary?.overview?.series ?? []
      const total = series.reduce((sum, entry) => sum + entry.summary.cost, 0)
      const activate = () => {
        setBusy(true)
        Promise.resolve(openVia(ctx)).finally(() => setBusy(false))
      }
      const balanceChip = (value, tone, label) =>
        React.createElement(
          'span',
          { style: { color: tone, fontWeight: 600, marginRight: 2 } },
          value === undefined ? label : `${value >= 0 ? '+' : '-'}${money(Math.abs(value), currency ?? 'CNY', 2)}`,
        )
      return React.createElement(
        'div',
        { style: { display: 'flex', justifyContent: 'center', pointerEvents: 'auto', padding: '2px 0' }, 'data-usage-kline-chip': '' },
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: activate,
            disabled: busy,
            title: t('open'),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 22,
              padding: '0 9px',
              borderRadius: 999,
              border: `1px solid ${T.border}`,
              background: T.bg,
              color: T.text,
              fontSize: 11,
              cursor: 'pointer',
              fontFamily: MONO,
              whiteSpace: 'nowrap',
            },
          },
          React.createElement(CandleGlyph, { size: 12 }),
          balanceChip(usableTotal === undefined ? undefined : -usableTotal, T.up, t('title')),
          React.createElement('span', { style: { color: T.faint } }, '|'),
          balanceChip(charged, T.down, t('title')),
          React.createElement('span', { style: { color: T.dim } }, `· ${amount(total, 2)}`),
        ),
      )
    }

    function apply(ctx) {
      const dictionary = bindLocale(ctx)
      const t = (key, params) => dictionary()(key, params)
      const slots = ctx.get('slots')
      pageContextHolder = ctx

      ctx.effect(
        () =>
          slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => 'Usage K-line' },
            (props) => React.createElement(CandleGlyph, { size: props?.size ?? 16 }),
          ),
        'usage-kline: workspace-strip icon',
      )

      ctx.effect(
        () =>
          slots.register({ name: 'main', key: PANEL_ID, locale: 'usage-kline' }, ({ t: bound }) =>
            React.createElement('div', { style: { width: '100%', height: '100%', overflow: 'hidden', boxSizing: 'border-box', padding: 8 } }, React.createElement(UsageChartPage, { t: bound ?? t })),
          ),
        'usage-kline: main-column page',
      )

      ctx.effect(
        () => slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, ({ t: bound, sessionId }) =>
          React.createElement('div', { style: { width: '100%', height: '100%', overflow: 'hidden', padding: 6, boxSizing: 'border-box' } }, React.createElement(UsageChartPage, { t: bound ?? t, sessionId })),
        ),
        'usage-kline: workspace tab body',
      )
      ctx.effect(
        () => slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, ({ t: bound }) => bound('title')),
        'usage-kline: workspace tab title',
      )

      installTabType(ctx, t)

      ctx.effect(
        () =>
          slots.register({ name: 'conversation.composer.dock', id: 'usage-kline', order: 40, locale: 'usage-kline' }, ({ t: bound }) =>
            React.createElement(DockButton, { t: bound ?? t, ctx }),
          ),
        'usage-kline: composer dock entry',
      )

      return { hasSlot: (name) => hasSlot(ctx, name), open: () => openVia(ctx), slots: SLOT_NAMES.slice() }
    }

    return { apply, UsageChartPage }
  },
})
