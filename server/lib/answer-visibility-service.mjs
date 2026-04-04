import {
  createAnswerVisibilityId,
  createAnswerVisibilityJobRecord,
  createRunConfigRecord,
  findCampaignById,
  findLatestRunForPrompt,
  getAnswerVisibilityJobRecord,
  getAnswerVisibilityStoreSnapshot,
  getBrandsForCampaign,
  getCampaignRunRecords,
  getPromptRecordsByIds,
  getProviderHealthRecords,
  initializeAnswerVisibilityDb,
  insertRunRecord,
  listQueuedAnswerVisibilityJobs,
  replaceSummarySnapshot,
  saveProviderHealthRecord,
  upsertBrandRecords,
  upsertCampaignRecord,
  upsertPromptRecords,
  updateAnswerVisibilityJobStatus,
} from './answer-visibility-store.mjs'

const OPENAI_MODEL = process.env.OPENAI_VISIBILITY_MODEL || 'gpt-5-mini'
const GEMINI_MODEL = process.env.GEMINI_VISIBILITY_MODEL || 'gemini-2.5-flash'
const PROMPT_VERSION = 'ai-answer-visibility-v1'
const PROVIDER_HEALTH_TTL_MS = 5 * 60 * 1000
const EXCLUDED_SURFACED_DOMAINS = [
  'cloud.google.com',
  'support.google.com',
  'developers.google.com',
  'workspace.google.com',
  'platform.openai.com',
  'openai.com',
  'ai.google.dev',
  'googleapis.com',
  'accounts.google.com',
]

let workerStarted = false
let queueTickScheduled = false
let queueProcessing = false

export function startAnswerVisibilityWorker() {
  initializeAnswerVisibilityDb()
  if (workerStarted) return
  workerStarted = true
  scheduleQueueTick()
}

export async function enqueueAnswerVisibilityRun(input) {
  const now = new Date().toISOString()
  const campaign = upsertCampaignRecord({
    name: String(input.campaignName || input.projectTag || 'Untitled campaign').trim(),
    projectTag: String(input.projectTag || input.campaignName || 'Untitled campaign').trim(),
    now,
  })

  const brands = upsertBrandRecords({
    campaignId: campaign.id,
    now,
    brands: [
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
    ].filter((item) => item.name),
  })

  const prompts = upsertPromptRecords({
    campaignId: campaign.id,
    now,
    prompts: (input.prompts || []).map((item) => ({
      prompt: String(item.prompt || '').trim(),
      intent: String(item.intent || 'informational').trim(),
      projectTag: String(item.projectTag || input.projectTag || campaign.projectTag).trim(),
      tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
    })).filter((item) => item.prompt),
  })

  if (prompts.length === 0) {
    throw new Error('At least one prompt is required.')
  }

  const payload = {
    campaignId: campaign.id,
    brandIds: brands.map((item) => item.id),
    promptIds: prompts.map((item) => item.id),
    providerPreference: String(input.providerPreference || 'auto'),
    requestedBy: 'ui',
  }

  const job = createAnswerVisibilityJobRecord({
    campaignId: campaign.id,
    type: 'run',
    providerPreference: payload.providerPreference,
    payload,
    promptCount: prompts.length,
    requestedAt: now,
  })

  createRunConfigRecord({
    jobId: job.id,
    providerPreference: payload.providerPreference,
    promptVersion: PROMPT_VERSION,
    config: {
      workflow: 'ai-answer-visibility',
      promptVersion: PROMPT_VERSION,
      providerPreference: payload.providerPreference,
      tools: {
        openai: 'web_search',
        gemini: 'google_search',
      },
    },
    createdAt: now,
  })

  scheduleQueueTick()

  return {
    job,
    campaign,
    brands,
    prompts,
  }
}

