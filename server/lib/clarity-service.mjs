import {
  deleteClarityConnectionRecord,
  getClarityConnectionRecord,
  upsertClarityConnectionRecord,
} from './answer-visibility-store.mjs'

const CLARITY_ENDPOINT = 'https://www.clarity.ms/export-data/api/v1/project-live-insights'
const CLARITY_DAYS = 3

export async function getClarityIntegrationStatus() {
  const connection = resolveClarityConnection()

  return {
    configured: Boolean(connection?.apiToken),
    source: connection?.source ?? 'none',
    projectLabel: connection?.projectLabel ?? '',
    lastValidatedAt: connection?.lastValidatedAt ?? null,
    lastError: connection?.lastError ?? null,
    message: connection?.apiToken
      ? 'Clarity is connected and can enrich CRO scans with behavioral friction signals.'
      : 'Connect a Clarity API token to bring in rage clicks, dead clicks, scroll depth, and other behavior signals.',
  }
}

export async function saveClarityIntegration({ apiToken, projectLabel = '' }) {
  const trimmedToken = String(apiToken ?? '').trim()
  if (!trimmedToken) {
    throw new Error('A Clarity API token is required.')
  }

  const now = new Date().toISOString()
  await validateClarityToken(trimmedToken)

  return upsertClarityConnectionRecord({
    projectLabel: String(projectLabel ?? '').trim(),
    apiToken: trimmedToken,
    source: 'saved',
    lastValidatedAt: now,
    lastError: null,
    now,
  })
}

export async function clearClarityIntegration() {
  deleteClarityConnectionRecord('clarity')
  return { ok: true }
}

export async function getClarityPageInsights(targetUrl) {
  const connection = resolveClarityConnection()
  if (!connection?.apiToken) return null

  const payload = await fetchClarityDataset(connection.apiToken)
  const pageMetrics = buildClarityPageMetrics(payload, targetUrl)

  if (!pageMetrics) {
    return {
      connected: true,
      projectLabel: connection.projectLabel ?? '',
      source: connection.source ?? 'saved',
      matched: false,
      lastDays: CLARITY_DAYS,
      message: 'Clarity is connected, but no matching page-level data was found for this URL in the last 3 days.',
    }
  }

  const friction = computeBehavioralFriction(pageMetrics)
  return {
    connected: true,
    matched: true,
    projectLabel: connection.projectLabel ?? '',
    source: connection.source ?? 'saved',
    lastDays: CLARITY_DAYS,
    message: 'Behavioral metrics from Clarity were blended into this CRO read.',
    ...pageMetrics,
    ...friction,
  }
}

async function validateClarityToken(apiToken) {
  await fetchClarityDataset(apiToken)
}

async function fetchClarityDataset(apiToken) {
  const url = new URL(CLARITY_ENDPOINT)
  url.searchParams.set('numOfDays', String(CLARITY_DAYS))
  url.searchParams.set('dimension1', 'URL')

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    if (response.status === 401 || response.status === 403) {
      throw new Error('Clarity token is invalid or not authorized for this project.')
    }
    if (response.status === 429) {
      throw new Error('Clarity rate limit reached for this project today.')
    }
    throw new Error(`Clarity request failed with status ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`)
  }

  const data = await response.json().catch(() => null)
  if (!Array.isArray(data)) {
    throw new Error('Clarity did not return the expected dashboard JSON format.')
  }
  return data
}

