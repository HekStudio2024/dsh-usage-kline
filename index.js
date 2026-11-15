/**
 * DeepSeek usage K-line — Host half.
 *
 * Serves the Client half over an admitted `webServer` prefix route:
 *   GET /dsh-usage-kline/api/overview?days=30  per-day and per-call usage
 *   GET /dsh-usage-kline/api/balance           Platform account balance
 *   GET /dsh-usage-kline/api/events            Server-Sent Events revision feed
 *
 * The durable source is the per-Session projection checkpoint that
 * `session-projection-cache` keeps under `$DSH_HOME/storages/session_projcache`:
 * it already holds the `tokenUsage` fold of every logged provider usage record,
 * so one small file per Session replaces replaying the whole compressed log.
 * Calls made after a Session was last checkpointed are recorded live through
 * the `llm/stream` waterfall (and the `web` service for Search/Fetch), so the
 * current day keeps moving without rescanning. Nothing here writes Session
 * events or touches model input.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const inject = ['connection', 'webServer']

// Defaults of every field the Host config may set. The row's config is read
// through `ctx.fiber.entry.config`; resolved defaults are not declared here.
export const DEFAULT_CONFIG = {
  currency: 'CNY',
  priceMode: 'auto',
  includeSubagentSessions: true,
  liveRequestCount: 20000,
  scanConcurrency: 6,
  checkpointDir: '',
  prices: {},
}

export const API = '/dsh-usage-kline/api'

// ---------------------------------------------------------------------------
// Pricing, per 1M tokens for the currency the panel displays. `CNY` holds the
// official list price; `USD` (the official USD table, or CNY converted) is
// held in its own table and picked by `currency`.
// ---------------------------------------------------------------------------

export const PRICES = {
  CNY: {
    'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    'deepseek-v4-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    'deepseek-v4-flash-vision-exp': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  },
  USD: {
    'deepseek-flash': { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
    'deepseek-v4-flash': { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
    'deepseek-v4-flash-vision-exp': { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
    'deepseek-v4-pro': { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
  },
}
/** Retained alias of the USD table. */
export const DEFAULT_PRICES = PRICES.USD
const DEFAULT_WEB_COST = { 'deepseek-web-search': 5, 'deepseek-web-fetch': 5 }
const DEFAULT_WEB_COST_USD = { 'deepseek-web-search': 0.75, 'deepseek-web-fetch': 0.75 }
const PEAK_UTC_HOURS = [
  [1, 4],
  [6, 10],
]
const DAY_MS = 86_400_000
const RANGES = [7, 14, 30, 60, 90]
const LIVE_KEEP_DAYS = 120
const STATIC_SOURCE_WORDS = ['session title', 'title', 'goal', 'subagent', 'workflow', 'compaction', 'summary']
const NON_BILLED_PROVIDERS = ['deepseek-account']

/** Whether an instant falls into a peak-pricing window (UTC). */
export function isPeak(time) {
  const date = new Date(time)
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60
  return PEAK_UTC_HOURS.some(([start, end]) => hour >= start && hour < end)
}

/** Calendar-day key (YYYY-MM-DD) for one instant, measured from a zone offset. */
function dayKey(time, offsetMs) {
  return new Date(time + offsetMs).toISOString().slice(0, 10)
}

function shiftDay(key, delta) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10)
}

function emptyBuckets() {
  return { cacheRead: 0, cacheWrite: 0, uncached: 0, output: 0 }
}

function addBuckets(target, source) {
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.uncached += source.uncached
  target.output += source.output
  return target
}

function bucketsTotal(buckets) {
  return buckets.cacheRead + buckets.cacheWrite + buckets.uncached + buckets.output
}

/**
 * Normalizes a provider usage record or a token-usage total. Both the stream
 * `TokenUsage` (`inputTokens`, cache reads excluded) and the projection totals
 * (`uncachedInputTokens`) describe the same billed buckets.
 */
function bucketsOf(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const rawInput = usage.inputTokens ?? usage.uncachedInputTokens
  const input = Number(rawInput)
  const output = Number(usage.outputTokens)
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined
  return {
    cacheRead: Number(usage.cacheReadTokens) || 0,
    cacheWrite: Number(usage.cacheWriteTokens) || 0,
    uncached: input,
    output,
  }
}

/** The last usage sample carried by an assistant stream record list. */
function usageFromStream(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record === null || typeof record !== 'object') continue
    if (record.type !== 'chunk') continue
    const chunk = record.chunk
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'usage') return bucketsOf(chunk.usage)
    if (chunk.type === 'finish') return undefined
  }
  return undefined
}

function usageFromEventData(data) {
  if (data === null || typeof data !== 'object') return undefined
  if (data.usage !== undefined) {
    const direct = bucketsOf(data.usage)
    if (direct !== undefined) return direct
  }
  return usageFromStream(data.stream)
}

/** Display label of a provider/model route. */
function routeLabel(provider, model) {
  if (model === undefined || model === '' || model === 'unknown') return 'unknown'
  if (provider === undefined || provider === '' || provider === 'deepseek-account' || provider === 'deepseek-official') {
    return model
  }
  return `${provider}/${model}`
}

/** Price entry of one provider/model route, or `undefined` when unpriced. */
function priceEntry(prices, provider, model) {
  const entry = prices[`${provider}/${model}`] ?? prices[model] ?? (provider === undefined ? undefined : prices[provider])
  if (entry !== undefined) return entry
  return provider !== undefined && provider.includes('deepseek') ? DEFAULT_PRICES[model] : undefined
}

/**
 * Cost of one call in the display currency; unpriced routes are collected
 * instead of guessed. Web Search/Fetch bill per successful request.
 */
function costOfCall(call, prices, webCost, mode, unpriced) {
  if (call.isWeb === true) {
    const unit = webCost[call.model]
    return unit === undefined ? 0 : unit / 1000
  }
  const entry = priceEntry(prices, call.provider, call.model)
  if (entry === undefined) {
    unpriced.add(routeLabel(call.provider, call.model))
    return undefined
  }
  const factor = mode === 'peak' ? 1 : mode === 'offpeak' ? 0.5 : isPeak(call.time) ? 1 : 0.5
  const cost =
    (Number(call.cacheRead || 0) * Number(entry.cacheHit) +
      Number(call.uncached || 0) * Number(entry.cacheMiss) +
      Number(call.output || 0) * Number(entry.output)) *
    factor /
    1e6
  if (isNaN(cost) || !isFinite(cost)) throw new Error('cost is not finite')
  return cost
}

/**
 * One call per settled model request of a Session event list. A step reports
 * usage twice (attempt settlement, finalized message); the finalized sample
 * replaces the attempt's sample of the same step, and sessions whose latest
 * request routes to an unpriceable provider are skipped.
 * @returns calls attributed to a priceable route only
 */
