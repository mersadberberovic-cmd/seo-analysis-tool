import {
  consumeGoogleOauthStateRecord,
  createGoogleOauthStateRecord,
  getAnswerVisibilityStoreSnapshot,
  getGoogleConnectionRecord,
  getGooglePropertySelectionRecord,
  saveGooglePropertySelectionRecord,
  upsertGoogleConnectionRecord,
} from './answer-visibility-store.mjs'

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:4174/api/google/oauth/callback'
const APP_CLIENT_ORIGIN = process.env.APP_CLIENT_ORIGIN || 'http://localhost:5173'
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
]

const AI_SOURCE_BUCKETS = [
  { id: 'chatgpt', label: 'ChatGPT', patterns: ['chatgpt', 'chat.openai', 'openai', 'gpt'] },
  { id: 'gemini', label: 'Gemini', patterns: ['gemini', 'bard'] },
  { id: 'claude', label: 'Claude', patterns: ['claude', 'anthropic'] },
  { id: 'perplexity', label: 'Perplexity', patterns: ['perplexity'] },
  { id: 'copilot', label: 'Copilot', patterns: ['copilot', 'bing chat'] },
  { id: 'grok', label: 'Grok', patterns: ['grok', 'x.ai', 'xai'] },
  { id: 'meta-ai', label: 'Meta AI', patterns: ['meta ai'] },
  { id: 'mistral', label: 'Mistral', patterns: ['mistral', 'le chat'] },
  { id: 'you', label: 'You.com', patterns: ['you.com', 'you ai'] },
]

export function getGoogleOauthStatus() {
  const configured = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
  const connection = getGoogleConnectionRecord('google')
  const selection = connection ? getGooglePropertySelectionRecord(connection.id) : null

  return {
    configured,
    connected: Boolean(connection?.accessToken || connection?.refreshToken),
    needsReconnect: Boolean(connection && !connection.refreshToken && isTokenExpired(connection.tokenExpiryAt)),
    account: connection ? {
      email: connection.email,
      displayName: connection.displayName,
      pictureUrl: connection.pictureUrl,
    } : null,
    selection,
    redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
    message: configured
      ? (connection ? 'Google account connected. You can choose GA4 and GSC properties for AI traffic reporting.' : 'Connect a Google account to pull GA4 and Search Console property data into AI Visibility.')
      : 'Google OAuth is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the backend first.',
  }
}

export function createGoogleOauthStartUrl({ redirectTo = '' } = {}) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.')
  }

  const now = new Date()
  const stateRecord = createGoogleOauthStateRecord({
    redirectTo,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
  })

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: GOOGLE_SCOPES.join(' '),
    state: stateRecord.state,
  })

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

export async function handleGoogleOauthCallback({ code, state }) {
  if (!code || !state) {
    throw new Error('Missing Google OAuth code or state.')
  }

  const stateRecord = consumeGoogleOauthStateRecord(state)
  if (!stateRecord) {
    throw new Error('The Google sign-in state was not found or has expired. Please try connecting again.')
  }

  const tokenPayload = await exchangeCodeForTokens(code)
  const profile = await fetchGoogleUserProfile(tokenPayload.access_token)

  const now = new Date().toISOString()
  const connection = upsertGoogleConnectionRecord({
    provider: 'google',
    googleAccountId: profile.sub || null,
    email: profile.email || null,
    displayName: profile.name || null,
    pictureUrl: profile.picture || null,
    scope: tokenPayload.scope ? tokenPayload.scope.split(' ').filter(Boolean) : GOOGLE_SCOPES,
    accessToken: tokenPayload.access_token || null,
    refreshToken: tokenPayload.refresh_token || null,
    tokenExpiryAt: buildExpiryTimestamp(tokenPayload.expires_in),
    now,
  })

  return {
    connection,
    redirectTo: stateRecord.redirectTo || '',
  }
}

