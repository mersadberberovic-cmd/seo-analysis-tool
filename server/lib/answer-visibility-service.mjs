import { createAnswerVisibilityId, readAnswerVisibilityStore, writeAnswerVisibilityStore } from './answer-visibility-store.mjs'

const OPENAI_MODEL = process.env.OPENAI_VISIBILITY_MODEL || 'gpt-5-mini'
const GEMINI_MODEL = process.env.GEMINI_VISIBILITY_MODEL || 'gemini-2.5-flash'

export async function runAnswerVisibilityChecks(input) {
  const store = readAnswerVisibilityStore()
  const now = new Date().toISOString()
  const campaign = upsertCampaign(store, input, now)
  const brands = upsertBrands(store, campaign.id, input, now)
  const prompts = upsertPrompts(store, campaign.id, input.prompts, now)
  const promptIds = new Set(prompts.map((item) => item.id))
  const brandIds = new Set(brands.map((item) => item.id))

  const runs = []
  for (const promptRecord of prompts) {
    if (!promptIds.has(promptRecord.id)) continue

    const answerPayload = await generateAnswer({
      prompt: promptRecord.prompt,
      providerPreference: input.providerPreference ?? 'auto',
    })

    const mentionAnalysis = detectBrandMentions({
      answerText: answerPayload.answerText,
      citations: answerPayload.citations,
      brands,
    })

    const previousRun = [...store.runs]
      .filter((run) => run.promptId === promptRecord.id)
      .sort((left, right) => right.checkedAt.localeCompare(left.checkedAt))[0]

    const runRecord = {
      id: createAnswerVisibilityId('run'),
      campaignId: campaign.id,
      promptId: promptRecord.id,
      checkedAt: now,
      provider: answerPayload.provider,
      model: answerPayload.model,
      configuration: answerPayload.configuration,
      rawAnswerText: answerPayload.answerText,
      answerSnapshot: answerPayload.answerText.slice(0, 280),
      citations: answerPayload.citations.map((citation) => ({
        id: createAnswerVisibilityId('citation'),
        url: citation.url,
        domain: citation.domain,
        title: citation.title,
      })),
      surfacedDomains: unique(answerPayload.citations.map((citation) => citation.domain).filter(Boolean)),
      sourceCount: answerPayload.citations.length,
      mentionSummary: mentionAnalysis,
      previousRunId: previousRun?.id ?? null,
      deltas: buildRunDeltas(previousRun, mentionAnalysis),
      projectTag: promptRecord.projectTag ?? campaign.name,
      intent: promptRecord.intent,
      tags: promptRecord.tags,
    }

    store.runs.push(runRecord)
    runs.push(runRecord)
  }

  updateSummarySnapshots(store, campaign.id, brandIds)
  writeAnswerVisibilityStore(store)

  return {
    campaign,
    brands,
    prompts,
    runs,
    summary: computeSummaryMetrics(store, {
      campaignId: campaign.id,
    }),
  }
}

