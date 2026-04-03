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

type FilterState = {
  campaignId: string
  projectTag: string
  intent: string
  mentionStatus: string
  brandId: string
  competitorId: string
  dateFrom: string
  dateTo: string
}

const INTENT_OPTIONS = ['informational', 'commercial', 'comparison', 'local', 'branded', 'non-branded']

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.error ?? 'Request failed.')
  }
  return data as T
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
  const [filters, setFilters] = useState<FilterState>({
    campaignId: '',
    projectTag: '',
    intent: '',
    mentionStatus: '',
    brandId: '',
    competitorId: '',
    dateFrom: '',
    dateTo: '',
  })

  const currentCampaign = useMemo(
    () => campaigns.find((campaign) => campaign.id === filters.campaignId) ?? null,
    [campaigns, filters.campaignId],
  )

  const loadRecords = async (nextFilters: FilterState = filters) => {
    const search = new URLSearchParams()
    if (nextFilters.campaignId) search.set('campaignId', nextFilters.campaignId)
    if (nextFilters.projectTag) search.set('projectTag', nextFilters.projectTag)
    if (nextFilters.intent) search.set('intent', nextFilters.intent)
    if (nextFilters.mentionStatus) search.set('mentionStatus', nextFilters.mentionStatus)
    if (nextFilters.brandId) search.set('brandId', nextFilters.brandId)
    if (nextFilters.competitorId) search.set('competitorId', nextFilters.competitorId)
    if (nextFilters.dateFrom) search.set('dateFrom', nextFilters.dateFrom)
    if (nextFilters.dateTo) search.set('dateTo', nextFilters.dateTo)

    const data = await readJson<VisibilityResponse>(`/api/answer-visibility/records?${search.toString()}`)
    setCampaigns(data.campaigns)
    setRecords(data.records)
    setSummary(data.summary)
  }

  useEffect(() => {
    void loadRecords()
  }, [])

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

      await readJson('/api/answer-visibility/run', {
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

      await loadRecords({
        ...filters,
        campaignId: filters.campaignId,
      })
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
      await readJson('/api/answer-visibility/rerun', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          promptIds,
          providerPreference,
        }),
      })
      await loadRecords(filters)
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Visibility rerun failed.')
    } finally {
      setIsRerunning(false)
    }
  }

  const handleExport = () => {
    const search = new URLSearchParams()
    if (filters.campaignId) search.set('campaignId', filters.campaignId)
    if (filters.projectTag) search.set('projectTag', filters.projectTag)
    if (filters.intent) search.set('intent', filters.intent)
    if (filters.mentionStatus) search.set('mentionStatus', filters.mentionStatus)
    if (filters.brandId) search.set('brandId', filters.brandId)
    if (filters.competitorId) search.set('competitorId', filters.competitorId)
    if (filters.dateFrom) search.set('dateFrom', filters.dateFrom)
    if (filters.dateTo) search.set('dateTo', filters.dateTo)
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
                </div>

                <div className="dashboard-module-grid">
                  <article className="panel preview-panel dashboard-module-panel">
                    <div className="subsection-heading">
                      <div>
                        <p className="panel-kicker">Mention share</p>
                        <h3>Brand share across all answers</h3>
                      </div>
                    </div>
                    <div className="score-chart">
                      {summary.mentionShare.map((item) => (
                        <div key={item.brandId} className="score-bar-row">
                          <div className="score-bar-meta">
                            <strong>{item.name}</strong>
                            <span>{formatPercent(item.share)}</span>
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
                <h3>AI answer visibility table</h3>
              </div>
            </div>

            <div className="opportunity-table-wrap">
              <table className="opportunity-table">
                <thead>
                  <tr>
                    <th>Prompt</th>
                    <th>Date checked</th>
                    <th>Brand mentioned</th>
                    <th>Primary mentions</th>
                    <th>Competitors</th>
                    <th>First mentioned brand</th>
                    <th>Primary position</th>
                    <th>Surfaced domains</th>
                    <th>Sources</th>
                    <th>Answer</th>
                    <th>Campaign</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr key={record.id}>
                      <td className="url-cell">{record.prompt}</td>
                      <td>{formatDate(record.checkedAt)}</td>
                      <td>{record.primaryBrandMentioned ? 'Yes' : 'No'}</td>
                      <td>
                        <strong>{record.primaryBrandMentionCount}</strong>
                        {record.deltas.primaryMentionCountDelta !== null ? (
                          <div className="mini-note">Delta {record.deltas.primaryMentionCountDelta > 0 ? '+' : ''}{record.deltas.primaryMentionCountDelta}</div>
                        ) : null}
                      </td>
                      <td>{record.competitorMentionCounts.map((item) => `${item.name}: ${item.count}`).join(', ') || '-'}</td>
                      <td>{record.firstMentionedBrand ?? '-'}</td>
                      <td>{record.primaryBrandFirstPosition ?? '-'}</td>
                      <td>{record.surfacedDomains.join(', ') || '-'}</td>
                      <td>{record.sourceCount}</td>
                      <td>
                        <details>
                          <summary>{record.answerSnapshot || 'Open answer'}</summary>
                          <p className="answer-record-expanded">{record.rawAnswerText}</p>
                        </details>
                      </td>
                      <td>{record.projectTag || record.campaignName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                    const next = { ...filters, campaignId: event.target.value }
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
                  onChange={(event) => setFilters((current) => ({ ...current, projectTag: event.target.value }))}
                  placeholder="Filter by tag"
                />
              </label>
              <label className="setting-card">
                <span>Intent</span>
                <select
                  value={filters.intent}
                  onChange={async (event) => {
                    const next = { ...filters, intent: event.target.value }
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
                    const next = { ...filters, mentionStatus: event.target.value }
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
                    const next = { ...filters, brandId: event.target.value }
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
                    const next = { ...filters, competitorId: event.target.value }
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
                <span>Date from</span>
                <input
                  type="date"
                  value={filters.dateFrom}
                  onChange={async (event) => {
                    const next = { ...filters, dateFrom: event.target.value }
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
                    const next = { ...filters, dateTo: event.target.value }
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