export async function getGoogleIntegrationOverview({ refreshProperties = false } = {}) {
  const status = getGoogleOauthStatus()
  if (!status.connected) {
    return {
      ...status,
      ga4Properties: [],
      gscProperties: [],
    }
  }

  const connection = await getValidGoogleConnection()
  const [ga4Properties, gscProperties] = await Promise.all([
    listGa4Properties(connection, { refreshProperties }),
    listGscProperties(connection, { refreshProperties }),
  ])

  const selection = getGooglePropertySelectionRecord(connection.id)

  return {
    ...status,
    connected: true,
    account: {
      email: connection.email,
      displayName: connection.displayName,
      pictureUrl: connection.pictureUrl,
    },
    selection,
    ga4Properties,
    gscProperties,
  }
}

export async function saveGooglePropertySelection({ ga4PropertyId = '', gscSiteUrl = '' }) {
  const connection = await getValidGoogleConnection()
  const [ga4Properties, gscProperties] = await Promise.all([
    listGa4Properties(connection),
    listGscProperties(connection),
  ])

  const selectedGa4 = ga4Properties.find((item) => item.id === ga4PropertyId) || null
  const selectedGsc = gscProperties.find((item) => item.siteUrl === gscSiteUrl) || null

  return saveGooglePropertySelectionRecord({
    connectionId: connection.id,
    ga4PropertyId: selectedGa4?.id || null,
    ga4PropertyName: selectedGa4?.displayName || null,
    gscSiteUrl: selectedGsc?.siteUrl || null,
    gscSiteName: selectedGsc?.displayName || null,
    now: new Date().toISOString(),
  })
}

export async function getAiTrafficOverview({ days = 28 } = {}) {
  const connection = await getValidGoogleConnection()
  const selection = getGooglePropertySelectionRecord(connection.id)

  if (!selection?.ga4PropertyId) {
    throw new Error('Choose a GA4 property first to load AI traffic.')
  }

  const endDate = new Date()
  const startDate = new Date(endDate)
  startDate.setDate(startDate.getDate() - Math.max(1, Number(days) || 28) + 1)
  const previousEndDate = new Date(startDate)
  previousEndDate.setDate(previousEndDate.getDate() - 1)
  const previousStartDate = new Date(previousEndDate)
  previousStartDate.setDate(previousStartDate.getDate() - Math.max(1, Number(days) || 28) + 1)

  const [sourceRows, landingRows, gscRows, gscQueryRows, previousSourceRows, previousLandingRows] = await Promise.all([
    fetchGa4SourceRows(connection, selection.ga4PropertyId, startDate, endDate),
    fetchGa4LandingRows(connection, selection.ga4PropertyId, startDate, endDate),
    selection.gscSiteUrl ? fetchGscPageRows(connection, selection.gscSiteUrl, startDate, endDate) : Promise.resolve([]),
    selection.gscSiteUrl ? fetchGscPageQueryRows(connection, selection.gscSiteUrl, startDate, endDate) : Promise.resolve([]),
    fetchGa4SourceRows(connection, selection.ga4PropertyId, previousStartDate, previousEndDate),
    fetchGa4LandingRows(connection, selection.ga4PropertyId, previousStartDate, previousEndDate),
  ])

  const sourceBuckets = aggregateAiSources(sourceRows)
  const landingPages = aggregateLandingPages(landingRows, gscRows)
  const previousSourceBuckets = aggregateAiSources(previousSourceRows)
  const previousLandingPages = aggregateLandingPages(previousLandingRows, [])
  const dailyTrend = buildDailyTrendSeries(sourceRows, startDate, endDate)

  const totalSessions = sourceBuckets.reduce((sum, item) => sum + item.sessions, 0)
  const totalUsers = sourceBuckets.reduce((sum, item) => sum + item.totalUsers, 0)
  const engagedSessions = sourceBuckets.reduce((sum, item) => sum + item.engagedSessions, 0)
  const previousTotalSessions = previousSourceBuckets.reduce((sum, item) => sum + item.sessions, 0)
  const previousTotalUsers = previousSourceBuckets.reduce((sum, item) => sum + item.totalUsers, 0)
  const previousEngagedSessions = previousSourceBuckets.reduce((sum, item) => sum + item.engagedSessions, 0)
  const score = computeAiTrafficScore({
    totalSessions,
    totalUsers,
    engagedSessions,
    landingPages,
    sourceBuckets,
  })
  const previousScore = computeAiTrafficScore({
    totalSessions: previousTotalSessions,
    totalUsers: previousTotalUsers,
    engagedSessions: previousEngagedSessions,
    landingPages: previousLandingPages,
    sourceBuckets: previousSourceBuckets,
  })
  const gscQueriesByPage = aggregateGscQueriesByPage(gscQueryRows)
  const promptTrafficConnections = buildPromptTrafficConnections(landingPages, gscQueriesByPage)
  const sourceTrends = buildSourceTrendRows(sourceBuckets, previousSourceBuckets)

  return {
    property: {
      ga4PropertyId: selection.ga4PropertyId,
      ga4PropertyName: selection.ga4PropertyName,
      gscSiteUrl: selection.gscSiteUrl,
      gscSiteName: selection.gscSiteName,
    },
    dateRange: {
      days: Math.max(1, Number(days) || 28),
      startDate: toIsoDate(startDate),
      endDate: toIsoDate(endDate),
    },
    comparisonRange: {
      startDate: toIsoDate(previousStartDate),
      endDate: toIsoDate(previousEndDate),
    },
    summary: {
      aiSessions: totalSessions,
      aiUsers: totalUsers,
      engagedSessions,
      sourceCount: sourceBuckets.length,
      topSource: sourceBuckets[0]?.label || null,
      score: score.value,
      grade: score.grade,
      scoreLabel: score.label,
      scoreComponents: score.components,
    },
    sources: sourceBuckets,
    sourceTrends,
    dailyTrend,
    landingPages,
    comparison: {
      aiSessionsDelta: totalSessions - previousTotalSessions,
      aiUsersDelta: totalUsers - previousTotalUsers,
      engagedSessionsDelta: engagedSessions - previousEngagedSessions,
      scoreDelta: score.value - previousScore.value,
      previousScore: previousScore.value,
      previousGrade: previousScore.grade,
      previousTopSource: previousSourceBuckets[0]?.label || null,
    },
    promptTrafficConnections,
  }
}