export function callsOfEventList(events, prices = DEFAULT_PRICES) {
  const samples = []
  let model = 'unknown'
  let provider = 'unknown'
  let priced = false
  let staticSource = false
  const noteRoute = (config) => {
    if (config === null || typeof config !== 'object') return
    if (typeof config.model === 'string') model = config.model
    if (typeof config.provider === 'string') provider = config.provider
    priced = priceEntry(prices, provider, model) !== undefined
  }
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    switch (event.type) {
      case 'request/header':
        noteRoute(event.data?.header?.config)
        if (typeof event.data?.purpose === 'string') {
          const purpose = event.data.purpose.toLowerCase()
          if (STATIC_SOURCE_WORDS.some((word) => purpose.includes(word))) staticSource = true
        }
        continue
      case 'request/context':
        noteRoute(event.data)
        continue
      case 'assistant/message':
      case 'assistant/attempt': {
        if (staticSource) continue
        const sample = usageFromEventData(event.data)
        if (sample === undefined) continue
        samples.push({
          step: Number(event.data?.step) || 0,
          time: Number(event.time) || 0,
          final: event.type === 'assistant/message',
          model,
          provider,
          priced,
          ...sample,
        })
        continue
      }
      default:
        continue
    }
  }
  const calls = []
  for (const sample of samples) {
    if (sample.priced !== true) continue
    if (bucketsTotal(sample) === 0) continue
    const previous = calls[calls.length - 1]
    if (previous !== undefined && previous.step === sample.step && !previous.final) {
      calls[calls.length - 1] = sample
      continue
    }
    if (previous !== undefined && previous.final && previous.step === sample.step) continue
    calls.push(sample)
  }
  return calls
}