export async function enqueueAnswerVisibilityRerun(input) {
  const promptIds = Array.isArray(input.promptIds) ? input.promptIds.map((item) => String(item)) : []
  if (promptIds.length === 0) {
    throw new Error('At least one prompt id is required for rerun.')
  }

  const prompts = getPromptRecordsByIds(promptIds)
  if (prompts.length === 0) {
    throw new Error('No saved prompts were found for rerun.')
  }

  const campaign = findCampaignById(prompts[0].campaignId)
  if (!campaign) {
    throw new Error('Campaign not found for rerun.')
  }

  const now = new Date().toISOString()
  const providerPreference = String(input.providerPreference || 'auto')
  const payload = {
    campaignId: campaign.id,
    promptIds: prompts.map((item) => item.id),
    brandIds: getBrandsForCampaign(campaign.id).map((item) => item.id),
    providerPreference,
    requestedBy: 'ui-rerun',
  }

  const job = createAnswerVisibilityJobRecord({
    campaignId: campaign.id,
    type: 'rerun',
    providerPreference,
    payload,
    promptCount: prompts.length,
    requestedAt: now,
  })

  createRunConfigRecord({
    jobId: job.id,
    providerPreference,
    promptVersion: PROMPT_VERSION,
    config: {
      workflow: 'ai-answer-visibility-rerun',
      promptVersion: PROMPT_VERSION,
      providerPreference,
    },
    createdAt: now,
  })

  scheduleQueueTick()

  return {
    job,
    campaign,
  }
}

export function getAnswerVisibilityJob(jobId) {
  return getAnswerVisibilityJobRecord(jobId)
}

export function listCampaigns() {
  const store = getAnswerVisibilityStoreSnapshot()
  return store.campaigns.map((campaign) => ({
    ...campaign,
    promptCount: store.prompts.filter((item) => item.campaignId === campaign.id).length,
    runCount: store.runs.filter((item) => item.campaignId === campaign.id).length,
    brands: store.brands.filter((item) => item.campaignId === campaign.id),
  }))
}

export function getAnswerVisibilityOverview(filters = {}) {
  const store = getAnswerVisibilityStoreSnapshot()
  const filteredRuns = filterRuns(store, filters)
  return {
    records: filteredRuns.map((run) => formatRunRecord(store, run)),
    summary: computeSummaryMetrics(store, filters, filteredRuns),
    campaigns: listCampaigns(),
  }
}