async function getValidGoogleConnection() {
  const existing = getGoogleConnectionRecord('google')
  if (!existing) {
    throw new Error('No Google account is connected yet.')
  }

  if (!isTokenExpired(existing.tokenExpiryAt, 60)) {
    return existing
  }

  if (!existing.refreshToken) {
    throw new Error('The Google connection has expired and needs to be reconnected.')
  }

  const refreshed = await refreshGoogleAccessToken(existing.refreshToken)
  return upsertGoogleConnectionRecord({
    provider: 'google',
    googleAccountId: existing.googleAccountId,
    email: existing.email,
    displayName: existing.displayName,
    pictureUrl: existing.pictureUrl,
    scope: existing.scope,
    accessToken: refreshed.access_token || existing.accessToken,
    refreshToken: refreshed.refresh_token || existing.refreshToken,
    tokenExpiryAt: buildExpiryTimestamp(refreshed.expires_in),
    now: new Date().toISOString(),
  })
}

async function exchangeCodeForTokens(code) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(20000),
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || 'Google token exchange failed.')
  }
  return payload
}

async function refreshGoogleAccessToken(refreshToken) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(20000),
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || 'Google token refresh failed.')
  }
  return payload
}

async function fetchGoogleUserProfile(accessToken) {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || 'Could not load the Google account profile.')
  }
  return payload
}

async function listGa4Properties(connection) {
  const accountSummaries = []
  let pageToken = ''

  while (true) {
    const params = new URLSearchParams({ pageSize: '200' })
    if (pageToken) params.set('pageToken', pageToken)
    const payload = await googleApiJson(
      connection,
      `https://analyticsadmin.googleapis.com/v1beta/accountSummaries?${params.toString()}`,
    )

    accountSummaries.push(...(payload.accountSummaries || []))
    if (!payload.nextPageToken) break
    pageToken = payload.nextPageToken
  }

  return accountSummaries
    .flatMap((summary) => (summary.propertySummaries || []).map((property) => ({
      id: String(property.property || '').replace('properties/', ''),
      property: property.property,
      displayName: property.displayName || `Property ${property.property}`,
      propertyType: property.propertyType || '',
      account: summary.account,
      accountDisplayName: summary.displayName || '',
    })))
    .filter((item) => item.id)
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
}