function buildClarityPageMetrics(dataset, targetUrl) {
  const parsedTarget = new URL(targetUrl)
  const metricMap = new Map()

  for (const metricBlock of dataset) {
    const metricName = String(metricBlock?.metricName ?? '').trim()
    const information = Array.isArray(metricBlock?.information) ? metricBlock.information : []

    for (const row of information) {
      const rowUrl = extractClarityUrl(row)
      if (!rowUrl) continue

      const key = normalizeUrlKey(rowUrl)
      const existing = metricMap.get(key) ?? { url: rowUrl, metrics: {} }
      existing.metrics[metricName] = extractMetricNumber(metricName, row)
      metricMap.set(key, existing)
    }
  }

  const matched = findBestMetricMatch(metricMap, parsedTarget)
  if (!matched) return null

  return {
    url: matched.url,
    sessions: Math.round(matched.metrics.Traffic ?? 0),
    engagementTime: Math.round(matched.metrics['Engagement Time'] ?? 0),
    scrollDepth: roundOneDecimal(matched.metrics['Scroll Depth'] ?? 0),
    deadClicks: Math.round(matched.metrics['Dead Click Count'] ?? 0),
    rageClicks: Math.round(matched.metrics['Rage Click Count'] ?? 0),
    quickbacks: Math.round(matched.metrics['Quickback Click'] ?? 0),
    excessiveScrolls: Math.round(matched.metrics['Excessive Scroll'] ?? 0),
    scriptErrors: Math.round(matched.metrics['Script Error Count'] ?? 0),
    errorClicks: Math.round(matched.metrics['Error Click Count'] ?? 0),
  }
}

function findBestMetricMatch(metricMap, parsedTarget) {
  const variants = buildUrlVariants(parsedTarget)

  for (const variant of variants) {
    if (metricMap.has(variant)) return metricMap.get(variant)
  }

  for (const [key, value] of metricMap.entries()) {
    if (variants.some((variant) => key.includes(variant) || variant.includes(key))) {
      return value
    }
  }

  return null
}

function buildUrlVariants(parsedTarget) {
  const full = normalizeUrlKey(parsedTarget.toString())
  const originPath = normalizeUrlKey(`${parsedTarget.origin}${parsedTarget.pathname}`)
  const pathOnly = normalizeUrlKey(parsedTarget.pathname)
  const trimmedPath = pathOnly.replace(/\/$/, '')
  return [...new Set([full, originPath, pathOnly, trimmedPath].filter(Boolean))]
}

function extractClarityUrl(row) {
  const keys = ['URL', 'Url', 'url', 'Page URL', 'PageUrl', 'pageUrl']
  for (const key of keys) {
    if (row?.[key]) return String(row[key]).trim()
  }
  return ''
}

function extractMetricNumber(metricName, row) {
  const lowerName = metricName.toLowerCase()
  const entries = Object.entries(row ?? {})
    .filter(([key]) => !/^(url|page ?url)$/i.test(key))
    .map(([key, value]) => ({
      key: key.toLowerCase(),
      value: toNumber(value),
    }))
    .filter((entry) => Number.isFinite(entry.value))

  const byKey = (patterns) => {
    const match = entries.find((entry) => patterns.some((pattern) => entry.key.includes(pattern)))
    return match?.value
  }

  if (lowerName === 'traffic') {
    return byKey(['totalsessioncount', 'sessioncount', 'traffic']) ?? maxEntry(entries)
  }
  if (lowerName === 'engagement time') {
    return byKey(['engagementtime', 'time']) ?? maxEntry(entries)
  }
  if (lowerName === 'scroll depth') {
    return byKey(['scrolldepth', 'scroll']) ?? maxEntry(entries)
  }
  if (lowerName === 'dead click count') {
    return byKey(['deadclick']) ?? maxEntry(entries)
  }
  if (lowerName === 'rage click count') {
    return byKey(['rageclick']) ?? maxEntry(entries)
  }
  if (lowerName === 'quickback click') {
    return byKey(['quickback']) ?? maxEntry(entries)
  }
  if (lowerName === 'excessive scroll') {
    return byKey(['excessive']) ?? maxEntry(entries)
  }
  if (lowerName === 'script error count') {
    return byKey(['scripterror']) ?? maxEntry(entries)
  }
  if (lowerName === 'error click count') {
    return byKey(['errorclick']) ?? maxEntry(entries)
  }

  return maxEntry(entries)
}