export async function rerunAnswerVisibilityChecks(input) {
  const store = readAnswerVisibilityStore()
  const promptRecords = store.prompts.filter((prompt) => input.promptIds.includes(prompt.id))
  if (promptRecords.length === 0) {
    return { runs: [], summary: null }
  }

  const campaign = store.campaigns.find((item) => item.id === promptRecords[0].campaignId)
  if (!campaign) {
    throw new Error('Campaign not found for rerun.')
  }

  const brands = store.brands.filter((item) => item.campaignId === campaign.id)
  const now = new Date().toISOString()
  const runs = []

  for (const promptRecord of promptRecords) {
    const answerPayload = await generateAnswer({
      prompt: promptRecord.prompt,
      providerPreference: input.providerPreference ?? 'auto',
    })

    const mentionAnalysis = detectBrandMentions({
      answerText: answerPayload.answerText,
      citations: answerPayload.citations,
      brands,
    })

    const previousRun = [...store.runs]
      .filter((run) => run.promptId === promptRecord.id)
      .sort((left, right) => right.checkedAt.localeCompare(left.checkedAt))[0]

    const runRecord = {
      id: createAnswerVisibilityId('run'),
      campaignId: campaign.id,
      promptId: promptRecord.id,
      checkedAt: now,
      provider: answerPayload.provider,
      model: answerPayload.model,
      configuration: answerPayload.configuration,
      rawAnswerText: answerPayload.answerText,
      answerSnapshot: answerPayload.answerText.slice(0, 280),
      citations: answerPayload.citations.map((citation) => ({
        id: createAnswerVisibilityId('citation'),
        url: citation.url,
        domain: citation.domain,
        title: citation.title,
      })),
      surfacedDomains: unique(answerPayload.citations.map((citation) => citation.domain).filter(Boolean)),
      sourceCount: answerPayload.citations.length,
      mentionSummary: mentionAnalysis,
      previousRunId: previousRun?.id ?? null,
      deltas: buildRunDeltas(previousRun, mentionAnalysis),
      projectTag: promptRecord.projectTag ?? campaign.name,
      intent: promptRecord.intent,
      tags: promptRecord.tags,
    }

    store.runs.push(runRecord)
    runs.push(runRecord)
  }

  updateSummarySnapshots(store, campaign.id, new Set(brands.map((item) => item.id)))
  writeAnswerVisibilityStore(store)

  return {
    campaign,
    runs,
    summary: computeSummaryMetrics(store, { campaignId: campaign.id }),
  }
}

export function listCampaigns() {
  const store = readAnswerVisibilityStore()
  return store.campaigns.map((campaign) => ({
    ...campaign,
    promptCount: store.prompts.filter((item) => item.campaignId === campaign.id).length,
    runCount: store.runs.filter((item) => item.campaignId === campaign.id).length,
    brands: store.brands.filter((item) => item.campaignId === campaign.id),
  }))
}

export function getAnswerVisibilityOverview(filters = {}) {
  const store = readAnswerVisibilityStore()
  const filteredRuns = filterRuns(store, filters)
  return {
    records: filteredRuns.map((run) => formatRunRecord(store, run)),
    summary: computeSummaryMetrics(store, filters, filteredRuns),
    campaigns: listCampaigns(),
  }
}

export function exportAnswerVisibilityCsv(filters = {}) {
  const store = readAnswerVisibilityStore()
  const filteredRuns = filterRuns(store, filters)
  const records = filteredRuns.map((run) => formatRunRecord(store, run))
  const headers = [
    'campaign',
    'project_tag',
    'prompt',
    'intent',
    'checked_at',
    'provider',
    'model',
    'brand_mentioned',
    'primary_brand_mentions',
    'competitor_mentions',
    'first_mentioned_brand',
    'primary_brand_first_position',
    'surfed_domains',
    'source_count',
    'answer_snapshot',
  ]

  const rows = records.map((record) => [
    record.campaignName,
    record.projectTag,
    record.prompt,
    record.intent,
    record.checkedAt,
    record.provider,
    record.model,
    record.primaryBrandMentioned ? 'yes' : 'no',
    String(record.primaryBrandMentionCount),
    record.competitorMentionCounts.map((item) => `${item.name}:${item.count}`).join('; '),
    record.firstMentionedBrand ?? '',
    record.primaryBrandFirstPosition !== null ? String(record.primaryBrandFirstPosition) : '',
    record.surfacedDomains.join('; '),
    String(record.sourceCount),
    record.answerSnapshot,
  ])

  return [headers, ...rows].map((row) => row.map(escapeCsvValue).join(',')).join('\n')
}

function upsertCampaign(store, input, now) {
  const name = String(input.campaignName || input.projectTag || 'Untitled campaign').trim()
  let campaign = store.campaigns.find((item) => normalizeText(item.name) === normalizeText(name))

  if (!campaign) {
    campaign = {
      id: createAnswerVisibilityId('campaign'),
      name,
      projectTag: input.projectTag || name,
      createdAt: now,
      updatedAt: now,
    }
    store.campaigns.push(campaign)
  } else {
    campaign.projectTag = input.projectTag || campaign.projectTag
    campaign.updatedAt = now
  }

  return campaign
}

