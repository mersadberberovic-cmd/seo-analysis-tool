import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import './answer-visibility.css'

type CampaignRecord = {
  id: string
  name: string
  projectTag: string
  promptCount: number
  runCount: number
  brands: Array<{
    id: string
    name: string
    type: 'primary' | 'competitor'
    variations: string[]
  }>
}

type SummaryMetric = {
  runCount: number
  brandPresenceRate: number
  competitorPresenceRate: number
  averageMentionCountPerBrand: Array<{ brandId: string; name: string; average: number }>
  averageFirstPositionScore: number | null
  mentionShare: Array<{ brandId: string; name: string; total: number; share: number }>
  mostFrequentlyCitedDomains: Array<{ domain: string; count: number }>
  promptsWhereCompetitorsButNotPrimary: Array<{ runId: string; prompt: string }>
  promptsWherePrimaryAppearedFirst: Array<{ runId: string; prompt: string }>
  primaryBrand: string | null
  competitors: string[]
}

type VisibilityRecord = {
  id: string
  promptId: string
  prompt: string
  checkedAt: string
  campaignId: string
  campaignName: string
  projectTag: string
  intent: string
  provider: string
  model: string
  primaryBrandMentioned: boolean
  primaryBrandMentionCount: number
  competitorMentionCounts: Array<{ brandId: string; name: string; count: number; firstPosition: number | null }>
  firstMentionedBrand: string | null
  primaryBrandFirstPosition: number | null
  surfacedDomains: string[]
  citations: Array<{ id?: string; url: string; domain: string; title: string; sourceType?: string | null }>
  sourceCount: number
  answerSnapshot: string
  rawAnswerText: string
  brandMentions: Array<{ brandId: string; name: string; type: 'primary' | 'competitor'; answerCount: number; citationCount: number; totalCount: number; firstPosition: number | null; appearsIn: string }>
  deltas: {
    primaryPresenceDelta: number | null
    primaryMentionCountDelta: number | null
    primaryFirstPositionDelta: number | null
  }
}

type VisibilityResponse = {
  records: VisibilityRecord[]
  summary: SummaryMetric
  campaigns: CampaignRecord[]
}

type VisibilityJob = {
  id: string
  campaignId: string | null
  type: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  providerPreference: string
  promptCount: number
  completedRuns: number
  resultSummary: Record<string, unknown> | null
  errorMessage: string | null
  requestedAt: string
  startedAt: string | null
  completedAt: string | null
  updatedAt: string
}

type ProviderHealthRecord = {
  provider: string
  configured: boolean
  reachable: boolean
  checkedAt: string
  latencyMs: number | null
  message: string
  model: string | null
}

type ProviderHealthResponse = {
  checkedAt: string
  providers: ProviderHealthRecord[]
}

type FilterState = {
  jobId: string
  campaignId: string
  projectTag: string
  intent: string
  mentionStatus: string
  brandId: string
  competitorId: string
  dateFrom: string
  dateTo: string
  latestOnly: boolean
}

const INTENT_OPTIONS = ['informational', 'commercial', 'comparison', 'local', 'branded', 'non-branded']

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const raw = await response.text()
  const contentType = response.headers.get('content-type') ?? ''

  let data: Record<string, unknown> | null = null
  if (raw.trim()) {
    try {
      data = JSON.parse(raw) as Record<string, unknown>
    } catch {
      data = null
    }
  }

  if (!response.ok) {
    throw new Error(
      (typeof data?.error === 'string' && data.error)
      || buildNonJsonApiMessage({ raw, contentType, status: response.status })
      || 'Request failed.',
    )
  }

  if (!data) {
    throw new Error(buildNonJsonApiMessage({ raw, contentType, status: response.status }))
  }

  return data as T
}

function buildNonJsonApiMessage({
  raw,
  contentType,
  status,
}: {
  raw: string
  contentType: string
  status: number
}) {
  const preview = raw.replace(/\s+/g, ' ').trim().slice(0, 140)
  if (contentType.includes('text/html') || /^\s*</.test(raw)) {
    return `The AI Answer Visibility API returned HTML instead of JSON (status ${status}). This usually means the backend route is unavailable or the dev server needs restarting.`
  }

  if (!raw.trim()) {
    return `The AI Answer Visibility API returned an empty response (status ${status}).`
  }

  return `The AI Answer Visibility API returned an unexpected response (status ${status}): ${preview}`
}

function parseBrandRows(value: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, variationBlock = ''] = line.split('|')
      return {
        name: name.trim(),
        variations: variationBlock.split(',').map((item) => item.trim()).filter(Boolean),
      }
    })
    .filter((item) => item.name)
}