export function exportAnswerVisibilityCsv(filters = {}) {
  const store = getAnswerVisibilityStoreSnapshot()
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
    'surfaced_domains',
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

export async function getProviderHealthStatus({ forceRefresh = false } = {}) {
  const cached = getProviderHealthRecords()
  const now = Date.now()

  if (!forceRefresh) {
    const freshEnough = cached.every((item) => now - new Date(item.checkedAt).getTime() < PROVIDER_HEALTH_TTL_MS)
    if (freshEnough && cached.length > 0) {
      return {
        checkedAt: new Date().toISOString(),
        providers: cached,
      }
    }
  }

  const providers = [
    await pingOpenAiProvider(),
    await pingGeminiProvider(),
  ]

  return {
    checkedAt: new Date().toISOString(),
    providers,
  }
}

function scheduleQueueTick() {
  if (queueTickScheduled) return
  queueTickScheduled = true
  setTimeout(async () => {
    queueTickScheduled = false
    await processQueue().catch((error) => {
      console.error('AI Answer Visibility queue failed.', error)
    })
  }, 0)
}

async function processQueue() {
  if (queueProcessing) return
  queueProcessing = true

  try {
    while (true) {
      const nextJob = listQueuedAnswerVisibilityJobs()[0]
      if (!nextJob) break
      await processJob(nextJob)
    }
  } finally {
    queueProcessing = false
  }
}

async function processJob(job) {
  const startedAt = new Date().toISOString()
  updateAnswerVisibilityJobStatus({
    jobId: job.id,
    status: 'running',
    startedAt,
    updatedAt: startedAt,
    completedRuns: 0,
    errorMessage: null,
  })

  try {
    const payload = job.payload || {}
    const campaign = findCampaignById(payload.campaignId)
    if (!campaign) {
      throw new Error('Campaign not found for queued job.')
    }

    const prompts = getPromptRecordsByIds(payload.promptIds || [])
    const brands = getBrandsForCampaign(campaign.id)
    const runs = []

    for (let index = 0; index < prompts.length; index += 1) {
      const promptRecord = prompts[index]
      const checkedAt = new Date().toISOString()
      const answerPayload = await generateAnswer({
        prompt: promptRecord.prompt,
        providerPreference: payload.providerPreference || job.providerPreference || 'auto',
      })

      const mentionAnalysis = detectBrandMentions({
        answerText: answerPayload.answerText,
        citations: answerPayload.citations,
        brands,
      })

      const previousRun = findLatestRunForPrompt(promptRecord.id)
      const runRecord = insertRunRecord({
        campaignId: campaign.id,
        promptId: promptRecord.id,
        jobId: job.id,
        checkedAt,
        provider: answerPayload.provider,
        model: answerPayload.model,
        configuration: answerPayload.configuration,
        rawAnswerText: answerPayload.answerText,
        answerSnapshot: answerPayload.answerText.slice(0, 280),
        surfacedDomains: unique(answerPayload.citations.map((citation) => citation.domain).filter(Boolean)),
        sourceCount: answerPayload.citations.length,
        previousRunId: previousRun?.id ?? null,
        projectTag: promptRecord.projectTag || campaign.projectTag,
        intent: promptRecord.intent,
        tags: promptRecord.tags,
        deltas: buildRunDeltas(previousRun, mentionAnalysis),
        citations: answerPayload.citations,
        brandMentions: mentionAnalysis.brandMentions,
      })
      runs.push(runRecord)

      updateAnswerVisibilityJobStatus({
        jobId: job.id,
        status: 'running',
        startedAt,
        updatedAt: new Date().toISOString(),
        completedRuns: index + 1,
        campaignId: campaign.id,
      })
    }

    const summary = refreshCampaignSummary(campaign.id, brands.map((item) => item.id))
    const completedAt = new Date().toISOString()
    updateAnswerVisibilityJobStatus({
      jobId: job.id,
      status: 'completed',
      startedAt,
      completedAt,
      updatedAt: completedAt,
      completedRuns: runs.length,
      resultSummary: {
        campaignId: campaign.id,
        campaignName: campaign.name,
        runCount: runs.length,
        completedAt,
      },
      campaignId: campaign.id,
    })

    return { campaign, runs, summary }
  } catch (error) {
    const completedAt = new Date().toISOString()
    updateAnswerVisibilityJobStatus({
      jobId: job.id,
      status: 'failed',
      startedAt,
      completedAt,
      updatedAt: completedAt,
      errorMessage: error instanceof Error ? error.message : 'Unexpected visibility job failure.',
    })
    throw error
  }
}

function refreshCampaignSummary(campaignId, brandIds) {
  const store = getAnswerVisibilityStoreSnapshot()
  const metrics = computeSummaryMetrics(store, { campaignId })
  replaceSummarySnapshot({
    campaignId,
    brandIds,
    checkedAt: new Date().toISOString(),
    metrics,
  })
  return metrics
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
      include: ['web_search_call.action.sources'],
      store: false,
    }),
    signal: AbortSignal.timeout(45000),
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
      provider: 'openai',
      model: payload.model || OPENAI_MODEL,
      tool: 'web_search',
      include: ['web_search_call.action.sources'],
      promptVersion: PROMPT_VERSION,
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
    signal: AbortSignal.timeout(45000),
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
      provider: 'gemini',
      model: GEMINI_MODEL,
      tool: 'google_search',
      promptVersion: PROMPT_VERSION,
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
        sourceType: value.type || value.source_type || null,
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
      sourceType: 'grounding',
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
  const baseRuns = store.runs.filter((run) => {
    if (filters.jobId && run.jobId !== filters.jobId) return false
    if (filters.campaignId && run.campaignId !== filters.campaignId) return false
    if (filters.projectTag && normalizeText(run.projectTag) !== normalizeText(filters.projectTag)) return false
    if (filters.intent && normalizeText(run.intent) !== normalizeText(filters.intent)) return false
    if (filters.dateFrom && run.checkedAt < filters.dateFrom) return false
    if (filters.dateTo && run.checkedAt > `${filters.dateTo}T23:59:59.999`) return false

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

  if (filters.latestOnly === false || filters.jobId) {
    return baseRuns
  }

  const seenPromptIds = new Set()
  return baseRuns.filter((run) => {
    if (seenPromptIds.has(run.promptId)) return false
    seenPromptIds.add(run.promptId)
    return true
  })
}

function formatRunRecord(store, run) {
  const promptRecord = store.prompts.find((item) => item.id === run.promptId)
  const campaign = store.campaigns.find((item) => item.id === run.campaignId)
  const surfacedDomains = sanitizeSurfacedDomains(run.surfacedDomains)
  const citations = (run.citations || []).filter((citation) =>
    citation.domain && !EXCLUDED_SURFACED_DOMAINS.some((blocked) => citation.domain === blocked || citation.domain.endsWith(`.${blocked}`)),
  )

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
    surfacedDomains,
    citations,
    sourceCount: run.sourceCount,
    answerSnapshot: run.answerSnapshot,
    rawAnswerText: run.rawAnswerText,
    brandMentions: run.mentionSummary.brandMentions,
    deltas: run.deltas,
  }
}