function upsertBrands(store, campaignId, input, now) {
  const desired = [
    {
      type: 'primary',
      name: String(input.primaryBrand?.name || '').trim(),
      variations: normalizeVariations(input.primaryBrand?.variations || []),
    },
    ...(input.competitorBrands || []).map((item) => ({
      type: 'competitor',
      name: String(item.name || '').trim(),
      variations: normalizeVariations(item.variations || []),
    })),
  ].filter((item) => item.name)

  return desired.map((brandInput) => {
    let existing = store.brands.find((brand) =>
      brand.campaignId === campaignId &&
      brand.type === brandInput.type &&
      normalizeText(brand.name) === normalizeText(brandInput.name),
    )

    if (!existing) {
      existing = {
        id: createAnswerVisibilityId('brand'),
        campaignId,
        type: brandInput.type,
        name: brandInput.name,
        variations: brandInput.variations,
        createdAt: now,
        updatedAt: now,
      }
      store.brands.push(existing)
    } else {
      existing.variations = unique([...existing.variations, ...brandInput.variations])
      existing.updatedAt = now
    }

    return existing
  })
}

function upsertPrompts(store, campaignId, prompts, now) {
  return prompts
    .map((item) => ({
      prompt: String(item.prompt || '').trim(),
      intent: String(item.intent || 'informational').trim(),
      tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
      projectTag: String(item.projectTag || '').trim(),
    }))
    .filter((item) => item.prompt)
    .map((promptInput) => {
      let existing = store.prompts.find((prompt) =>
        prompt.campaignId === campaignId &&
        normalizeText(prompt.prompt) === normalizeText(promptInput.prompt),
      )

      if (!existing) {
        existing = {
          id: createAnswerVisibilityId('prompt'),
          campaignId,
          prompt: promptInput.prompt,
          intent: promptInput.intent,
          tags: promptInput.tags,
          projectTag: promptInput.projectTag,
          createdAt: now,
          updatedAt: now,
        }
        store.prompts.push(existing)
      } else {
        existing.intent = promptInput.intent || existing.intent
        existing.tags = unique([...existing.tags, ...promptInput.tags])
        existing.projectTag = promptInput.projectTag || existing.projectTag
        existing.updatedAt = now
      }

      return existing
    })
}

async function generateAnswer({ prompt, providerPreference }) {
  if ((providerPreference === 'auto' || providerPreference === 'openai') && process.env.OPENAI_API_KEY) {
    return generateOpenAiAnswer(prompt)
  }

  if ((providerPreference === 'auto' || providerPreference === 'gemini') && process.env.GEMINI_API_KEY) {
    return generateGeminiAnswer(prompt)
  }

  throw new Error('No supported AI answer provider is configured. Add OPENAI_API_KEY or GEMINI_API_KEY.')
}

async function generateOpenAiAnswer(prompt) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      tools: [{ type: 'web_search' }],
      store: false,
    }),
    signal: AbortSignal.timeout(35000),
  })

  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    throw new Error(`OpenAI answer request failed. ${extractApiError(raw)}`)
  }

  const payload = await response.json()
  const answerText = extractOpenAiOutputText(payload)
  const citations = extractOpenAiCitations(payload)

  return {
    provider: 'openai',
    model: payload.model || OPENAI_MODEL,
    configuration: {
      tool: 'web_search',
      provider: 'openai',
    },
    answerText,
    citations,
  }
}

async function generateGeminiAnswer(prompt) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
    }),
    signal: AbortSignal.timeout(35000),
  })

  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    throw new Error(`Gemini answer request failed. ${extractApiError(raw)}`)
  }

  const payload = await response.json()
  const answerText = payload?.candidates?.[0]?.content?.parts?.map((item) => item.text || '').join('\n').trim() || ''
  const citations = extractGeminiCitations(payload)

  return {
    provider: 'gemini',
    model: GEMINI_MODEL,
    configuration: {
      tool: 'google_search',
      provider: 'gemini',
    },
    answerText,
    citations,
  }
}