function parsePromptRows(value: string, intent: string, projectTag: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((prompt) => ({
      prompt,
      intent,
      projectTag,
      tags: [intent, projectTag].filter(Boolean),
    }))
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`
}

function formatDate(value: string) {
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function downloadTextFile(fileName: string, contents: string) {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function normalizeWords(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2)
}

function getSourceRelevanceScore(prompt: string, title: string, domain: string) {
  const promptWords = normalizeWords(prompt)
  const sourceWords = new Set([...normalizeWords(title), ...normalizeWords(domain)])
  const overlap = promptWords.filter((word) => sourceWords.has(word)).length
  return overlap
}

function getPromptVisibilityScore(record: VisibilityRecord, primaryBrandName: string | null) {
  const primaryMention = record.brandMentions.find((item) => item.type === 'primary') ?? null
  const competitorTotal = record.competitorMentionCounts.reduce((sum, item) => sum + item.count, 0)
  const competitorLead = Boolean(record.firstMentionedBrand && record.firstMentionedBrand !== primaryBrandName)
  const primaryAnswerCount = primaryMention?.answerCount ?? 0
  const primaryCitationCount = primaryMention?.citationCount ?? 0
  const primaryBothBonus = primaryMention?.appearsIn === 'both' ? 8 : 0
  const relevantSourceScore = Math.min(
    18,
    record.citations
      .slice(0, 5)
      .reduce((sum, citation) => sum + Math.min(4, getSourceRelevanceScore(record.prompt, citation.title, citation.domain)), 0),
  )

  let score = 0

  if (primaryAnswerCount > 0) {
    score += 36
  } else if (primaryCitationCount > 0) {
    score += 12
  }

  score += Math.min(primaryAnswerCount, 3) * 10
  score += Math.min(primaryCitationCount, 2) * 4
  score += primaryBothBonus

  if (record.firstMentionedBrand === primaryBrandName) {
    score += 16
  }

  if (record.primaryBrandFirstPosition !== null) {
    score += Math.max(0, 16 - Math.min(record.primaryBrandFirstPosition - 1, 16))
  }

  score += relevantSourceScore

  if (!record.primaryBrandMentioned && competitorTotal > 0) {
    score -= 22
  } else {
    score -= Math.min(18, competitorTotal * 4)
  }

  if (competitorLead) {
    score -= 12
  }

  return Math.max(0, Math.min(100, Math.round(score)))
}

function getVisibilityGrade(score: number) {
  if (score >= 85) return 'A'
  if (score >= 72) return 'B'
  if (score >= 58) return 'C'
  if (score >= 42) return 'D'
  return 'E'
}

function formatProviderLabel(provider: string) {
  return provider === 'openai' ? 'GPT / OpenAI' : provider === 'gemini' ? 'Gemini' : provider
}

function getProviderStatusLabel(provider: ProviderHealthRecord, hasPrimaryProvider: boolean) {
  if (provider.reachable) {
    return provider.provider === 'openai' ? 'Connected' : 'Ready'
  }

  if (!provider.configured) {
    return hasPrimaryProvider && provider.provider !== 'openai' ? 'Optional' : 'Not configured'
  }

  return 'Unavailable'
}

function getProviderHelperCopy(provider: ProviderHealthRecord, hasPrimaryProvider: boolean) {
  if (provider.reachable) {
    return provider.message
  }

  if (!provider.configured && hasPrimaryProvider && provider.provider !== 'openai') {
    return `${formatProviderLabel(provider.provider)} is optional right now because the tracker already has a working primary provider.`
  }

  return provider.message
}

function getPromptOutcomeLabel(record: VisibilityRecord, primaryBrandName: string | null) {
  const competitorTotal = record.competitorMentionCounts.reduce((sum, item) => sum + item.count, 0)

  if (record.firstMentionedBrand === primaryBrandName && record.primaryBrandMentioned) {
    return 'Win'
  }

  if (!record.primaryBrandMentioned && competitorTotal > 0) {
    return 'Competitor lead'
  }

  if (record.primaryBrandMentioned && competitorTotal === 0) {
    return 'Strong presence'
  }

  if (record.primaryBrandMentioned && competitorTotal > 0) {
    return 'Contested'
  }

  return 'Gap'
}

export function AnswerVisibilityTracker() {
  const [campaignName, setCampaignName] = useState('AI Answer Visibility')
  const [projectTag, setProjectTag] = useState('Core prompts')
  const [intent, setIntent] = useState('informational')
  const [primaryBrandName, setPrimaryBrandName] = useState('')
  const [primaryBrandVariations, setPrimaryBrandVariations] = useState('')
  const [competitorRows, setCompetitorRows] = useState('')
  const [promptInput, setPromptInput] = useState('')
  const [providerPreference, setProviderPreference] = useState('auto')
  const [isRunning, setIsRunning] = useState(false)
  const [isRerunning, setIsRerunning] = useState(false)
  const [error, setError] = useState('')
  const [campaigns, setCampaigns] = useState<CampaignRecord[]>([])
  const [records, setRecords] = useState<VisibilityRecord[]>([])
  const [summary, setSummary] = useState<SummaryMetric | null>(null)
  const [providerHealth, setProviderHealth] = useState<ProviderHealthRecord[]>([])
  const [job, setJob] = useState<VisibilityJob | null>(null)
  const [filters, setFilters] = useState<FilterState>({
    jobId: '',
    campaignId: '',
    projectTag: '',
    intent: '',
    mentionStatus: '',
    brandId: '',
    competitorId: '',
    dateFrom: '',
    dateTo: '',
    latestOnly: true,
  })

  const currentCampaign = useMemo(
    () => campaigns.find((campaign) => campaign.id === filters.campaignId) ?? null,
    [campaigns, filters.campaignId],
  )

  const activeProviders = useMemo(
    () => providerHealth.filter((provider) => provider.configured && provider.reachable),
    [providerHealth],
  )

  const primaryProvider = useMemo(
    () => providerHealth.find((provider) => provider.provider === 'openai' && provider.configured && provider.reachable)
      ?? providerHealth.find((provider) => provider.configured && provider.reachable)
      ?? null,
    [providerHealth],
  )

  const rankedBrands = useMemo(() => {
    if (!summary) return []

    return summary.averageMentionCountPerBrand
      .map((brand) => {
        const mentionShare = summary.mentionShare.find((item) => item.brandId === brand.brandId)
        const firstPlaceWins = records.filter((record) => record.firstMentionedBrand === brand.name).length
        const totalMentions = records.reduce((sum, record) => {
          const mention = record.brandMentions.find((item) => item.brandId === brand.brandId)
          return sum + (mention?.totalCount ?? 0)
        }, 0)

        const visibilityScore = (brand.average * 0.45) + ((mentionShare?.share ?? 0) * 100 * 0.35) + (firstPlaceWins * 0.2)

        return {
          brandId: brand.brandId,
          name: brand.name,
          averageMentions: brand.average,
          mentionShare: mentionShare?.share ?? 0,
          firstPlaceWins,
          totalMentions,
          visibilityScore,
        }
      })
      .sort((left, right) => right.visibilityScore - left.visibilityScore)
  }, [summary, records])

  const compactPromptResults = useMemo(() => {
    return records.map((record) => {
      const competitorMentionTotal = record.competitorMentionCounts.reduce((sum, item) => sum + item.count, 0)
      const visibilityScore = getPromptVisibilityScore(record, summary?.primaryBrand ?? null)
      const bestSources = [...record.citations]
        .sort((left, right) => getSourceRelevanceScore(record.prompt, right.title, right.domain) - getSourceRelevanceScore(record.prompt, left.title, left.domain))
        .slice(0, 3)
      const deltaScore =
        (record.deltas.primaryPresenceDelta ?? 0) * 18
        + (record.deltas.primaryMentionCountDelta ?? 0) * 6
        - ((record.deltas.primaryFirstPositionDelta ?? 0) > 0 ? Math.min(10, record.deltas.primaryFirstPositionDelta ?? 0) : 0)
      return {
        ...record,
        competitorMentionTotal,
        topDomains: record.surfacedDomains.slice(0, 4),
        visibilityScore,
        visibilityGrade: getVisibilityGrade(visibilityScore),
        bestSources,
        outcomeLabel: getPromptOutcomeLabel(record, summary?.primaryBrand ?? null),
        deltaScore,
      }
    })
  }, [records, summary?.primaryBrand])

  const overallVisibilityScore = useMemo(() => {
    if (compactPromptResults.length === 0) return 0
    return Math.round(
      compactPromptResults.reduce((sum, record) => sum + record.visibilityScore, 0) / compactPromptResults.length,
    )
  }, [compactPromptResults])

  const overallVisibilityGrade = useMemo(
    () => getVisibilityGrade(overallVisibilityScore),
    [overallVisibilityScore],
  )

  const competitorGapPrompts = useMemo(
    () => compactPromptResults.filter((record) => !record.primaryBrandMentioned && record.competitorMentionTotal > 0).length,
    [compactPromptResults],
  )

  const competitorComparisonRows = useMemo(() => {
    if (!summary) return []
    return summary.mentionShare
      .map((item) => ({
        ...item,
        averageMentions: summary.averageMentionCountPerBrand.find((brand) => brand.brandId === item.brandId)?.average ?? 0,
      }))
      .sort((left, right) => right.share - left.share)
  }, [summary])

  const visibilityTrendSummary = useMemo(() => {
    const improving = compactPromptResults.filter((record) => record.deltaScore > 0).length
    const declining = compactPromptResults.filter((record) => record.deltaScore < 0).length
    const stable = compactPromptResults.length - improving - declining
    return { improving, declining, stable }
  }, [compactPromptResults])

  const outcomeBreakdown = useMemo(() => {
    const counts = new Map<string, number>()
    compactPromptResults.forEach((record) => {
      counts.set(record.outcomeLabel, (counts.get(record.outcomeLabel) ?? 0) + 1)
    })
    return ['Win', 'Strong presence', 'Contested', 'Competitor lead', 'Gap'].map((label) => ({
      label,
      count: counts.get(label) ?? 0,
    }))
  }, [compactPromptResults])

  const promptTrendSeries = useMemo(() => {
    const series = new Map<string, Array<{ checkedAt: string; score: number }>>()

    records.forEach((record) => {
      const score = getPromptVisibilityScore(record, summary?.primaryBrand ?? null)
      const existing = series.get(record.prompt) ?? []
      existing.push({ checkedAt: record.checkedAt, score })
      series.set(record.prompt, existing)
    })

    return [...series.entries()]
      .map(([prompt, points]) => ({
        prompt,
        points: points.sort((left, right) => left.checkedAt.localeCompare(right.checkedAt)).slice(-4),
      }))
      .slice(0, 4)
  }, [records, summary?.primaryBrand])

  const loadRecords = async (nextFilters: FilterState = filters) => {
    const search = new URLSearchParams()
    if (nextFilters.jobId) search.set('jobId', nextFilters.jobId)
    if (nextFilters.campaignId) search.set('campaignId', nextFilters.campaignId)
    if (nextFilters.projectTag) search.set('projectTag', nextFilters.projectTag)
    if (nextFilters.intent) search.set('intent', nextFilters.intent)
    if (nextFilters.mentionStatus) search.set('mentionStatus', nextFilters.mentionStatus)
    if (nextFilters.brandId) search.set('brandId', nextFilters.brandId)
    if (nextFilters.competitorId) search.set('competitorId', nextFilters.competitorId)
    if (nextFilters.dateFrom) search.set('dateFrom', nextFilters.dateFrom)
    if (nextFilters.dateTo) search.set('dateTo', nextFilters.dateTo)
    search.set('latestOnly', nextFilters.latestOnly ? 'true' : 'false')

    const data = await readJson<VisibilityResponse>(`/api/answer-visibility/records?${search.toString()}`)
    setCampaigns(data.campaigns)
    setRecords(data.records)
    setSummary(data.summary)
  }

  useEffect(() => {
    void loadRecords()
  }, [])

  useEffect(() => {
    void loadProviderHealth()
  }, [])

  useEffect(() => {
    if (!job || job.status === 'completed' || job.status === 'failed') return

    const timer = window.setInterval(() => {
      void pollJob(job.id)
    }, 2000)

    return () => window.clearInterval(timer)
  }, [job])

  const loadProviderHealth = async () => {
    const data = await readJson<ProviderHealthResponse>('/api/providers/health')
    setProviderHealth(data.providers)
  }

  const pollJob = async (jobId: string) => {
    const data = await readJson<{ job: VisibilityJob }>(`/api/answer-visibility/jobs/${jobId}`)
    setJob(data.job)

    if (data.job.status === 'completed') {
      const nextFilters = {
        ...filters,
        jobId: data.job.id,
        campaignId: data.job.campaignId ?? filters.campaignId,
        latestOnly: true,
      }
      setFilters(nextFilters)
      await loadRecords(nextFilters)
    }

    if (data.job.status === 'failed' && data.job.errorMessage) {
      setError(data.job.errorMessage)
    }
  }

  const handlePromptUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const text = await file.text()
    setPromptInput(text)
  }

  const handleRun = async () => {
    setIsRunning(true)
    setError('')
    try {
      const prompts = parsePromptRows(promptInput, intent, projectTag)
      if (!primaryBrandName.trim()) {
        throw new Error('Add a primary brand before running the visibility tracker.')
      }
      if (prompts.length === 0) {
        throw new Error('Add at least one prompt before running the visibility tracker.')
      }

      const result = await readJson<{ job: VisibilityJob }>('/api/answer-visibility/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaignName,
          projectTag,
          providerPreference,
          primaryBrand: {
            name: primaryBrandName,
            variations: primaryBrandVariations.split(',').map((item) => item.trim()).filter(Boolean),
          },
          competitorBrands: parseBrandRows(competitorRows),
          prompts,
        }),
      })
      setJob(result.job)
      const nextFilters = {
        ...filters,
        jobId: result.job.id,
        campaignId: result.job.campaignId ?? filters.campaignId,
        latestOnly: true,
      }
      setFilters(nextFilters)
      await pollJob(result.job.id)
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Visibility run failed.')
    } finally {
      setIsRunning(false)
    }
  }

  const handleRerun = async () => {
    const promptIds = [...new Set(records.map((record) => record.promptId))]
    if (promptIds.length === 0) return
    setIsRerunning(true)
    setError('')
    try {
      const result = await readJson<{ job: VisibilityJob }>('/api/answer-visibility/rerun', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          promptIds,
          providerPreference,
        }),
      })
      setJob(result.job)
      const nextFilters = {
        ...filters,
        jobId: result.job.id,
        campaignId: result.job.campaignId ?? filters.campaignId,
        latestOnly: true,
      }
      setFilters(nextFilters)
      await pollJob(result.job.id)
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Visibility rerun failed.')
    } finally {
      setIsRerunning(false)
    }
  }

  const handleExport = () => {
    const search = new URLSearchParams()
    if (filters.jobId) search.set('jobId', filters.jobId)
    if (filters.campaignId) search.set('campaignId', filters.campaignId)
    if (filters.projectTag) search.set('projectTag', filters.projectTag)
    if (filters.intent) search.set('intent', filters.intent)
    if (filters.mentionStatus) search.set('mentionStatus', filters.mentionStatus)
    if (filters.brandId) search.set('brandId', filters.brandId)
    if (filters.competitorId) search.set('competitorId', filters.competitorId)
    if (filters.dateFrom) search.set('dateFrom', filters.dateFrom)
    if (filters.dateTo) search.set('dateTo', filters.dateTo)
    search.set('latestOnly', filters.latestOnly ? 'true' : 'false')
    window.open(`/api/answer-visibility/export.csv?${search.toString()}`, '_blank')
  }

  const handleSummaryExport = () => {
    if (!summary) return
    const rows = [
      ['campaign', currentCampaign?.name ?? 'All campaigns'],
      ['brand_presence_rate', formatPercent(summary.brandPresenceRate)],
      ['competitor_presence_rate', formatPercent(summary.competitorPresenceRate)],
      ['average_first_position_score', summary.averageFirstPositionScore?.toFixed(2) ?? ''],
      ['most_frequently_cited_domains', summary.mostFrequentlyCitedDomains.map((item) => `${item.domain}:${item.count}`).join('; ')],
    ]
    downloadTextFile(
      'ai-answer-visibility-summary.csv',
      rows.map((row) => row.map((item) => `"${String(item).replace(/"/g, '""')}"`).join(',')).join('\n'),
    )
  }

  return (
    <section id="answer-visibility-root" className="answer-visibility-shell">
      <section className="panel answer-visibility-entry">
        <div className="answer-visibility-entry-copy">
          <p className="panel-kicker">AI Answer Visibility</p>
          <h2>Track answer presence, citation presence, and mention share across your prompts</h2>
          <p className="panel-copy">
            This feature runs prompts through the configured AI answer pipeline, stores the answer, extracts surfaced domains, and shows how your brand and competitors appear over time.
          </p>
        </div>

        <div className="answer-platform-strip">
          <div className="answer-platform-provider">
            <span className={`provider-logo-badge ${primaryProvider?.provider === 'openai' ? 'provider-logo-gpt' : primaryProvider?.provider === 'gemini' ? 'provider-logo-gemini' : ''}`}>
              {primaryProvider?.provider === 'openai' ? 'GPT' : primaryProvider?.provider === 'gemini' ? 'G' : 'AI'}
            </span>
            <div>
              <strong>{primaryProvider ? `${formatProviderLabel(primaryProvider.provider)} built in` : 'No live answer provider connected'}</strong>
              <p>{primaryProvider ? 'Visibility checks run through the backend using stored configuration and historical job tracking.' : 'Connect OpenAI or Gemini in the backend to run prompt visibility checks.'}</p>
            </div>
          </div>
          <div className="answer-platform-meta">
            <span className="answer-platform-chip">AI visibility tracking</span>
            <span className="answer-platform-chip">Historical answer presence</span>
            <span className="answer-platform-chip">Citation domain capture</span>
          </div>
        </div>

        <div className="metric-grid metric-grid-compact answer-health-grid">
          <article className="metric-card metric-card-compact">
            <span>Provider health</span>
            <strong>{activeProviders.length}/{providerHealth.length || 2}</strong>
            <small>Configured and reachable answer providers</small>
          </article>
          <article className="metric-card metric-card-compact">
            <span>Current job</span>
            <strong>{job ? job.status : 'idle'}</strong>
            <small>{job ? `${job.completedRuns}/${job.promptCount} prompts processed` : 'No active visibility run'}</small>
          </article>
          <article className="metric-card metric-card-compact">
            <span>Pipeline mode</span>
            <strong>Queued</strong>
            <small>Prompts run in the backend and remain stored historically</small>
          </article>
        </div>

        <div className="findings-list compact-findings answer-provider-health">
          {providerHealth.map((provider) => (
            <article
              key={provider.provider}
              className={`finding-card ${
                provider.reachable
                  ? 'severity-low'
                  : (!provider.configured && activeProviders.length > 0 && provider.provider !== 'openai')
                    ? 'severity-low'
                    : 'severity-high'
              }`}
            >
              <div className="finding-topline">
                <span>{formatProviderLabel(provider.provider)}</span>
                <h4>{getProviderStatusLabel(provider, activeProviders.length > 0)}</h4>
              </div>
              <p>{getProviderHelperCopy(provider, activeProviders.length > 0)}</p>
              <small>{provider.model ? `${provider.model}${provider.latencyMs ? ` • ${provider.latencyMs}ms` : ''}` : 'No model configured'}</small>
            </article>
          ))}
        </div>

        <div className="answer-visibility-entry-grid">
          <label className="setting-card">
            <span>Campaign / project</span>
            <input type="text" value={campaignName} onChange={(event) => setCampaignName(event.target.value)} />
          </label>
          <label className="setting-card">
            <span>Project tag</span>
            <input type="text" value={projectTag} onChange={(event) => setProjectTag(event.target.value)} />
          </label>
          <label className="setting-card">
            <span>Intent</span>
            <select value={intent} onChange={(event) => setIntent(event.target.value)}>
              {INTENT_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <label className="setting-card">
            <span>Provider workflow</span>
            <select value={providerPreference} onChange={(event) => setProviderPreference(event.target.value)}>
              <option value="auto">Auto</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
            </select>
          </label>
        </div>

        <div className="answer-visibility-entry-grid">
          <label className="setting-card">
            <span>Primary brand</span>
            <input type="text" placeholder="Your main brand" value={primaryBrandName} onChange={(event) => setPrimaryBrandName(event.target.value)} />
          </label>
          <label className="setting-card">
            <span>Primary brand variations</span>
            <input
              type="text"
              placeholder="Brand, Brand.com, Brand Name"
              value={primaryBrandVariations}
              onChange={(event) => setPrimaryBrandVariations(event.target.value)}
            />
          </label>
        </div>

        <div className="answer-visibility-entry-grid single-column">
          <label className="setting-card">
            <span>Competitors</span>
            <textarea
              placeholder={'Competitor One|comp one, competitor1\nCompetitor Two|comp two'}
              value={competitorRows}
              onChange={(event) => setCompetitorRows(event.target.value)}
            />
            <small>One competitor per line. Use `name|variation 1, variation 2` when you need extra brand variants.</small>
          </label>
        </div>

        <div className="answer-visibility-entry-grid single-column">
          <label className="setting-card">
            <span>Prompts</span>
            <textarea
              placeholder={'what is the best criminal defense law firm in auckland?\nwho installs mitsubishi heat pumps in auckland?'}
              value={promptInput}
              onChange={(event) => setPromptInput(event.target.value)}
            />
          </label>
        </div>

        <div className="answer-visibility-actions">
          <label className="secondary-button answer-upload-button">
            Upload prompt list
            <input type="file" accept=".txt,.csv" onChange={handlePromptUpload} hidden />
          </label>
          <button type="button" onClick={() => void handleRun()}>{isRunning ? 'Running prompts...' : 'Run visibility check'}</button>
          <button type="button" className="secondary-button" onClick={() => void handleRerun()} disabled={records.length === 0}>
            {isRerunning ? 'Rechecking...' : 'Recheck visible prompts'}
          </button>
          <button type="button" className="secondary-button" onClick={handleExport} disabled={records.length === 0}>
            Export CSV
          </button>
          <button type="button" className="secondary-button" onClick={handleSummaryExport} disabled={!summary}>
            Export summary
          </button>
        </div>
        {job ? (
          <div className={`job-status-banner job-status-${job.status}`}>
            <strong>Visibility job {job.status}</strong>
            <span>{job.completedRuns}/{job.promptCount} prompts processed</span>
          </div>
        ) : null}
        {error ? <p className="error-text">{error}</p> : null}
      </section>

      <section className="answer-visibility-results-grid">
        <div className="answer-visibility-main">
          <section id="answer-visibility-summary" className="panel answer-summary-panel">
            <div className="subsection-heading">
              <div>
                <p className="panel-kicker">Summary</p>
                <h3>Visibility snapshot</h3>
              </div>
            </div>

            {summary ? (
              <>
                <div className="metric-grid metric-grid-compact">
                  <article className="metric-card metric-card-compact">
                    <span>AI visibility grade</span>
                    <strong>{overallVisibilityGrade}</strong>
                    <small>{overallVisibilityScore}/100 across the current prompt set</small>
                  </article>
                  <article className="metric-card metric-card-compact">
                    <span>Brand presence rate</span>
                    <strong>{formatPercent(summary.brandPresenceRate)}</strong>
                    <small>Prompts where the primary brand appeared</small>
                  </article>
                  <article className="metric-card metric-card-compact">
                    <span>Competitor presence rate</span>
                    <strong>{formatPercent(summary.competitorPresenceRate)}</strong>
                    <small>Prompts where a competitor appeared</small>
                  </article>
                  <article className="metric-card metric-card-compact">
                    <span>Average first position</span>
                    <strong>{summary.averageFirstPositionScore ? summary.averageFirstPositionScore.toFixed(1) : '-'}</strong>
                    <small>Word position for the primary brand</small>
                  </article>
                  <article className="metric-card metric-card-compact">
                    <span>Competitor gap prompts</span>
                    <strong>{competitorGapPrompts}</strong>
                    <small>Prompts where competitors appeared without the primary brand</small>
                  </article>
                </div>

                <div className="dashboard-module-grid">
                  <article className="panel preview-panel dashboard-module-panel">
                    <div className="subsection-heading">
                      <div>
                        <p className="panel-kicker">Momentum</p>
                        <h3>Visibility trend snapshot</h3>
                      </div>
                    </div>
                    <div className="score-chart">
                      <div className="score-bar-row">
                        <div className="score-bar-meta">
                          <strong>Improving prompts</strong>
                          <span>{visibilityTrendSummary.improving}</span>
                        </div>
                        <div className="score-bar-track">
                          <div className="score-bar-fill" style={{ width: `${compactPromptResults.length > 0 ? (visibilityTrendSummary.improving / compactPromptResults.length) * 100 : 0}%` }} />
                        </div>
                      </div>
                      <div className="score-bar-row">
                        <div className="score-bar-meta">
                          <strong>Stable prompts</strong>
                          <span>{visibilityTrendSummary.stable}</span>
                        </div>
                        <div className="score-bar-track">
                          <div className="score-bar-fill score-bar-fill-muted" style={{ width: `${compactPromptResults.length > 0 ? (visibilityTrendSummary.stable / compactPromptResults.length) * 100 : 0}%` }} />
                        </div>
                      </div>
                      <div className="score-bar-row">
                        <div className="score-bar-meta">
                          <strong>Declining prompts</strong>
                          <span>{visibilityTrendSummary.declining}</span>
                        </div>
                        <div className="score-bar-track">
                          <div className="score-bar-fill score-bar-fill-warn" style={{ width: `${compactPromptResults.length > 0 ? (visibilityTrendSummary.declining / compactPromptResults.length) * 100 : 0}%` }} />
                        </div>
                      </div>
                    </div>
                  </article>

                  <article className="panel preview-panel dashboard-module-panel">
                    <div className="subsection-heading">
                      <div>
                        <p className="panel-kicker">Ranking view</p>
                        <h3>Brand visibility ranking</h3>
                      </div>
                    </div>
                    <div className="brand-visibility-board">
                      {rankedBrands.length > 0 ? rankedBrands.map((brand, index) => (
                        <article key={brand.brandId} className={`brand-rank-card ${index === 0 ? 'brand-rank-card-lead' : ''}`}>
                          <div className="brand-rank-head">
                            <span className="brand-rank-position">#{index + 1}</span>
                            <div>
                              <h4>{brand.name}</h4>
                              <p>Visibility score {brand.visibilityScore.toFixed(1)}</p>
                            </div>
                          </div>
                          <div className="brand-rank-stats">
                            <span>{formatPercent(brand.mentionShare)} mention share</span>
                            <span>{brand.averageMentions.toFixed(1)} avg mentions</span>
                            <span>{brand.firstPlaceWins} first mentions</span>
                          </div>
                          <div className="score-bar-track">
                            <div className="score-bar-fill" style={{ width: `${Math.min(100, Math.max(8, brand.visibilityScore))}%` }} />
                          </div>
                        </article>
                      )) : (
                        <div className="empty-state"><p>Run prompts to build a ranked brand visibility view.</p></div>
                      )}
                    </div>
                  </article>

                  <article className="panel preview-panel dashboard-module-panel">
                    <div className="subsection-heading">
                      <div>
                        <p className="panel-kicker">Comparison</p>
                        <h3>Primary brand vs competitors</h3>
                      </div>
                    </div>
                    <div className="score-chart">
                      {competitorComparisonRows.map((item) => (
                        <div key={item.brandId} className="score-bar-row">
                          <div className="score-bar-meta">
                            <strong>{item.name}</strong>
                            <span>{formatPercent(item.share)} • {item.averageMentions.toFixed(1)} avg mentions</span>
                          </div>
                          <div className="score-bar-track">
                            <div className="score-bar-fill" style={{ width: `${Math.max(4, item.share * 100)}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </article>

                  <article className="panel preview-panel dashboard-module-panel">
                    <div className="subsection-heading">
                      <div>
                        <p className="panel-kicker">Sources</p>
                        <h3>Most frequently cited domains</h3>
                      </div>
                    </div>
                    <div className="findings-list compact-findings">
                      {summary.mostFrequentlyCitedDomains.slice(0, 6).map((item) => (
                        <article key={item.domain} className="finding-card severity-low">
                          <div className="finding-topline">
                            <span>domain</span>
                            <h4>{item.domain}</h4>
                          </div>
                          <p>Appeared in {item.count} answer{item.count === 1 ? '' : 's'}.</p>
                        </article>
                      ))}
                    </div>
                  </article>

                  <article className="panel preview-panel dashboard-module-panel">
                    <div className="subsection-heading">
                      <div>
                        <p className="panel-kicker">Outcomes</p>
                        <h3>Prompt visibility outcomes</h3>
                      </div>
                    </div>
                    <div className="score-chart">
                      {outcomeBreakdown.map((item) => (
                        <div key={item.label} className="score-bar-row">
                          <div className="score-bar-meta">
                            <strong>{item.label}</strong>
                            <span>{item.count}</span>
                          </div>
                          <div className="score-bar-track">
                            <div className="score-bar-fill" style={{ width: `${compactPromptResults.length > 0 ? (item.count / compactPromptResults.length) * 100 : 0}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </article>

                  <article className="panel preview-panel dashboard-module-panel">
                    <div className="subsection-heading">
                      <div>
                        <p className="panel-kicker">History</p>
                        <h3>Recent prompt score trends</h3>
                      </div>
                    </div>
                    <div className="trend-list">
                      {promptTrendSeries.length > 0 ? promptTrendSeries.map((item) => (
                        <article key={item.prompt} className="trend-card">
                          <strong>{item.prompt}</strong>
                          <div className="trend-points">
                            {item.points.map((point) => (
                              <div key={`${item.prompt}-${point.checkedAt}`} className="trend-point">
                                <div className="trend-point-bar" style={{ height: `${Math.max(10, point.score)}%` }} />
                                <span>{point.score}</span>
                              </div>
                            ))}
                          </div>
                        </article>
                      )) : (
                        <div className="empty-state"><p>Run more than one visibility check to see prompt trends.</p></div>
                      )}
                    </div>
                  </article>
                </div>
              </>
            ) : (
              <div className="empty-state"><p>Run your first prompt set to populate visibility metrics.</p></div>
            )}
          </section>

          <section id="answer-visibility-table" className="panel answer-records-panel">
            <div className="subsection-heading">
              <div>
                <p className="panel-kicker">Results</p>
                <h3>Prompt visibility results</h3>
              </div>
            </div>
            <div className="prompt-results-list">
              {compactPromptResults.map((record) => (
                <article key={record.id} className="prompt-result-card">
                  <div className="prompt-result-head">
                    <div>
                      <p className="prompt-result-label">Prompt</p>
                      <h4>{record.prompt}</h4>
                    </div>
                    <div className="prompt-result-meta">
                      <span className={`prompt-grade-badge prompt-grade-${record.visibilityGrade.toLowerCase()}`}>{record.visibilityGrade} • {record.visibilityScore}/100</span>
                      <span className={`prompt-outcome-badge prompt-outcome-${record.outcomeLabel.toLowerCase().replace(/\s+/g, '-')}`}>{record.outcomeLabel}</span>
                      <span>{formatDate(record.checkedAt)}</span>
                      <span>{record.projectTag || record.campaignName}</span>
                    </div>
                  </div>

                  <div className="prompt-result-stats">
                    <div className="prompt-stat-block">
                      <span>Primary brand</span>
                      <strong>{record.primaryBrandMentioned ? 'Mentioned' : 'Not mentioned'}</strong>
                      <small>{record.primaryBrandMentionCount} mentions</small>
                    </div>
                    <div className="prompt-stat-block">
                      <span>Competitors</span>
                      <strong>{record.competitorMentionTotal > 0 ? 'Appeared' : 'Not mentioned'}</strong>
                      <small>{record.competitorMentionTotal} competitor mentions</small>
                    </div>
                    <div className="prompt-stat-block">
                      <span>First brand seen</span>
                      <strong>{record.firstMentionedBrand ?? 'None'}</strong>
                      <small>{record.primaryBrandFirstPosition ? `Primary at word ${record.primaryBrandFirstPosition}` : 'Primary brand not positioned'}</small>
                    </div>
                    <div className="prompt-stat-block">
                      <span>Sources</span>
                      <strong>{record.sourceCount}</strong>
                      <small>{record.topDomains.length > 0 ? record.topDomains.join(', ') : 'No topical domains detected'}</small>
                    </div>
                  </div>

                  <div className="prompt-result-subrow">
                    <div className="prompt-domain-row">
                      {record.topDomains.length > 0 ? record.topDomains.map((domain) => (
                        <span key={domain} className="prompt-domain-chip">{domain}</span>
                      )) : <span className="prompt-domain-chip prompt-domain-chip-muted">No surfaced domains</span>}
                    </div>
                    <span className={`visibility-rank-badge ${record.firstMentionedBrand === summary?.primaryBrand ? 'visibility-rank-good' : 'visibility-rank-neutral'}`}>
                      {record.firstMentionedBrand
                        ? (record.firstMentionedBrand === summary?.primaryBrand ? 'Primary first' : `${record.firstMentionedBrand} first`)
                        : 'No clear first mention'}
                    </span>
                  </div>

                  {record.bestSources.length > 0 ? (
                    <div className="prompt-source-cards">
                      {record.bestSources.map((source) => (
                        <article key={`${record.id}-${source.url}`} className="prompt-source-card">
                          <span>{source.domain}</span>
                          <strong>{source.title || source.url}</strong>
                        </article>
                      ))}
                    </div>
                  ) : null}

                  <details className="prompt-answer-details">
                    <summary>Open answer snapshot</summary>
                    <p className="answer-record-expanded">{record.rawAnswerText}</p>
                  </details>
                </article>
              ))}
            </div>
          </section>
        </div>

        <aside className="dashboard-rail">
          <section id="answer-visibility-filters" className="panel rail-panel">
            <div className="subsection-heading">
              <div>
                <p className="panel-kicker">Filters</p>
                <h3>Visibility filters</h3>
              </div>
            </div>
            <div className="settings-grid">
              <label className="setting-card">
                <span>Campaign</span>
                <select
                  value={filters.campaignId}
                  onChange={async (event) => {
                    const next = { ...filters, jobId: '', campaignId: event.target.value }
                    setFilters(next)
                    await loadRecords(next)
                  }}
                >
                  <option value="">All campaigns</option>
                  {campaigns.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>{campaign.name}</option>
                  ))}
                </select>
              </label>
              <label className="setting-card">
                <span>Project tag</span>
                <input
                  type="text"
                  value={filters.projectTag}
                  onBlur={() => void loadRecords(filters)}
                  onChange={(event) => setFilters((current) => ({ ...current, jobId: '', projectTag: event.target.value }))}
                  placeholder="Filter by tag"
                />
              </label>
              <label className="setting-card">
                <span>Intent</span>
                <select
                  value={filters.intent}
                  onChange={async (event) => {
                    const next = { ...filters, jobId: '', intent: event.target.value }
                    setFilters(next)
                    await loadRecords(next)
                  }}
                >
                  <option value="">All intents</option>
                  {INTENT_OPTIONS.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label className="setting-card">
                <span>Mention status</span>
                <select
                  value={filters.mentionStatus}
                  onChange={async (event) => {
                    const next = { ...filters, jobId: '', mentionStatus: event.target.value }
                    setFilters(next)
                    await loadRecords(next)
                  }}
                >
                  <option value="">All</option>
                  <option value="mentioned">Primary brand mentioned</option>
                  <option value="not-mentioned">Primary brand not mentioned</option>
                </select>
              </label>
              <label className="setting-card">
                <span>Brand mention</span>
                <select
                  value={filters.brandId}
                  onChange={async (event) => {
                    const next = { ...filters, jobId: '', brandId: event.target.value }
                    setFilters(next)
                    await loadRecords(next)
                  }}
                >
                  <option value="">All brands</option>
                  {(currentCampaign?.brands ?? []).map((brand) => (
                    <option key={brand.id} value={brand.id}>{brand.name}</option>
                  ))}
                </select>
              </label>
              <label className="setting-card">
                <span>Competitor mention</span>
                <select
                  value={filters.competitorId}
                  onChange={async (event) => {
                    const next = { ...filters, jobId: '', competitorId: event.target.value }
                    setFilters(next)
                    await loadRecords(next)
                  }}
                >
                  <option value="">All competitors</option>
                  {(currentCampaign?.brands ?? []).filter((brand) => brand.type === 'competitor').map((brand) => (
                    <option key={brand.id} value={brand.id}>{brand.name}</option>
                  ))}
                </select>
              </label>
              <label className="setting-card">
                <span>View mode</span>
                <select
                  value={filters.latestOnly ? 'latest' : 'history'}
                  onChange={async (event) => {
                    const next = { ...filters, jobId: '', latestOnly: event.target.value === 'latest' }
                    setFilters(next)
                    await loadRecords(next)
                  }}
                >
                  <option value="latest">Latest result per prompt</option>
                  <option value="history">Full run history</option>
                </select>
              </label>
              <label className="setting-card">
                <span>Date from</span>
                <input
                  type="date"
                  value={filters.dateFrom}
                  onChange={async (event) => {
                    const next = { ...filters, jobId: '', dateFrom: event.target.value }
                    setFilters(next)
                    await loadRecords(next)
                  }}
                />
              </label>
              <label className="setting-card">
                <span>Date to</span>
                <input
                  type="date"
                  value={filters.dateTo}
                  onChange={async (event) => {
                    const next = { ...filters, jobId: '', dateTo: event.target.value }
                    setFilters(next)
                    await loadRecords(next)
                  }}
                />
              </label>
            </div>
          </section>

          <section id="answer-visibility-context" className="panel rail-panel">
            <div className="subsection-heading">
              <div>
                <p className="panel-kicker">Campaign context</p>
                <h3>Current project</h3>
              </div>
            </div>
            {currentCampaign ? (
              <div className="findings-list compact-findings">
                <article className="finding-card severity-low">
                  <div className="finding-topline">
                    <span>campaign</span>
                    <h4>{currentCampaign.name}</h4>
                  </div>
                  <p>{currentCampaign.promptCount} prompts, {currentCampaign.runCount} historical runs.</p>
                </article>
                {currentCampaign.brands.map((brand) => (
                  <article key={brand.id} className="finding-card severity-low">
                    <div className="finding-topline">
                      <span>{brand.type}</span>
                      <h4>{brand.name}</h4>
                    </div>
                    <p>{brand.variations.join(', ') || 'No extra variations saved.'}</p>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state"><p>Select a campaign to see saved brands and history.</p></div>
            )}
          </section>
        </aside>
      </section>
    </section>
  )
}