/** Reads one JSON file, or `undefined` when it is missing or malformed. */
async function readJson(path) {
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Provider/model route of a Session checkpoint's newest request. */
function latestRoute(rows, measurement) {
  const anchor = measurement?.anchor
  const anchorModel = anchor?.model ?? anchor?.config?.model
  const anchorProvider = anchor?.provider ?? anchor?.config?.provider
  if (typeof anchorModel === 'string' && anchorModel !== '') {
    return { model: anchorModel, provider: typeof anchorProvider === 'string' ? anchorProvider : 'deepseek-account' }
  }
  const lastUsed = rows.modelSelection?.val?.lastUsed
  if (typeof lastUsed?.model === 'string' && lastUsed.model !== '') {
    return { model: lastUsed.model, provider: typeof lastUsed.provider === 'string' ? lastUsed.provider : 'deepseek-account' }
  }
  const pending = rows.modelSelection?.val?.pending
  if (typeof pending?.model === 'string' && pending.model !== '') {
    return { model: pending.model, provider: typeof pending.provider === 'string' ? pending.provider : 'deepseek-account' }
  }
  return undefined
}

export function apply(ctx) {
  const option = (key, fallback) => {
    const raw = ctx?.fiber?.entry?.config?.[key]
    if (raw !== undefined && typeof raw.get === 'function') return raw.get()
    if (raw !== undefined) return raw
    return fallback
  }
  /** Prices of the display currency, with the row's overrides applied. */
  const priceTable = (currency) => ({
    ...(PRICES[currency] ?? PRICES.CNY),
    ...(option('prices', {}) ?? {}),
  })
  const webCostTable = (currency) => (currency === 'USD' ? DEFAULT_WEB_COST_USD : DEFAULT_WEB_COST)
  const live = []
  const listeners = new Set()
  const eventClients = new Set()
  let notifyTimer
  let revision = 0
  let scan
  let closed = false
  /**
   * Sessions the user removed from this panel. Archiving moves a Session out of
   * the Workspace list, but its checkpoint file stays on disk, so the scan would
   * surface it again; these ids are filtered out and persisted in $DSH_HOME.
   */
  const removedSessions = new Set()
  let removedLoaded = false
  const removedFile = () => {
    const { home } = resolveHome()
    return home === '' ? '' : join(home, 'usage-kline-removed.json')
  }
  const loadRemoved = async () => {
    if (removedLoaded) return
    removedLoaded = true
    const file = removedFile()
    if (file === '') return
    const stored = await readJson(file)
    if (!Array.isArray(stored?.sessions)) return
    for (const id of stored.sessions) if (typeof id === 'string') removedSessions.add(id)
  }
  const saveRemoved = async () => {
    const file = removedFile()
    if (file === '') return false
    try {
      await writeFile(file, JSON.stringify({ version: 1, sessions: [...removedSessions] }, null, 2), 'utf8')
      return true
    } catch (error) {
      void error
      return false
    }
  }
  const hideSession = async (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    await loadRemoved()
    removedSessions.add(sessionId)
    return saveRemoved()
  }

  /**
   * Resolves `$DSH_HOME` the way the Host itself does, with fallbacks: the
   * packaged Desktop process does not always carry the variable, and an empty
   * answer would silently scan nothing.
   */
  const resolveHome = () => {
    const candidates = [
      ['DSH_HOME', process.env.DSH_HOME],
      ['DSH_PROFILE_DIR/../..', process.env.DSH_PROFILE_DIR === undefined || process.env.DSH_PROFILE_DIR.trim() === '' ? undefined : join(process.env.DSH_PROFILE_DIR.trim(), '..', '..')],
      ['USERPROFILE\\.dsh', process.env.USERPROFILE === undefined ? undefined : join(process.env.USERPROFILE, '.dsh')],
      ['homedir/.dsh', (() => {
        try {
          return join(homedir(), '.dsh')
        } catch (error) {
          void error
          return undefined
        }
      })()],
      ['APPDATA', process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, '.dsh')],
    ]
    for (const [source, value] of candidates) {
      if (typeof value !== 'string' || value.trim() === '') continue
      try {
        if (existsSync(value)) return { home: value, source }
      } catch (error) {
        void error
      }
    }
    const first = candidates.find(([, value]) => typeof value === 'string' && value.trim() !== '')
    return first === undefined ? { home: '', source: 'none' } : { home: first[1], source: first[0] }
  }

  const checkpointDirectory = () => {
    const override = String(option('checkpointDir', '') ?? '').trim()
    if (override !== '') return override
    const { home } = resolveHome()
    if (home !== '') return join(home, 'storages', 'session_projcache', 'sessions')
    return ''
  }

  /** Environment facts the scan depends on, for diagnosing an empty table. */
  const scanDiagnostics = async () => {
    const directory = checkpointDirectory()
    const resolved = resolveHome()
    const report = { directory, dshHome: process.env.DSH_HOME ?? null, homeSource: resolved.source, cwd: process.cwd(), files: 0, readable: 0, malformed: 0, error: undefined }
    if (directory === '') return report
    try {
      const names = (await readdir(directory)).filter((name) => typeof name === 'string' && name.endsWith('.json'))
      report.files = names.length
      let cursor = 0
      const worker = async () => {
        for (;;) {
          const index = cursor
          cursor += 1
          if (index >= names.length) return
          const document = await readJson(join(directory, names[index]))
          if (document === undefined) report.malformed += 1
          else report.readable += 1
        }
      }
      await Promise.all(Array.from({ length: Math.min(8, Math.max(1, names.length)) }, worker))
    } catch (error) {
      report.error = String(error?.message ?? error)
    }
    return report
  }

  /** Notifies the EventSource clients and the in-process listeners. */
  const publish = () => {
    if (closed) return
    revision += 1
    const frame = `data: ${JSON.stringify({ revision })}\n\n`
    for (const client of eventClients) {
      try {
        client.write(frame)
      } catch (error) {
        void error
      }
    }
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        void error
      }
    }
  }
  const schedulePublish = () => {
    if (notifyTimer !== undefined) return
    notifyTimer = setTimeout(() => {
      notifyTimer = undefined
      publish()
    }, 800)
    notifyTimer.unref?.()
  }

  const rememberLive = (call) => {
    const limit = Math.max(100, Number(option('liveRequestCount', 20000)) || 20000)
    const cutoff = Date.now() - LIVE_KEEP_DAYS * DAY_MS
    live.push(call)
    let drop = 0
    while (drop < live.length && (live.length - drop > limit || (live[drop]?.time ?? 0) < cutoff)) drop += 1
    if (drop > 0) live.splice(0, drop)
    schedulePublish()
  }

  const stopLive = ctx.on('llm/stream', (request, next) => {
    const startedAt = Date.now()
    const model = typeof request?.model === 'string' ? request.model : 'unknown'
    const provider = typeof request?.provider === 'string' ? request.provider : 'unknown'
    const purpose = typeof request?.purpose === 'string' ? request.purpose.toLowerCase() : ''
    const billable = !STATIC_SOURCE_WORDS.some((word) => purpose.includes(word))
    const relay = async function* relayed() {
      let usage
      for await (const chunk of next()) {
        if (chunk?.type === 'usage') usage = bucketsOf(chunk.usage)
        yield chunk
      }
      if (usage !== undefined && billable) {
        rememberLive({ time: startedAt, model, provider, isWeb: false, ...usage })
      }
    }
    return relay()
  })

  // Search and Fetch are billed per successful request and expose no usage.
  const web = ctx.get?.('web')
  let restoreWeb
  if (web !== undefined && web !== null && typeof web.search === 'function' && typeof web.fetch === 'function') {
    const originalSearch = web.search
    const originalFetch = web.fetch
    const wrap = (original, model) =>
      function recorded(...args) {
        return Promise.resolve(original.apply(web, args)).then((result) => {
          if (result !== null && typeof result === 'object') {
            rememberLive({ time: Date.now(), model, provider: 'deepseek', isWeb: true, ...emptyBuckets() })
          }
          return result
        })
      }
    web.search = wrap(originalSearch, 'deepseek-web-search')
    web.fetch = wrap(originalFetch, 'deepseek-web-fetch')
    restoreWeb = () => {
      web.search = originalSearch
      web.fetch = originalFetch
    }
  }

  const attempt = (read) => {
    try {
      return read()
    } catch (error) {
      void error
      return undefined
    }
  }

  /**
   * Calls of every persisted Session, read from the projection checkpoint.
   * The checkpoint keeps whole-Session totals, so a Session contributes one
   * call placed where its newest checkpointed request was logged.
   */
  /** The Session id a checkpoint file belongs to. */
  const sessionIdOfFile = (name) => {
    const match = /^session-([0-9a-fA-F-]{8,})\.json$/.exec(name)
    return match === null ? name.replace(/\.json$/, '') : `session-${match[1]}`
  }

  /**
   * Calls of every persisted Session, read from the projection checkpoint.
   * The checkpoint keeps whole-Session totals, so a Session contributes one
   * call placed where its newest checkpointed request was logged. Each call
   * also carries the Session id it came from, which the per-conversation table
   * groups on.
   */
  const callsOfCheckpoints = async () => {
    const directory = checkpointDirectory()
    if (directory === '') return []
    let files
    try {
      files = await readdir(directory)
    } catch (error) {
      void error
      return []
    }
    const includeSubagents = Boolean(option('includeSubagentSessions', true))
    const concurrency = Math.max(1, Math.min(16, Number(option('scanConcurrency', 6)) || 6))
    const gathered = []
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= files.length) return
        const name = files[index]
        if (typeof name !== 'string' || !name.endsWith('.json')) continue
        const document = await readJson(join(directory, name))
        const record = document?.record
        const identity = record?.identity
        const rows = record?.rows
        if (rows === undefined || rows === null) continue
        const createdAt = Number(identity?.createdAt) || 0
        const measurement = rows.tokenMeasurement?.val
        const totals = rows.tokenUsage?.val?.totals
        const usage = totals ?? bucketsOf(measurement?.anchor?.usage)
        const buckets = bucketsOf(usage)
        if (buckets === undefined || bucketsTotal(buckets) === 0) continue
        const route = latestRoute(rows, measurement)
        if (route === undefined) continue
        if (!includeSubagents && identity?.origin === 'subagent') continue
        if (priceEntry(priceTable('CNY'), route.provider, route.model) === undefined) continue
        // The checkpoint keeps whole-Session totals, so the Session is placed at
        // its newest request: the anchor's recorded time, else the file mtime.
        const time = Number(measurement?.anchor?.time) || (await attemptStat(join(directory, name))) || createdAt
        gathered.push({
          time,
          model: route.model,
          provider: route.provider,
          isWeb: false,
          sessionId: sessionIdOfFile(name),
          isSubagent: identity?.origin === 'subagent',
          ...buckets,
        })
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, files.length)) }, worker))
    return gathered
  }

  const attemptStat = async (path) => {
    try {
      const info = await stat(path)
      return Number(info.mtimeMs) || 0
    } catch {
      return 0
    }
  }

  /**
   * The filesystem-free fallback: the same per-Session token totals read from
   * the projection registry and the persisted session corpus instead of the
   * checkpoint directory. It runs whenever the checkpoint scan finds nothing,
   * so a Host whose checkpoint path is unreachable still lists conversations.
   */
  const callsOfProjections = async () => {
    const query = ctx.get?.('sessionQuery')
    const projections = ctx.get?.('sessionProjections')
    if (query === undefined || query === null || projections === undefined || projections === null) return []
    let records = []
    try {
      records = await query.listSessions()
    } catch (error) {
      void error
      return []
    }
    const includeSubagents = Boolean(option('includeSubagentSessions', true))
    const gathered = []
    for (const record of records ?? []) {
      const header = record?.header ?? {}
      const id = header.id
      if (id === undefined) continue
      if (removedSessions.has(id)) continue
      if (!includeSubagents && header.origin === 'subagent') continue
      let observation
      try {
        observation = await query.observeSession(id)
      } catch (error) {
        void error
        continue
      }
      try {
        const session = observation?.session
        if (session === undefined || session === null) continue
        const totals = projections.snapshot(session, ['tokenUsage'])?.values?.tokenUsage
        const buckets = bucketsOf(totals?.totals ?? totals)
        if (buckets === undefined || bucketsTotal(buckets) === 0) continue
        const events = attempt(() => session.snapshotEvents()) ?? []
        let model = 'unknown'
        let provider = 'deepseek-account'
        let lastCall = 0
        for (const event of events) {
          if (event?.type === 'request/header' || event?.type === 'request/context') {
            const config = event.type === 'request/header' ? event.data?.header?.config : event.data
            if (typeof config?.model === 'string') model = config.model
            if (typeof config?.provider === 'string') provider = config.provider
            continue
          }
          if (event?.type === 'assistant/message') lastCall = Number(event.time) || lastCall
        }
        if (priceEntry(priceTable('CNY'), provider, model) === undefined) continue
        const time = lastCall || Number(header.createdAt) || 0
        gathered.push({ time, model, provider, isWeb: false, sessionId: String(id), isSubagent: header.origin === 'subagent', ...buckets })
      } finally {
        attempt(() => observation?.disable?.())
        attempt(() => observation?.[Symbol.dispose]?.())
      }
    }
    return gathered
  }

  const freshScan = () => {
    if (scan !== undefined) return scan
    scan = loadRemoved()
      .catch(() => undefined)
      .then(() => callsOfCheckpoints())
      .catch((error) => ({ calls: [], error: error }))
      .then(async (value) => {
        const result = Array.isArray(value) ? { calls: value } : value
        const listed = Array.isArray(result?.calls) && result.calls.length > 0
          ? result
          : { ...result, calls: await callsOfProjections().catch(() => []) }
        // A removed conversation never returns, however its log is discovered.
        let calls = listed.calls
        if (removedSessions.size > 0) calls = calls.filter((call) => !removedSessions.has(call.sessionId))
        return { ...listed, calls, removed: removedSessions.size }
      })
      .finally(() => {
        scan = undefined
      })
    return scan
  }

  /** Builds one candle from the calls of one day for one model. */
  const candleOf = (list) => ({
    open: list[0].cost,
    close: list[list.length - 1].cost,
    high: list.reduce((peak, call) => Math.max(peak, call.cost), 0),
    low: list.reduce((trough, call) => Math.min(trough, call.cost), Number.POSITIVE_INFINITY),
    sum: list.reduce((total, call) => total + call.cost, 0),
    openTokens: list[0].tokens,
    closeTokens: list[list.length - 1].tokens,
    highTokens: list.reduce((peak, call) => Math.max(peak, call.tokens), 0),
    lowTokens: list.reduce((trough, call) => Math.min(trough, call.tokens), Number.POSITIVE_INFINITY),
    tokens: list.reduce((total, call) => total + call.tokens, 0),
    requests: list.length,
    first: list[0].time,
    last: list[list.length - 1].time,
  })

  /**
   * Groups priced calls per model. Each day of the range becomes one candle
   * (open = first call of the day, close = last call, high/low = the largest and
   * smallest single call); today keeps its individual calls so the panel can draw
   * an intraday series that moves as the day goes on.
   */
  const summarize = (calls, prices, webCost, priceMode, offset, today) => {
    const unpriced = new Set()
    const priced = []
    const buckets = emptyBuckets()
    let totalCost = 0
    let totalTokens = 0
    const sourceTotals = { checkpoint: { cost: 0, tokens: 0, requests: 0 }, live: { cost: 0, tokens: 0, requests: 0 } }
    const addSource = (source, cost, tokens) => {
      const entry = sourceTotals[source]
      if (entry === undefined) return
      entry.cost += cost
      entry.tokens += tokens
      entry.requests += 1
    }
    for (const call of calls) {
      addBuckets(buckets, call)
      const tokens = bucketsTotal(call)
      totalTokens += tokens
      const source = call.sessionId === undefined ? 'live' : 'checkpoint'
      const cost = costOfCall(call, prices, webCost, priceMode, unpriced)
      if (cost === undefined) {
        addSource(source, 0, tokens)
        continue
      }
      totalCost += cost
      addSource(source, cost, tokens)
      priced.push({ ...call, cost, tokens, source })
    }
    const groups = new Map()
    for (const call of priced) {
      const label = routeLabel(call.provider, call.model)
      const group = groups.get(label) ?? { model: label, calls: [], byDay: new Map(), today: [] }
      group.calls.push(call)
      const key = dayKey(call.time, offset)
      const dayList = group.byDay.get(key) ?? []
      dayList.push(call)
      group.byDay.set(key, dayList)
      if (key === today) group.today.push(call)
      groups.set(label, group)
    }
    const series = [...groups.values()]
      .sort((left, right) => right.calls.length - left.calls.length)
      .map((group) => {
        const sorted = group.calls.slice().sort((left, right) => left.time - right.time)
        const first = sorted[0]
        const last = sorted[sorted.length - 1]
        return {
          model: group.model,
          candles: [...group.byDay.entries()]
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([day, list]) => ({ day, ...candleOf(list) })),
          todayCandles: group.today
            .sort((left, right) => left.time - right.time)
            .map((call, index) => ({
              index,
              time: call.time,
              open: call.cost,
              close: call.cost,
              high: call.cost,
              low: call.cost,
              tokens: call.tokens,
              requests: 1,
            })),
          summary: {
            cost: sorted.reduce((total, call) => total + call.cost, 0),
            tokens: sorted.reduce((total, call) => total + call.tokens, 0),
            requests: sorted.length,
            last: last.cost,
            change: last.cost - first.cost,
          },
        }
      })
    return {
      priced,
      series,
      totals: { cost: totalCost, tokens: totalTokens, requests: priced.length, buckets },
      sourceTotals,
      unpriced: [...unpriced],
    }
  }

  /** The short label a Session row shows: its title, else its id tail. */
  const conversationLabel = (title, sessionId) => {
    if (typeof title === 'string' && title.trim() !== '') return title.trim()
    const tail = String(sessionId).replace(/^session-/, '').slice(0, 8)
    return `会话 ${tail}`
  }

  /**
   * One row per conversation: its id, label, model mix, spend, tokens and
   * requests, plus the turn-by-turn split of the open Session. Every row also
   * names the Workspace it belongs to, so the client can rank one Workspace.
   */
  const conversationsOf = async (priced, now) => {
    const offset = 8 * 3_600_000
    const bySession = new Map()
    for (const call of priced) {
      if (typeof call.sessionId !== 'string') continue
      const entry = bySession.get(call.sessionId) ?? {
        sessionId: call.sessionId,
        model: call.model,
        models: new Set(),
        cost: 0,
        tokens: 0,
        requests: 0,
        buckets: emptyBuckets(),
        last: 0,
        first: 0,
        isSubagent: call.isSubagent === true,
      }
      entry.models.add(call.model)
      entry.cost += call.cost
      entry.tokens += call.tokens
      entry.requests += 1
      addBuckets(entry.buckets, call)
      entry.last = Math.max(entry.last, call.time)
      entry.first = entry.first === 0 ? call.time : Math.min(entry.first, call.time)
      bySession.set(call.sessionId, entry)
    }
    const rows = [...bySession.values()]
    const ids = rows.map((row) => row.sessionId)
    const titles = new Map()
    const query = ctx.get?.('sessionQuery')
    if (query !== undefined && query !== null && typeof query.readTitleSnapshots === 'function' && ids.length > 0) {
      try {
        const results = await query.readTitleSnapshots(ids)
        for (const result of results) {
          if (result.status !== 'fulfilled') continue
          const title = result.value?.title
          if (title !== undefined && typeof title.title === 'string') titles.set(result.sessionId, title.title)
        }
      } catch (error) {
        void error
      }
    }
    // Session → Workspace, from the durable registry (archived sessions kept).
    const workspaceOf = new Map()
    const registry = ctx.get?.('workspaceRegistry')
    let workspaceCount = 0
    try {
      const workspaces = registry !== undefined && registry !== null && typeof registry.list === 'function' ? registry.list() : []
      workspaceCount = workspaces.length
      for (const workspace of workspaces) {
        for (const sessionId of workspace.sessionIds ?? []) {
          if (!workspaceOf.has(sessionId)) workspaceOf.set(sessionId, { id: workspace.id, title: workspace.title, path: workspace.path })
        }
      }
    } catch (error) {
      void error
    }
    const current = typeof currentSessionId === 'function' ? currentSessionId() : undefined
    return rows
      .map((row) => ({
        sessionId: row.sessionId,
        label: conversationLabel(titles.get(row.sessionId), row.sessionId),
        title: titles.get(row.sessionId) ?? null,
        model: row.model,
        models: [...row.models],
        cost: row.cost,
        tokens: row.tokens,
        requests: row.requests,
        buckets: row.buckets,
        first: row.first,
        last: row.last,
        day: dayKey(row.last, offset),
        isSubagent: row.isSubagent,
        workspace: workspaceOf.get(row.sessionId) ?? null,
        open: row.sessionId === current,
      }))
      .sort((left, right) => right.cost - left.cost)
      .map((row, index) => ({ ...row, rank: index + 1, generatedAt: now, workspaceCount, // A workspace copy keeps each row independent of the shared object.
        workspace: row.workspace === null ? null : { ...row.workspace } }))
  }

  const overview = async (days) => {
    const currency = String(option('currency', 'CNY')).toUpperCase() === 'USD' ? 'USD' : 'CNY'
    const priceMode = ['peak', 'offpeak'].includes(String(option('priceMode', 'auto')))
      ? String(option('priceMode', 'auto'))
      : 'auto'
    const offset = currency === 'USD' ? 0 : 8 * 3_600_000
    const prices = priceTable(currency)
    const webCost = webCostTable(currency)
    const now = Date.now()
    const today = dayKey(now, offset)
    const rangeStart = shiftDay(today, -(days - 1))
    const result = await freshScan()
    const inRange = (call) => {
      const key = dayKey(call.time, offset)
      return key >= rangeStart && key <= today
    }
    const summary = summarize(result.calls.concat(live).filter(inRange), prices, webCost, priceMode, offset, today)
    // The ranking covers each Workspace's whole history, not the picked range,
    // so a Workspace whose sessions all predate the range still ranks them.
    const lifetime = summarize(result.calls, prices, webCost, priceMode, offset, today)
    return {
      ...summary,
      conversations: await conversationsOf(summary.priced, now),
      lifetimeConversations: await conversationsOf(lifetime.priced, now),
      generatedAt: now,
      today,
      currency,
      priceMode,
      peakNow: isPeak(now),
      ranges: RANGES,
      liveCount: live.length,
      logs: result.calls.length,
      scan: await scanDiagnostics(),
      error: result.error === undefined ? undefined : String(result.error?.message ?? result.error),
    }
  }

  /** Latest provider-reported usage sample of one assistant event. */
  const usageOfEvent = (data) => {
    if (data === null || typeof data !== 'object') return undefined
    if (data.usage !== undefined) {
      const direct = bucketsOf(data.usage)
      if (direct !== undefined) return direct
    }
    const stream = Array.isArray(data.stream) ? data.stream : []
    for (let index = stream.length - 1; index >= 0; index -= 1) {
      const chunk = stream[index]?.type === 'chunk' ? stream[index].chunk : undefined
      if (chunk?.type === 'usage') return bucketsOf(chunk.usage)
      if (chunk?.type === 'finish') return undefined
    }
    return undefined
  }

  /**
   * Turn-by-turn usage of the Session on screen. The Client half sends its id
   * to `overview`, which stores it here; the fold runs over the live Session's
   * event window so each completed turn shows its own usage and the turn's
   * own cost in the configured currency.
   */
  const turnsOf = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const sessions = ctx.get?.('sessions')
    if (sessions === undefined || sessions === null || typeof sessions.binding !== 'function') return undefined
    let binding
    try {
      binding = sessions.binding(sessionId)
    } catch (error) {
      void error
      return undefined
    }
    const session = binding?.session
    if (session === undefined || session === null) return undefined
    const window = session.eventSource?.getSnapshot?.()
    const entries = Array.isArray(window?.entries) ? window.entries : []
    const events = entries.filter((entry) => entry?.type === 'event' && entry.event !== undefined).map((entry) => entry.event)
    let model = 'unknown'
    let provider = 'deepseek-account'
    let turn = 0
    const turns = new Map()
    const settled = new Map()
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue
      if (event.type === 'turn/start') {
        turn = Number(event.data?.turn) || turn + 1
        continue
      }
      if (event.type === 'request/header' || event.type === 'request/context') {
        const config = event.type === 'request/header' ? event.data?.header?.config : event.data
        if (typeof config?.model === 'string') model = config.model
        if (typeof config?.provider === 'string') provider = config.provider
        continue
      }
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
      const buckets = usageOfEvent(event.data)
      if (buckets === undefined) continue
      const step = Number(event.data?.step) || 0
      const key = `${turn}:${step}`
      const settledCall = settled.get(key)
      if (settledCall !== undefined) {
        // A finalized message follows its attempt settlement: both reported the
        // same call, so the later sample replaces the earlier one.
        settledCall.buckets = buckets
        settledCall.time = Number(event.time) || settledCall.time
        settledCall.final = true
        continue
      }
      const call = { turn, step, time: Number(event.time) || 0, buckets, model, provider, final: event.type === 'assistant/message' }
      settled.set(key, call)
      turns.set(key, call)
    }
    const currency = String(option('currency', 'CNY')).toUpperCase() === 'USD' ? 'USD' : 'CNY'
    const prices = priceTable(currency)
    const webCost = webCostTable(currency)
    const unpriced = new Set()
    const list = [...turns.values()]
      .sort((left, right) => left.turn - right.turn || left.step - right.step)
      .map((call) => {
        let cost = 0
        try {
          const flat = {
            time: call.time,
            model: call.model,
            provider: call.provider,
            isWeb: false,
            cacheRead: call.buckets.cacheRead,
            cacheWrite: call.buckets.cacheWrite,
            uncached: call.buckets.uncached,
            output: call.buckets.output,
          }
          cost = costOfCall(flat, prices, webCost, 'auto', unpriced) ?? 0
        } catch (error) {
          void error
        }
        return {
          turn: call.turn,
          step: call.step,
          time: call.time,
          tokens: bucketsTotal(call.buckets),
          buckets: call.buckets,
          model: call.model,
          cost,
        }
      })
    return {
      sessionId,
      turns: list,
      turnsTotal: list.reduce((sum, entry) => sum + entry.cost, 0),
      tokensTotal: list.reduce((sum, entry) => sum + entry.tokens, 0),
      unpriced: [...unpriced],
    }
  }

  let currentSessionId
  const setCurrentSession = (sessionId) => {
    currentSessionId = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
  }

  /**
   * The account view the panel shows: wallet balances plus the Platform's own
   * Usage and Top-up destinations, which the panel opens in a new tab.
   */
  const accountView = async (runtime) => {
    const account = ctx.get?.('deepseekAccount')
    const fallbackUrls = {
      usageUrl: 'https://platform.deepseek.com/usage',
      topUpUrl: 'https://platform.deepseek.com/top_up',
    }
    if (account === undefined || account === null) {
      return {
        ...fallbackUrls,
        status: 'unavailable',
        kind: 'unavailable',
        wallets: [],
        bonusWallets: [],
        runtime: { status: 'unavailable', message: 'No account service on this host' },
      }
    }
    let state
    try {
      state = await account.getState()
    } catch (error) {
      return {
        ...fallbackUrls,
        status: 'failed',
        kind: 'error',
        wallets: [],
        bonusWallets: [],
        runtime: { status: 'error', message: String(error?.message ?? error) },
      }
    }
    const links = state?.links ?? {}
    const urls = {
      usageUrl: typeof links.usageUrl === 'string' ? links.usageUrl : fallbackUrls.usageUrl,
      topUpUrl: typeof links.topUpUrl === 'string' ? links.topUpUrl : fallbackUrls.topUpUrl,
    }
    if (state?.status !== 'credential-stored') {
      return { ...urls, status: 'signed-out', kind: 'signed-out', wallets: [], bonusWallets: [], runtime: { status: 'ready' } }
    }
    const client = { version: '0.0.0', locale: 'zh', timezoneOffsetSeconds: 8 * 3600 }
    let result
    try {
      result = await account.getBalance(client)
    } catch (error) {
      return {
        ...urls,
        status: 'failed',
        kind: 'error',
        wallets: [],
        bonusWallets: [],
        runtime: { status: 'ready', error: String(error?.message ?? error) },
      }
    }
    if (result === null || result.status !== 'ready') {
      return { ...urls, status: 'failed', kind: 'unavailable', wallets: [], bonusWallets: [], runtime: { status: 'ready' } }
    }
    const wallets = result.value ?? []
    const bonusWallets = result.bonusWallets ?? []
    // Recharging balance (normal wallets) and granted balance (bonus wallets)
    // are billed separately; the granted one is spent first.
    const chargedWallets = wallets.map((wallet) => ({ ...wallet, charged: Number(wallet.balance) || 0, granted: 0 }))
    const usableFor = (currency) => {
      const granted = bonusWallets.reduce((sum, wallet) => (wallet.currency === currency ? sum + (Number(wallet.balance) || 0) : sum), 0)
      const charged = chargedWallets.find((wallet) => wallet.currency === currency)
      if (charged !== undefined) {
        charged.granted = granted
        return charged
      }
      return { currency, balance: '0', charged: 0, granted }
    }
    const currencies = [...new Set([...wallets.map((wallet) => wallet.currency), ...bonusWallets.map((wallet) => wallet.currency)])]
    const usable = currencies.map(usableFor)
    return {
      ...urls,
      status: 'ready',
      kind: 'ready',
      wallets,
      bonusWallets,
      usable,
      runtime: { status: 'ready' },
      fetchedAt: Date.now(),
    }
  }

  const reply = (response, status, value) => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(JSON.stringify(value))
  }

  const route = ctx.webServer.register({
    kind: 'prefix',
    path: API,
    handler: async (request, response) => {
      try {
        if (closed) {
          reply(response, 503, { error: 'usage service is reloading' })
          return
        }
        const admission = ctx.connection.admit(request)
        if (admission !== undefined && 'rejection' in admission) {
          reply(response, 401, { error: 'not admitted' })
          return
        }
        const url = new URL(request.url ?? '/', 'http://localhost')
        const path = url.pathname.slice(API.length)
        if (request.method === 'GET' && path === '/events') {
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          })
          response.write(`data: ${JSON.stringify({ revision })}\n\n`)
          eventClients.add(response)
          const heartbeat = setInterval(() => {
            try {
              response.write(': keep-alive\n\n')
            } catch (error) {
              void error
            }
          }, 25_000)
          heartbeat.unref?.()
          response.on('close', () => {
            clearInterval(heartbeat)
            eventClients.delete(response)
          })
          return
        }
        if (request.method === 'GET' && path === '/diag') {
          reply(response, 200, await scanDiagnostics())
          return
        }
        if (request.method === 'GET' && path === '/overview') {
          const requested = Number(url.searchParams.get('days')) || 30
          // The open Session is named by the caller, so the table can mark it.
          setCurrentSession(url.searchParams.get('sessionId'))
          reply(response, 200, await overview(RANGES.includes(requested) ? requested : 30))
          return
        }
        if (request.method === 'GET' && path === '/turns') {
          reply(response, 200, turnsOf(url.searchParams.get('sessionId')) ?? { sessionId: null, turns: [], turnsTotal: 0, tokensTotal: 0 })
          return
        }
        if (request.method === 'GET' && path === '/account') {
          reply(response, 200, await accountView({ status: 'unknown' }))
          return
        }
        if (request.method === 'POST' && path === '/remove') {
          // Body carries the Session to drop from this panel's lists.
          const chunks = []
          for await (const chunk of request) chunks.push(chunk)
          let sessionId = url.searchParams.get('sessionId')
          if (chunks.length > 0) {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              if (typeof body?.sessionId === 'string') sessionId = body.sessionId
            } catch (error) {
              void error
            }
          }
          const saved = await hideSession(sessionId)
          if (saved === false) {
            reply(response, 500, { removed: false, reason: 'the removed list could not be saved' })
            return
          }
          scan = undefined
          revision += 1
          for (const client of eventClients) {
            try {
              client.write(`data: ${JSON.stringify({ revision })}\n\n`)
            } catch (error) {
              void error
            }
          }
          reply(response, 200, { removed: true, sessionId, total: removedSessions.size })
          return
        }
        reply(response, 404, { error: 'not found' })
      } catch (error) {
        if (!response.headersSent) reply(response, 500, { error: String(error?.message ?? error) })
        else response.end()
      }
    },
  })

  // ---------------------------------------------------------------------
  // DSH-Go native surface. The Android client renders its own widgets from
  // JSON views and never runs plugin code, so this half only builds views and
  // data snapshots. It is opt-in: on a Host without the `dshGo` bridge the
  // callback below never runs and the Web UI stays the only surface.
  // ---------------------------------------------------------------------
  /** Compact money for a native metric, e.g. ¥1.2340. */
  const nativeMoney = (value, currency, digits = 2) => {
    const amount = Number.isFinite(value) ? value : 0
    const symbol = currency === 'USD' ? '$' : '¥'
    return `${symbol}${amount.toFixed(digits)}`
  }
  const compactNumber = (value) => {
    const number = Number.isFinite(value) ? value : 0
    if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`
    if (number >= 1e3) return `${(number / 1e3).toFixed(1)}K`
    return String(Math.round(number))
  }
  const localized = (zh, en, caps) => {
    const locale = String(caps?.locale ?? '').toLowerCase()
    return locale.startsWith('zh') ? { zh, en } : { zh, en }
  }
  const pick = (pair, caps) => (String(caps?.locale ?? 'en').toLowerCase().startsWith('zh') ? pair.zh : pair.en)

  /**
   * Per-panel state. The bridge passes only a scope, never plugin state, so a
   * range choice and the tapped model live here, keyed by the normalized scope.
   */
  const nativeState = new Map()
  const stateKeyOf = (scope) => JSON.stringify({ sessionId: scope?.sessionId ?? null })
  const stateOf = (scope) => {
    const key = stateKeyOf(scope)
    let state = nativeState.get(key)
    if (state === undefined) {
      state = { days: 30, model: undefined, metric: 'cost' }
      nativeState.set(key, state)
    }
    return state
  }

  /** The panel's JSON view tree, built from the same numbers the Web page shows. */
  const nativeUsageView = async (scope, caps) => {
    const state = stateOf(scope)
    const days = RANGES.includes(state.days) ? state.days : 30
    const data = await overview(days)
    const account = await accountView({ status: 'unknown' }).catch(() => undefined)
    const usable = (account?.usable ?? []).find((entry) => entry.currency === data.currency) ?? (account?.usable ?? [])[0]
    const totals = data.totals ?? { cost: 0, tokens: 0, requests: 0, buckets: {} }
    const buckets = totals.buckets ?? {}
    const inputs = (buckets.cacheRead ?? 0) + (buckets.uncached ?? 0)
    const hitRate = inputs <= 0 ? 0 : (buckets.cacheRead ?? 0) / inputs
    const currency = data.currency ?? 'CNY'
    const rangeLabel = `${days} 天`

    const labels = {
      spend: localized(`${rangeLabel}估算`, `Last ${days}d`, caps),
      today: localized('今日', 'Today', caps),
      tokens: localized('Token', 'Tokens', caps),
      requests: localized('请求', 'Requests', caps),
      balance: localized('可用余额', 'Usable balance', caps),
      recharge: localized('充值余额', 'Recharged', caps),
      cache: localized('缓存命中率', 'Cache hit rate', caps),
      range: localized('周期', 'Range', caps),
      kline: localized('日 K 线', 'Daily K-line', caps),
      intraday: localized('分时', 'Intraday', caps),
      byModel: localized('按模型', 'By model', caps),
      leaders: localized('主力动向', 'Model ranking', caps),
      tape: localized('逐笔成交', 'Live tape', caps),
      ranking: localized('对话用量排名', 'Conversation ranking', caps),
      empty: localized('暂无用量记录。', 'No usage recorded yet.', caps),
      estimate: localized('金额按官方单价估算，并非账单。', 'Amounts are estimates from official rates, not a bill.', caps),
      high: localized('最高', 'High', caps),
      low: localized('最低', 'Low', caps),
      share: localized('占比', 'Share', caps),
    }

    const seriesList = Array.isArray(data.series) ? data.series : []
    // Today's spend is the sum of every model's newest candle when that candle
    // is today; the range total above already contains it.
    const todayCost = seriesList.reduce((sum, entry) => {
      const last = entry.candles?.[entry.candles.length - 1]
      return sum + (last !== undefined && last.day === data.today ? Number(last.sum ?? 0) : 0)
    }, 0)

    const children = []

    // Range picker. `tabs` switches locally without invoking the plugin and
    // `actions` caps at four, so a single-choice list is what can actually
    // change the server-side range; `grid` keeps it to a few short rows.
    children.push({
      type: 'grid',
      columns: 3,
      children: [
        {
          type: 'options',
          id: 'range',
          label: pick(labels.range, caps),
          options: RANGES.map((value) => ({ label: `${value}天`, value: String(value) })),
          selected: String(days),
        },
      ],
    })

    children.push({
      type: 'row',
      children: [
        { type: 'metric', label: pick(labels.spend, caps), value: nativeMoney(totals.cost, currency, 2), tone: 'info' },
        { type: 'metric', label: pick(labels.today, caps), value: nativeMoney(todayCost, currency, 4) },
      ],
    })
    children.push({
      type: 'row',
      children: [
        { type: 'metric', label: pick(labels.tokens, caps), value: compactNumber(totals.tokens) },
        { type: 'metric', label: pick(labels.requests, caps), value: String(totals.requests ?? 0) },
      ],
    })

    // Wallets: the recharged remainder and the usable total. `usableFor`
    // exposes the recharged amount as `charged` and the granted bonus as
    // `granted`, so the usable balance is their sum, never `granted` alone.
    if (usable !== undefined) {
      const charged = Number(usable.charged ?? 0)
      const granted = Number(usable.granted ?? 0)
      children.push({
        type: 'keyValue',
        items: [
          [pick(labels.recharge, caps), nativeMoney(charged, currency, 2)],
          [pick(labels.balance, caps), nativeMoney(charged + granted, currency, 2)],
        ],
      })
    }
    children.push({ type: 'progress', value: Math.round(hitRate * 100), label: pick(labels.cache, caps) })

    // Daily totals per day, in cost and in tokens: the page's 日K series.
    const dailyCost = new Map()
    const dailyTokens = new Map()
    for (const entry of seriesList) {
      for (const candle of entry.candles ?? []) {
        dailyCost.set(candle.day, (dailyCost.get(candle.day) ?? 0) + Number(candle.sum ?? 0))
        dailyTokens.set(candle.day, (dailyTokens.get(candle.day) ?? 0) + Number(candle.openTokens ?? 0))
      }
    }
    const dayKeys = [...dailyCost.keys()].sort((left, right) => (left < right ? -1 : 1))
    const dayLabels = dayKeys.map((day) => String(day).slice(5))

    // Per-call series of today, the page's 分时 view.
    const todayCalls = (Array.isArray(data.priced) ? data.priced : [])
      .filter((call) => dayKey(call.time, 8 * 3_600_000) === data.today)
      .sort((left, right) => left.time - right.time)
    const intradayLabels = todayCalls.map((call) =>
      new Date(call.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    )

    // 日线 / 分时 and 金额 / Token are local tabs: switching costs no round trip.
    const dailyPanels = [
      {
        type: 'chart',
        kind: 'bar',
        categories: dayLabels,
        series: [{ name: pick(labels.spend, caps), values: dayKeys.map((day) => dailyCost.get(day) ?? 0) }],
        caption: pick(labels.kline, caps),
      },
      {
        type: 'chart',
        kind: 'bar',
        categories: dayLabels,
        series: [{ name: 'Token', values: dayKeys.map((day) => dailyTokens.get(day) ?? 0) }],
        caption: pick(labels.kline, caps),
      },
    ]
    const intradayPanels = [
      {
        type: 'chart',
        kind: 'line',
        categories: intradayLabels,
        series: [{ name: pick(labels.spend, caps), values: todayCalls.map((call) => Number(call.cost ?? 0)) }],
        caption: pick(labels.intraday, caps),
      },
      {
        type: 'chart',
        kind: 'line',
        categories: intradayLabels,
        series: [{ name: 'Token', values: todayCalls.map((call) => Number(call.tokens ?? 0)) }],
        caption: pick(labels.intraday, caps),
      },
    ]
    const chartTabs = (items) => ({
      type: 'tabs',
      items: items.map((tab) => ({ label: pick(tab.label, caps), children: [tab.children] })),
    })
    if (dayKeys.length > 0 || todayCalls.length > 0) {
      children.push(
        chartTabs([
          { label: labels.kline, children: chartTabs(dailyPanels.map((panel, index) => ({ label: index === 0 ? labels.spend : { zh: 'Token', en: 'Tokens' }, children: panel }))) },
          { label: labels.intraday, children: chartTabs(intradayPanels.map((panel, index) => ({ label: index === 0 ? labels.spend : { zh: 'Token', en: 'Tokens' }, children: panel }))) },
        ]),
      )
    }

    // 主力动向: models ranked by spend, with their share of the range.
    if (seriesList.length > 0) {
      const ranked = seriesList.slice().sort((left, right) => Number(right.summary?.cost ?? 0) - Number(left.summary?.cost ?? 0))
      children.push({
        type: 'table',
        columns: [
          { label: pick(labels.leaders, caps) },
          { label: 'Token', align: 'end' },
          { label: pick(labels.spend, caps), align: 'end' },
          { label: pick(labels.share, caps), align: 'end' },
        ],
        rows: ranked.slice(0, 12).map((entry) => {
          const cost = Number(entry.summary?.cost ?? 0)
          return [
            String(entry.model ?? '—'),
            compactNumber(entry.summary?.tokens),
            nativeMoney(cost, currency, 4),
            totals.cost > 0 ? `${((cost / totals.cost) * 100).toFixed(1)}%` : '0.0%',
          ]
        }),
      })
    }

    // 逐笔成交: the newest priced calls, newest first.
    const priced = Array.isArray(data.priced) ? data.priced : []
    if (priced.length > 0) {
      const newest = priced.slice().sort((left, right) => right.time - left.time).slice(0, 8)
      children.push({
        type: 'list',
        items: newest.map((call) => ({
          title: String(call.model ?? '—'),
          subtitle: new Date(call.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          trailing: nativeMoney(call.cost, currency, 4),
          icon: 'chart',
        })),
      })
    }

    // 对话用量排名: lifetime spend per conversation. A row shows the id tail
    // because tapping cannot select a conversation in the App.
    const conversations = Array.isArray(data.lifetimeConversations) ? data.lifetimeConversations : []
    if (conversations.length > 0) {
      children.push({
        type: 'list',
        items: conversations.slice(0, 12).map((row, index) => ({
          title: String(row.title ?? row.label ?? row.sessionId ?? '—').slice(0, 60),
          subtitle:
            [
              String(row.workspace?.title ?? '').trim(),
              String(row.sessionId ?? '').replace(/^session-/, '').slice(0, 8),
              `#${index + 1}`,
            ]
              .filter((part) => part !== '')
              .join(' · ') || undefined,
          trailing: nativeMoney(row.cost, currency, 4),
          icon: 'chat',
        })),
      })
    }

    if (children.length === 0) {
      children.push({ type: 'callout', text: pick(labels.empty, caps), tone: 'info' })
    }
    children.push({ type: 'text', text: pick(labels.estimate, caps), tone: 'muted' })
    return { v: 2, type: 'stack', accent: 'app', children }
  }

  try {
    ctx.inject(['dshGo'], (scoped) => {
      scoped.dshGo.panel('usage', {
        view: (scope, caps) => nativeUsageView(scope, caps),
        data: (scope, emit, caps) => {
          // Push a fresh snapshot once, then on every committed usage event.
          let disposed = false
          let timer
          const push = () => {
            if (disposed) return
            nativeUsageView(scope, caps)
              .then((view) => {
                if (!disposed) emit({ view })
              })
              .catch(() => undefined)
          }
          push()
          timer = setInterval(push, 60_000)
          timer.unref?.()
          // `listeners` is the same feed the HTTP clients subscribe to.
          const listener = () => push()
          listeners.add(listener)
          return () => {
            disposed = true
            clearInterval(timer)
            listeners.delete(listener)
          }
        },
        actions: {
          refresh: () => {
            scan = undefined
            return { toast: '已刷新' }
          },
          // The range picker sends `{ value }`; remember it for this scope and
          // ask the App to re-read the view.
          range: (scope, event) => {
            const next = Number(event?.value?.value ?? event?.value?.days)
            if (RANGES.includes(next)) stateOf(scope).days = next
            return { refresh: true }
          },
        },
      })
      // The composer strip shows today's spend and opens the panel when tapped.
      scoped.dshGo.strip('today', (scope, emit, caps) => {
        let disposed = false
        const render = async () => {
          const data = await overview(7).catch(() => undefined)
          if (disposed || data === undefined) return
          const currency = data.currency ?? 'CNY'
          const zh = String(caps?.locale ?? 'en').toLowerCase().startsWith('zh')
          // Today's sum is the newest candle of each model series.
          const cost = (Array.isArray(data.series) ? data.series : []).reduce((sum, entry) => {
            const last = entry.candles?.[entry.candles.length - 1]
            return sum + (last !== undefined && last.day === data.today ? Number(last.sum ?? 0) : 0)
          }, 0)
          const text = `${zh ? '今日' : 'Today'} ${nativeMoney(cost, currency, 4)}`
          emit({ text: text.slice(0, 24), icon: 'chart' })
        }
        render()
        const timer = setInterval(render, 60_000)
        timer.unref?.()
        const listener = () => {
          render().catch(() => undefined)
        }
        listeners.add(listener)
        return () => {
          disposed = true
          clearInterval(timer)
          listeners.delete(listener)
        }
      })
    })
  } catch (error) {
    // A Host without the DSH-Go bridge simply keeps the Web surface.
    void error
  }

  ctx.effect(
    () => () => {
      closed = true
      attempt(() => stopLive?.())
      attempt(() => restoreWeb?.())
      attempt(() => route?.())
      if (notifyTimer !== undefined) clearTimeout(notifyTimer)
      for (const client of eventClients) attempt(() => client.end())
      eventClients.clear()
      listeners.clear()
    },
    'usage-kline: shutdown',
  )

  return {
    overview,
    accountView,
    turnsOf,
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
  }
}