function extractOpenAiOutputText(payload) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim()
  }

  const parts = []
  for (const item of payload.output || []) {
    if (item.type === 'message') {
      for (const content of item.content || []) {
        if (content.type === 'output_text' && content.text) {
          parts.push(content.text)
        }
      }
    }
  }
  return parts.join('\n').trim()
}

function extractOpenAiCitations(payload) {
  const citations = []

  const visit = (value) => {
    if (!value || typeof value !== 'object') return

    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }

    if (typeof value.url === 'string' && value.url.startsWith('http')) {
      citations.push({
        url: value.url,
        domain: extractDomain(value.url),
        title: value.title || value.text || '',
      })
    }

    Object.values(value).forEach(visit)
  }

  visit(payload)
  return dedupeCitations(citations)
}

function extractGeminiCitations(payload) {
  const citations = []
  const chunks = payload?.candidates?.[0]?.groundingMetadata?.groundingChunks || []

  for (const chunk of chunks) {
    const uri = chunk?.web?.uri
    if (!uri) continue
    citations.push({
      url: uri,
      domain: extractDomain(uri),
      title: chunk?.web?.title || '',
    })
  }

  return dedupeCitations(citations)
}

function detectBrandMentions({ answerText, citations, brands }) {
  const normalizedAnswer = normalizeText(answerText)
  const citationText = normalizeText(citations.map((item) => `${item.title} ${item.domain}`).join(' '))
  const mentionDetails = brands.map((brand) => {
    const phrases = unique([brand.name, ...brand.variations].map((item) => normalizeText(item)).filter(Boolean))
    const answerPositions = phrases.flatMap((phrase) => findPhrasePositions(normalizedAnswer, phrase))
    const citationPositions = phrases.flatMap((phrase) => findPhrasePositions(citationText, phrase))
    const answerCount = answerPositions.length
    const citationCount = citationPositions.length
    const totalCount = answerCount + citationCount
    const firstPosition = answerPositions.length > 0 ? Math.min(...answerPositions) : null
    const appearsIn = answerCount > 0 && citationCount > 0
      ? 'both'
      : answerCount > 0
        ? 'answer'
        : citationCount > 0
          ? 'citations'
          : 'none'

    return {
      brandId: brand.id,
      name: brand.name,
      type: brand.type,
      answerCount,
      citationCount,
      totalCount,
      firstPosition,
      appearsIn,
    }
  })

  const sortedByPosition = mentionDetails
    .filter((item) => item.firstPosition !== null)
    .sort((left, right) => left.firstPosition - right.firstPosition)

  const primary = mentionDetails.find((item) => item.type === 'primary') || null
  const competitors = mentionDetails.filter((item) => item.type === 'competitor')
  const totalMentions = mentionDetails.reduce((sum, item) => sum + item.totalCount, 0)

  return {
    brandMentions: mentionDetails,
    primaryBrandMentioned: Boolean(primary && primary.totalCount > 0),
    primaryBrandMentionCount: primary?.totalCount ?? 0,
    primaryBrandFirstPosition: primary?.firstPosition ?? null,
    firstMentionedBrand: sortedByPosition[0]?.name ?? null,
    firstMentionedBrandId: sortedByPosition[0]?.brandId ?? null,
    competitorMentionCounts: competitors.map((item) => ({
      brandId: item.brandId,
      name: item.name,
      count: item.totalCount,
      firstPosition: item.firstPosition,
    })),
    totalMentions,
    shareOfMentions: mentionDetails.map((item) => ({
      brandId: item.brandId,
      name: item.name,
      share: totalMentions > 0 ? item.totalCount / totalMentions : 0,
    })),
  }
}