function computeBehavioralFriction(metrics) {
  const sessions = Math.max(metrics.sessions, 1)
  const deadRate = (metrics.deadClicks / sessions) * 100
  const rageRate = (metrics.rageClicks / sessions) * 100
  const quickbackRate = (metrics.quickbacks / sessions) * 100
  const excessiveScrollRate = (metrics.excessiveScrolls / sessions) * 100
  const errorRate = ((metrics.scriptErrors + metrics.errorClicks) / sessions) * 100
  const engagementMinutes = metrics.engagementTime > 1000 ? metrics.engagementTime / 60000 : metrics.engagementTime / 60

  let score = 100
  score -= deadRate * 2.4
  score -= rageRate * 3.2
  score -= quickbackRate * 2.8
  score -= excessiveScrollRate * 1.5
  score -= errorRate * 4
  if (metrics.scrollDepth < 40) score -= 12
  else if (metrics.scrollDepth < 60) score -= 6
  else if (metrics.scrollDepth > 75) score += 4
  if (engagementMinutes >= 1.5) score += 6
  if (engagementMinutes >= 3) score += 4
  if (sessions < 20) score -= 6

  const frictionScore = clamp(Math.round(score), 0, 100)
  const frictionGrade =
    frictionScore >= 82 ? 'A' :
      frictionScore >= 68 ? 'B' :
        frictionScore >= 54 ? 'C' :
          frictionScore >= 40 ? 'D' : 'E'

  const findings = []
  const opportunities = []

  if (metrics.rageClicks >= 3) {
    opportunities.push('Users are repeatedly clicking in frustration. Review CTAs, tabs, and any elements that look clickable but do not respond clearly.')
  } else {
    findings.push('Rage-click volume is relatively controlled for the sampled period.')
  }

  if (metrics.deadClicks >= 3) {
    opportunities.push('Dead clicks suggest visitors are trying to interact with non-clickable UI. Tighten visual affordances and check misleading cards, logos, and images.')
  } else {
    findings.push('Dead-click volume is not especially elevated in the recent Clarity sample.')
  }

  if (metrics.quickbacks >= 2) {
    opportunities.push('Quickbacks point to message mismatch or unmet expectations. Tighten the opening copy and make the next step clearer above the fold.')
  }

  if (metrics.scrollDepth < 45) {
    opportunities.push('Scroll depth is shallow, which suggests the core value proposition or layout is not pulling users deeper. Bring proof and differentiation higher on the page.')
  } else {
    findings.push(`Scroll depth is ${roundOneDecimal(metrics.scrollDepth)}%, which suggests visitors are engaging with more than the first fold.`)
  }

  if (engagementMinutes >= 2) {
    findings.push(`Average engagement is about ${roundOneDecimal(engagementMinutes)} minutes, which is healthy enough to trust the behavioral signal.`)
  } else {
    opportunities.push('Engagement time is modest. Sharpen the opening section so visitors understand the offer and trust it faster.')
  }

  if ((metrics.scriptErrors + metrics.errorClicks) > 0) {
    opportunities.push('Clarity detected script or error-click signals, so the page may have technical friction that is hurting conversion confidence.')
  }

  return {
    frictionScore,
    frictionGrade,
    confidenceLabel: sessions >= 100 ? 'high' : sessions >= 30 ? 'medium' : 'low',
    rates: {
      deadClicksPer100Sessions: roundOneDecimal(deadRate),
      rageClicksPer100Sessions: roundOneDecimal(rageRate),
      quickbacksPer100Sessions: roundOneDecimal(quickbackRate),
      excessiveScrollsPer100Sessions: roundOneDecimal(excessiveScrollRate),
      errorsPer100Sessions: roundOneDecimal(errorRate),
    },
    findings,
    opportunities,
  }
}

function resolveClarityConnection() {
  const envToken = String(process.env.CLARITY_API_TOKEN ?? '').trim()
  const envProjectLabel = String(process.env.CLARITY_PROJECT_LABEL ?? '').trim()
  if (envToken) {
    return {
      apiToken: envToken,
      projectLabel: envProjectLabel,
      source: 'server',
      lastValidatedAt: null,
      lastError: null,
    }
  }

  return getClarityConnectionRecord('clarity')
}

function normalizeUrlKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\/+$/, '')
}

function toNumber(value) {
  if (typeof value === 'number') return value
  const normalized = String(value ?? '').replace(/,/g, '').trim()
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function maxEntry(entries) {
  if (!entries.length) return 0
  return entries.reduce((max, entry) => Math.max(max, entry.value), 0)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function roundOneDecimal(value) {
  return Math.round(Number(value ?? 0) * 10) / 10
}