async function listGscProperties(connection) {
  const payload = await googleApiJson(connection, 'https://searchconsole.googleapis.com/webmasters/v3/sites')
  return (payload.siteEntry || [])
    .map((site) => ({
      siteUrl: site.siteUrl,
      displayName: site.siteUrl,
      permissionLevel: site.permissionLevel,
    }))
    .sort((left, right) => left.siteUrl.localeCompare(right.siteUrl))
}

async function fetchGa4SourceRows(connection, propertyId, startDate, endDate) {
  const payload = await googleApiJson(
    connection,
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: toIsoDate(startDate), endDate: toIsoDate(endDate) }],
        dimensions: [{ name: 'date' }, { name: 'sessionSourceMedium' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagedSessions' }],
        dimensionFilter: buildAiSourceFilter('sessionSourceMedium'),
        limit: 500,
      }),
    },
  )

  return (payload.rows || []).map((row) => ({
    date: row.dimensionValues?.[0]?.value || '',
    sessionSourceMedium: row.dimensionValues?.[1]?.value || '(not set)',
    sessions: Number(row.metricValues?.[0]?.value || 0),
    totalUsers: Number(row.metricValues?.[1]?.value || 0),
    engagedSessions: Number(row.metricValues?.[2]?.value || 0),
  }))
}

async function fetchGa4LandingRows(connection, propertyId, startDate, endDate) {
  const payload = await googleApiJson(
    connection,
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: toIsoDate(startDate), endDate: toIsoDate(endDate) }],
        dimensions: [{ name: 'landingPagePlusQueryString' }, { name: 'sessionSourceMedium' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagedSessions' }],
        dimensionFilter: buildAiSourceFilter('sessionSourceMedium'),
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 200,
      }),
    },
  )

  return (payload.rows || []).map((row) => ({
    landingPage: row.dimensionValues?.[0]?.value || '/',
    sessionSourceMedium: row.dimensionValues?.[1]?.value || '(not set)',
    sessions: Number(row.metricValues?.[0]?.value || 0),
    totalUsers: Number(row.metricValues?.[1]?.value || 0),
    engagedSessions: Number(row.metricValues?.[2]?.value || 0),
  }))
}

async function fetchGscPageRows(connection, siteUrl, startDate, endDate) {
  const payload = await googleApiJson(
    connection,
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate: toIsoDate(startDate),
        endDate: toIsoDate(endDate),
        dimensions: ['page'],
        rowLimit: 100,
      }),
    },
  )

  return (payload.rows || []).map((row) => ({
    page: row.keys?.[0] || '',
    clicks: Number(row.clicks || 0),
    impressions: Number(row.impressions || 0),
    ctr: Number(row.ctr || 0),
    position: Number(row.position || 0),
  }))
}

async function fetchGscPageQueryRows(connection, siteUrl, startDate, endDate) {
  const payload = await googleApiJson(
    connection,
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate: toIsoDate(startDate),
        endDate: toIsoDate(endDate),
        dimensions: ['page', 'query'],
        rowLimit: 250,
      }),
    },
  )

  return (payload.rows || []).map((row) => ({
    page: row.keys?.[0] || '',
    query: row.keys?.[1] || '',
    clicks: Number(row.clicks || 0),
    impressions: Number(row.impressions || 0),
  }))
}

async function googleApiJson(connection, url, init = {}) {
  const headers = new Headers(init.headers || {})
  headers.set('Authorization', `Bearer ${connection.accessToken}`)

  let response = await fetch(url, { ...init, headers, signal: init.signal || AbortSignal.timeout(30000) })
  if (response.status === 401 && connection.refreshToken) {
    const refreshed = await refreshGoogleAccessToken(connection.refreshToken)
    const updated = upsertGoogleConnectionRecord({
      provider: 'google',
      googleAccountId: connection.googleAccountId,
      email: connection.email,
      displayName: connection.displayName,
      pictureUrl: connection.pictureUrl,
      scope: connection.scope,
      accessToken: refreshed.access_token || connection.accessToken,
      refreshToken: refreshed.refresh_token || connection.refreshToken,
      tokenExpiryAt: buildExpiryTimestamp(refreshed.expires_in),
      now: new Date().toISOString(),
    })
    headers.set('Authorization', `Bearer ${updated.accessToken}`)
    response = await fetch(url, { ...init, headers, signal: init.signal || AbortSignal.timeout(30000) })
  }

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.error_description || 'Google API request failed.')
  }
  return payload
}