function buildRunDeltas(previousRun, currentMentionSummary) {
  if (!previousRun) {
    return {
      primaryPresenceDelta: null,
      primaryMentionCountDelta: null,
      primaryFirstPositionDelta: null,
    }
  }

  return {
    primaryPresenceDelta: Number(currentMentionSummary.primaryBrandMentioned) - Number(previousRun.mentionSummary.primaryBrandMentioned),
    primaryMentionCountDelta: currentMentionSummary.primaryBrandMentionCount - previousRun.mentionSummary.primaryBrandMentionCount,
    primaryFirstPositionDelta:
      currentMentionSummary.primaryBrandFirstPosition === null || previousRun.mentionSummary.primaryBrandFirstPosition === null
        ? null
        : currentMentionSummary.primaryBrandFirstPosition - previousRun.mentionSummary.primaryBrandFirstPosition,
  }
}

function updateSummarySnapshots(store, campaignId, brandIds) {
  const checkedAt = new Date().toISOString()
  const metrics = computeSummaryMetrics(store, { campaignId })
  const existing = store.summarySnapshots.find((item) => item.campaignId === campaignId)

  const nextSnapshot = {
    id: existing?.id ?? createAnswerVisibilityId('summary'),
    campaignId,
    brandIds: [...brandIds],
    checkedAt,
    metrics,
  }

  store.summarySnapshots = store.summarySnapshots.filter((item) => item.campaignId !== campaignId)
  store.summarySnapshots.push(nextSnapshot)
}

function computeSummaryMetrics(store, filters = {}, filteredRuns = null) {
  const runs = filteredRuns ?? filterRuns(store, filters)
  const formattedRecords = runs.map((run) => formatRunRecord(store, run))
  const brands = store.brands.filter((brand) => !filters.campaignId || brand.campaignId === filters.campaignId)
  const primary = brands.find((brand) => brand.type === 'primary')
  const competitors = brands.filter((brand) => brand.type === 'competitor')
  const runCount = formattedRecords.length

  const primaryPresenceCount = formattedRecords.filter((record) => record.primaryBrandMentioned).length
  const competitorPresenceCount = formattedRecords.filter((record) => record.competitorMentionCounts.some((item) => item.count > 0)).length
  const promptsCompetitorsWithoutPrimary = formattedRecords.filter((record) =>
    !record.primaryBrandMentioned && record.competitorMentionCounts.some((item) => item.count > 0),
  )
  const promptsPrimaryFirst = formattedRecords.filter((record) => record.firstMentionedBrand === primary?.name)

  const averageMentionCountPerBrand = brands.map((brand) => {
    const total = formattedRecords.reduce((sum, record) => {
      const mention = record.brandMentions.find((item) => item.brandId === brand.id)
      return sum + (mention?.totalCount ?? 0)
    }, 0)

    return {
      brandId: brand.id,
      name: brand.name,
      average: runCount > 0 ? total / runCount : 0,
    }
  })

  const firstPositionValues = formattedRecords
    .map((record) => record.primaryBrandFirstPosition)
    .filter((value) => value !== null)

  const allMentionTotals = brands.map((brand) => ({
    brandId: brand.id,
    name: brand.name,
    total: formattedRecords.reduce((sum, record) => {
      const mention = record.brandMentions.find((item) => item.brandId === brand.id)
      return sum + (mention?.totalCount ?? 0)
    }, 0),
  }))
  const totalMentions = allMentionTotals.reduce((sum, item) => sum + item.total, 0)

  const domainCounts = new Map()
  formattedRecords.forEach((record) => {
    record.surfacedDomains.forEach((domain) => {
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1)
    })
  })

  return {
    runCount,
    brandPresenceRate: runCount > 0 ? primaryPresenceCount / runCount : 0,
    competitorPresenceRate: runCount > 0 ? competitorPresenceCount / runCount : 0,
    averageMentionCountPerBrand,
    averageFirstPositionScore: firstPositionValues.length > 0
      ? firstPositionValues.reduce((sum, value) => sum + value, 0) / firstPositionValues.length
      : null,
    mentionShare: allMentionTotals.map((item) => ({
      ...item,
      share: totalMentions > 0 ? item.total / totalMentions : 0,
    })),
    mostFrequentlyCitedDomains: [...domainCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([domain, count]) => ({ domain, count })),
    promptsWhereCompetitorsButNotPrimary: promptsCompetitorsWithoutPrimary.map((item) => ({
      runId: item.id,
      prompt: item.prompt,
    })),
    promptsWherePrimaryAppearedFirst: promptsPrimaryFirst.map((item) => ({
      runId: item.id,
      prompt: item.prompt,
    })),
    primaryBrand: primary?.name ?? null,
    competitors: competitors.map((brand) => brand.name),
  }
}