async function pingOpenAiProvider() {
  const checkedAt = new Date().toISOString()
  if (!process.env.OPENAI_API_KEY) {
    return saveProviderHealthRecord({
      provider: 'openai',
      configured: false,
      reachable: false,
      checkedAt,
      latencyMs: null,
      message: 'OPENAI_API_KEY is not configured.',
      model: OPENAI_MODEL,
      details: { mode: 'visibility-tracker' },
    })
  }

  const started = Date.now()
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      signal: AbortSignal.timeout(12000),
    })

    const raw = await response.text()
    if (!response.ok) {
      throw new Error(extractApiError(raw))
    }

    return saveProviderHealthRecord({
      provider: 'openai',
      configured: true,
      reachable: true,
      checkedAt,
      latencyMs: Date.now() - started,
      message: 'OpenAI API is reachable and ready for answer visibility runs.',
      model: OPENAI_MODEL,
      details: { endpoint: 'GET /v1/models' },
    })
  } catch (error) {
    return saveProviderHealthRecord({
      provider: 'openai',
      configured: true,
      reachable: false,
      checkedAt,
      latencyMs: Date.now() - started,
      message: error instanceof Error ? error.message : 'OpenAI health check failed.',
      model: OPENAI_MODEL,
      details: { endpoint: 'GET /v1/models' },
    })
  }
}

async function pingGeminiProvider() {
  const checkedAt = new Date().toISOString()
  if (!process.env.GEMINI_API_KEY) {
    return saveProviderHealthRecord({
      provider: 'gemini',
      configured: false,
      reachable: false,
      checkedAt,
      latencyMs: null,
      message: 'GEMINI_API_KEY is not configured.',
      model: GEMINI_MODEL,
      details: { mode: 'visibility-tracker' },
    })
  }

  const started = Date.now()
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
      signal: AbortSignal.timeout(12000),
    })

    const raw = await response.text()
    if (!response.ok) {
      throw new Error(extractApiError(raw))
    }

    return saveProviderHealthRecord({
      provider: 'gemini',
      configured: true,
      reachable: true,
      checkedAt,
      latencyMs: Date.now() - started,
      message: 'Gemini API is reachable and ready for answer visibility runs.',
      model: GEMINI_MODEL,
      details: { endpoint: 'GET /v1beta/models' },
    })
  } catch (error) {
    return saveProviderHealthRecord({
      provider: 'gemini',
      configured: true,
      reachable: false,
      checkedAt,
      latencyMs: Date.now() - started,
      message: error instanceof Error ? error.message : 'Gemini health check failed.',
      model: GEMINI_MODEL,
      details: { endpoint: 'GET /v1beta/models' },
    })
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

function sanitizeSurfacedDomains(domains) {
  const cleaned = unique(
    domains.filter((domain) => domain && !EXCLUDED_SURFACED_DOMAINS.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`))),
  )

  return cleaned
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
    return parsed?.error?.message || parsed?.error?.status || rawBody || 'Unexpected API error.'
  } catch {
    return rawBody || 'Unexpected API error.'
  }
}