function buildAiSourceFilter(fieldName) {
  return {
    orGroup: {
      expressions: AI_SOURCE_BUCKETS.flatMap((bucket) => bucket.patterns.map((pattern) => ({
        filter: {
          fieldName,
          stringFilter: {
            matchType: 'CONTAINS',
            value: pattern,
            caseSensitive: false,
          },
        },
      }))),
    },
  }
}

function aggregateAiSources(rows) {
  const grouped = new Map()

  for (const row of rows) {
    const bucket = detectAiSourceBucket(row.sessionSourceMedium)
    const existing = grouped.get(bucket.id) || {
      id: bucket.id,
      label: bucket.label,
      sessions: 0,
      totalUsers: 0,
      engagedSessions: 0,
      rows: [],
    }

    existing.sessions += row.sessions
    existing.totalUsers += row.totalUsers
    existing.engagedSessions += row.engagedSessions
    existing.rows.push(row)
    grouped.set(bucket.id, existing)
  }

  const totalSessions = [...grouped.values()].reduce((sum, item) => sum + item.sessions, 0) || 1
  return [...grouped.values()]
    .sort((left, right) => right.sessions - left.sessions)
    .map((item) => ({
      ...item,
      share: item.sessions / totalSessions,
      topSourceMedium: item.rows.sort((left, right) => right.sessions - left.sessions)[0]?.sessionSourceMedium || item.label,
    }))
}

function buildDailyTrendSeries(rows, startDate, endDate) {
  const buckets = new Map()
  let cursor = new Date(startDate)
  const end = new Date(endDate)
  while (cursor <= end) {
    buckets.set(toIsoDate(cursor), { date: toIsoDate(cursor), totalSessions: 0, bySource: {} })
    cursor.setDate(cursor.getDate() + 1)
  }

  for (const row of rows) {
    const dateKey = normalizeGaDate(row.date)
    const bucket = buckets.get(dateKey)
    if (!bucket) continue
    const source = detectAiSourceBucket(row.sessionSourceMedium)
    bucket.totalSessions += row.sessions
    bucket.bySource[source.label] = (bucket.bySource[source.label] || 0) + row.sessions
  }

  return [...buckets.values()]
}