function filterRuns(store, filters) {
  return store.runs.filter((run) => {
    if (filters.campaignId && run.campaignId !== filters.campaignId) return false
    if (filters.projectTag && normalizeText(run.projectTag) !== normalizeText(filters.projectTag)) return false
    if (filters.intent && normalizeText(run.intent) !== normalizeText(filters.intent)) return false
    if (filters.dateFrom && run.checkedAt < filters.dateFrom) return false
    if (filters.dateTo && run.checkedAt > filters.dateTo) return false

    if (filters.mentionStatus) {
      const mentioned = run.mentionSummary.primaryBrandMentioned
      if (filters.mentionStatus === 'mentioned' && !mentioned) return false
      if (filters.mentionStatus === 'not-mentioned' && mentioned) return false
    }

    if (filters.brandId) {
      const brandMention = run.mentionSummary.brandMentions.find((item) => item.brandId === filters.brandId)
      if (!brandMention || brandMention.totalCount === 0) return false
    }

    if (filters.competitorId) {
      const competitorMention = run.mentionSummary.brandMentions.find((item) => item.brandId === filters.competitorId)
      if (!competitorMention || competitorMention.totalCount === 0) return false
    }

    return true
  })
}

function formatRunRecord(store, run) {
  const promptRecord = store.prompts.find((item) => item.id === run.promptId)
  const campaign = store.campaigns.find((item) => item.id === run.campaignId)

  return {
    id: run.id,
    promptId: run.promptId,
    prompt: promptRecord?.prompt ?? '',
    checkedAt: run.checkedAt,
    campaignId: run.campaignId,
    campaignName: campaign?.name ?? '',
    projectTag: run.projectTag,
    intent: run.intent,
    provider: run.provider,
    model: run.model,
    primaryBrandMentioned: run.mentionSummary.primaryBrandMentioned,
    primaryBrandMentionCount: run.mentionSummary.primaryBrandMentionCount,
    competitorMentionCounts: run.mentionSummary.competitorMentionCounts,
    firstMentionedBrand: run.mentionSummary.firstMentionedBrand,
    primaryBrandFirstPosition: run.mentionSummary.primaryBrandFirstPosition,
    surfacedDomains: run.surfacedDomains,
    sourceCount: run.sourceCount,
    answerSnapshot: run.answerSnapshot,
    rawAnswerText: run.rawAnswerText,
    brandMentions: run.mentionSummary.brandMentions,
    deltas: run.deltas,
  }
}

function dedupeCitations(items) {
  const seen = new Set()
  return items.filter((item) => {
    if (!item.url) return false
    const key = `${item.url}::${item.title || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function normalizeVariations(items) {
  return unique(items.map((item) => String(item).trim()).filter(Boolean))
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function unique(items) {
  return [...new Set(items)]
}

function findPhrasePositions(text, phrase) {
  if (!phrase) return []

  const positions = []
  let searchIndex = 0
  while (searchIndex < text.length) {
    const nextIndex = text.indexOf(phrase, searchIndex)
    if (nextIndex === -1) break
    positions.push(text.slice(0, nextIndex).split(/\s+/).filter(Boolean).length + 1)
    searchIndex = nextIndex + phrase.length
  }

  return positions
}

function escapeCsvValue(value) {
  const text = String(value ?? '')
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function extractApiError(rawBody) {
  try {
    const parsed = JSON.parse(rawBody)
    return parsed?.error?.message || rawBody || 'Unexpected API error.'
  } catch {
    return rawBody || 'Unexpected API error.'
  }
}