function aggregateLandingPages(rows, gscRows) {
  const gscByPath = new Map(
    gscRows.map((row) => [normalizePageKey(row.page), row]),
  )
  const grouped = new Map()

  for (const row of rows) {
    const key = normalizePageKey(row.landingPage)
    const bucket = detectAiSourceBucket(row.sessionSourceMedium)
    const existing = grouped.get(key) || {
      landingPage: row.landingPage || '/',
      sessions: 0,
      totalUsers: 0,
      engagedSessions: 0,
      sources: new Map(),
    }

    existing.sessions += row.sessions
    existing.totalUsers += row.totalUsers
    existing.engagedSessions += row.engagedSessions
    existing.sources.set(bucket.label, (existing.sources.get(bucket.label) || 0) + row.sessions)
    grouped.set(key, existing)
  }

  return [...grouped.entries()]
    .map(([key, item]) => {
      const gsc = gscByPath.get(key) || null
      const topSource = [...item.sources.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || null
      return {
        landingPage: item.landingPage,
        sessions: item.sessions,
        totalUsers: item.totalUsers,
        engagedSessions: item.engagedSessions,
        topSource,
        sourceMix: [...item.sources.entries()]
          .sort((left, right) => right[1] - left[1])
          .map(([label, sessions]) => ({ label, sessions })),
        gscClicks: gsc?.clicks ?? null,
        gscImpressions: gsc?.impressions ?? null,
        gscCtr: gsc?.ctr ?? null,
        gscPosition: gsc?.position ?? null,
      }
    })
    .sort((left, right) => right.sessions - left.sessions)
    .slice(0, 12)
}

function aggregateGscQueriesByPage(rows) {
  const grouped = new Map()

  for (const row of rows) {
    const key = normalizePageKey(row.page)
    const existing = grouped.get(key) || []
    existing.push({
      query: row.query,
      clicks: row.clicks,
      impressions: row.impressions,
    })
    grouped.set(key, existing)
  }

  for (const [key, values] of grouped.entries()) {
    grouped.set(
      key,
      values
        .sort((left, right) => right.clicks - left.clicks || right.impressions - left.impressions)
        .slice(0, 8),
    )
  }

  return grouped
}

function detectAiSourceBucket(value) {
  const normalized = String(value || '').toLowerCase()
  for (const bucket of AI_SOURCE_BUCKETS) {
    if (bucket.patterns.some((pattern) => normalized.includes(pattern))) {
      return bucket
    }
  }
  return { id: 'other-ai', label: 'Other AI' }
}

function normalizePageKey(value) {
  try {
    if (!value) return '/'
    if (/^https?:\/\//i.test(value)) {
      const parsed = new URL(value)
      return `${parsed.pathname}${parsed.search}` || '/'
    }
    return value.startsWith('/') ? value : `/${value}`
  } catch {
    return value || '/'
  }
}

function buildPromptTrafficConnections(landingPages, gscQueriesByPage) {
  const store = getAnswerVisibilityStoreSnapshot()
  const promptRecords = store.runs.slice(0, 120)
  const trafficPages = landingPages.slice(0, 12)
  const knownBrandTokens = [...new Set(
    store.runs
      .flatMap((run) => (run.mentionSummary?.brandMentions || []).map((mention) => mention.name))
      .flatMap((name) => tokenizeForMatch(name)),
  )]

  return trafficPages
    .map((page) => {
      const pageTokens = tokenizeForMatch(page.landingPage)
      const pageQueries = gscQueriesByPage.get(normalizePageKey(page.landingPage)) || []
      const matchedPrompts = promptRecords
        .map((run) => {
          const score = calculatePromptPageMatch(run.prompt, pageTokens, pageQueries, knownBrandTokens, run.mentionSummary?.brandMentions || [])
          if (score <= 0) return null
          const queryOverlap = pageQueries
            .map((query) => query.query)
            .filter((query) => calculateTokenOverlap(run.prompt, tokenizeForMatch(query)) > 0)
            .slice(0, 3)
          return {
            prompt: run.prompt,
            checkedAt: run.checkedAt,
            primaryBrandMentioned: run.mentionSummary?.primaryBrandMentioned ?? false,
            firstMentionedBrand: run.mentionSummary?.firstMentionedBrand ?? null,
            score,
            matchedQueries: queryOverlap,
          }
        })
        .filter(Boolean)
        .sort((left, right) => right.score - left.score)
        .slice(0, 3)

      if (matchedPrompts.length === 0) return null

      return {
        landingPage: page.landingPage,
        sessions: page.sessions,
        topSource: page.topSource,
        matchedPrompts,
      }
    })
    .filter(Boolean)
}

function calculatePromptPageMatch(prompt, pageTokens, pageQueries, knownBrandTokens, promptBrands) {
  const promptTokens = tokenizeForMatch(prompt)
  if (promptTokens.length === 0 || pageTokens.length === 0) return 0
  const pageOverlap = calculateTokenOverlap(prompt, pageTokens)
  const queryOverlap = Math.max(
    0,
    ...pageQueries.map((item) => calculateTokenOverlap(prompt, tokenizeForMatch(item.query))),
  )
  const promptBrandTokens = promptBrands.flatMap((brand) => tokenizeForMatch(brand.name))
  const brandOverlap = promptBrandTokens.filter((token) => knownBrandTokens.includes(token)).length
  return pageOverlap * 2 + queryOverlap * 3 + Math.min(2, brandOverlap)
}

function calculateTokenOverlap(text, candidateTokens) {
  const promptTokens = tokenizeForMatch(text)
  return promptTokens.filter((token) => candidateTokens.includes(token)).length
}

function tokenizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/[^/\s]+/g, ' ')
    .replace(/[^a-z0-9\s/-]/g, ' ')
    .split(/[\s/-]+/)
    .filter((token) => token.length > 2)
}

function computeAiTrafficScore({ totalSessions, totalUsers, engagedSessions, landingPages, sourceBuckets }) {
  if (totalSessions <= 0) {
    return { value: 0, grade: 'E', label: 'No AI traffic detected yet' }
  }

  const engagementRate = totalSessions > 0 ? engagedSessions / totalSessions : 0
  const topSourceShare = sourceBuckets[0]?.share ?? 0
  const diversifiedSources = sourceBuckets.length
  const pageSpread = landingPages.length
  const qualityClicks = landingPages.reduce((sum, page) => sum + (page.gscClicks ?? 0), 0)

  let value = 0
  const volumePoints = Math.min(30, totalSessions * 1.2)
  const engagementPoints = Math.min(22, engagementRate * 40)
  const diversificationPoints = Math.min(14, diversifiedSources * 3)
  const spreadPoints = Math.min(14, pageSpread * 2)
  const qualityPoints = Math.min(10, qualityClicks / 2)
  const concentrationPenalty = topSourceShare > 0.65 ? 6 : 0

  value += volumePoints
  value += engagementPoints
  value += diversificationPoints
  value += spreadPoints
  value += qualityPoints
  value -= concentrationPenalty

  const rounded = Math.max(0, Math.min(100, Math.round(value)))
  return {
    value: rounded,
    grade: rounded >= 85 ? 'A' : rounded >= 72 ? 'B' : rounded >= 58 ? 'C' : rounded >= 42 ? 'D' : 'E',
    label:
      rounded >= 85 ? 'Strong AI traffic footprint'
        : rounded >= 72 ? 'Healthy AI traffic presence'
        : rounded >= 58 ? 'Emerging AI traffic'
            : rounded >= 42 ? 'Weak AI traffic visibility'
              : 'Very limited AI traffic visibility',
    components: [
      { label: 'Traffic volume', points: Math.round(volumePoints), maxPoints: 30, detail: `${totalSessions} AI sessions in the selected period.` },
      { label: 'Engagement quality', points: Math.round(engagementPoints), maxPoints: 22, detail: `${engagedSessions} engaged sessions from AI sources.` },
      { label: 'Source diversity', points: Math.round(diversificationPoints), maxPoints: 14, detail: `${diversifiedSources} AI sources contributed traffic.` },
      { label: 'Landing-page spread', points: Math.round(spreadPoints), maxPoints: 14, detail: `${pageSpread} landing pages captured AI sessions.` },
      { label: 'Search support', points: Math.round(qualityPoints), maxPoints: 10, detail: `${qualityClicks} Search Console clicks were recorded across AI landing pages.` },
      { label: 'Source concentration penalty', points: -Math.round(concentrationPenalty), maxPoints: 0, detail: topSourceShare > 0.65 ? 'One AI source dominates the mix, which reduces resilience.' : 'Traffic is not overly concentrated in one AI source.' },
    ],
  }
}

function buildSourceTrendRows(currentSources, previousSources) {
  const previousById = new Map(previousSources.map((source) => [source.id, source]))
  return currentSources.map((source) => {
    const previous = previousById.get(source.id)
    return {
      ...source,
      previousSessions: previous?.sessions ?? 0,
      sessionDelta: source.sessions - (previous?.sessions ?? 0),
      previousShare: previous?.share ?? 0,
      shareDelta: source.share - (previous?.share ?? 0),
    }
  })
}

function normalizeGaDate(value) {
  const raw = String(value || '')
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  }
  return raw
}

function buildExpiryTimestamp(expiresInSeconds) {
  const seconds = Number(expiresInSeconds || 3600)
  return new Date(Date.now() + seconds * 1000).toISOString()
}

function isTokenExpired(tokenExpiryAt, skewSeconds = 0) {
  if (!tokenExpiryAt) return true
  return new Date(tokenExpiryAt).getTime() <= Date.now() + skewSeconds * 1000
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10)
}
