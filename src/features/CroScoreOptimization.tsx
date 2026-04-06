import { useMemo, useState } from 'react'
import './cro-score.css'

type CroMetric = {
  label: string
  value: string
  hint: string
}

type CroCategoryScore = {
  category: string
  earned: number
  max: number
  found: number
  partial: number
  missing: number
  score: number
}

type CroChecklistResult = {
  id: string
  number: number
  actionItem: string
  pageArea: string
  impact: 'High' | 'Mid' | 'Low'
  effort: 'High' | 'Mid' | 'Low'
  applicable: boolean
  detectorMode: 'automated' | 'manual'
  state: 'found' | 'partial' | 'missing' | 'manual-review' | 'not-applicable'
  rationale: string
  evidence: string[]
  recommendation: string
  quickWinRank?: number
  strategistHeading?: string
  strategistBody?: string
  strategistEvidence?: string
  strategistInstruction?: string
  strategistExample?: string
  exampleReferences: string[]
  maxPoints: number
  weightedPoints: number
  priorityWeight: number
}

type CroFeatureSnapshot = {
  label: string
  state: 'found' | 'partial' | 'missing'
}

type CroPageAnalysis = {
  url: string
  title: string
  pageType: string
  checklistMode: string
  checklistModeLabel: string
  appliedAreas: string[]
  score: number
  grade: string
  screenshotDataUrl: string
  visualNote: string
  automationCoverage: {
    automatedItems: number
    manualItems: number
    applicableItems: number
  }
  metrics: CroMetric[]
  categoryScores: CroCategoryScore[]
  quickWins: CroChecklistResult[]
  strengths: CroChecklistResult[]
  checklistResults: CroChecklistResult[]
  featureSnapshot: CroFeatureSnapshot[]
}

type CroComparison = {
  scoreComparison: Array<{
    label: string
    url: string
    score: number
    grade: string
    quickWins: number
  }>
  categoryComparison: Array<{
    category: string
    scores: Array<{
      label: string
      score: number
    }>
  }>
  featureComparison: Array<{
    label: string
    primary: 'found' | 'partial' | 'missing'
    competitors: Array<{
      label: string
      state: 'found' | 'partial' | 'missing'
    }>
  }>
}

type CroResponse = {
  checklistSummary: {
    totalItems: number
    pageAreas: string[]
    highImpactCount: number
    quickWinCount: number
  }
  scoringModel: {
    stateWeights: {
      found: number
      partial: number
      missing: number
    }
    impactWeights: {
      High: number
      Mid: number
      Low: number
    }
    gradeBands: Array<{
      min: number
      grade: string
    }>
    notes: string[]
  }
  primary: CroPageAnalysis
  competitors: CroPageAnalysis[]
  comparison: CroComparison
  calibration: {
    benchmarkCount: number
    matchedBenchmarkCount: number
    benchmarkMedianScore: number | null
    benchmarkTopScore: number | null
    benchmarkBottomScore: number | null
    averageBenchmarkScore?: number | null
    calibratedScore: number
    calibratedGrade: string
    positionLabel: string
    percentileLabel: string
    primaryVsMedian: number | null
    primaryVsTop: number | null
    scoreDistribution: Array<{
      label: string
      url: string
      score: number
      grade: string
    }>
    categoryBenchmarks: Array<{
      category: string
      primaryScore: number
      benchmarkAverage: number | null
      deltaToBenchmarkAverage: number | null
    }>
    notes: string[]
  }
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({ error: 'The CRO API did not return JSON.' }))
  if (!response.ok) {
    throw new Error(data.error ?? 'Request failed.')
  }
  return data as T
}

function getScoreTone(score: number) {
  if (score >= 80) return 'excellent'
  if (score >= 65) return 'good'
  if (score >= 45) return 'mixed'
  return 'weak'
}

function stateLabel(state: CroChecklistResult['state']) {
  switch (state) {
    case 'found':
      return 'Found'
    case 'partial':
      return 'Partial'
    case 'missing':
      return 'Missing'
    case 'manual-review':
      return 'Manual review'
    default:
      return 'N/A'
  }
}

function downloadTextFile(fileName: string, mimeType: string, contents: string) {
  const blob = new Blob([contents], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function escapeCsvValue(value: string) {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }

  return value
}

export function CroScoreOptimization() {
  const [url, setUrl] = useState('')
  const [competitorUrls, setCompetitorUrls] = useState('')
  const [checklistMode, setChecklistMode] = useState('auto')
  const [result, setResult] = useState<CroResponse | null>(null)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [stateFilter, setStateFilter] = useState<'all' | 'missing' | 'partial' | 'found'>('all')

  const filteredChecklist = useMemo(() => {
    const rows = result?.primary.checklistResults ?? []
    if (stateFilter === 'all') return rows
    return rows.filter((item) => item.state === stateFilter)
  }, [result, stateFilter])

  const biggestGapCategory = useMemo(() => {
    const categories = result?.primary.categoryScores ?? []
    return [...categories].sort((left, right) => left.score - right.score)[0] ?? null
  }, [result])

  const exportSummary = () => {
    if (!result) return

    downloadTextFile(
      'cro-summary.json',
      'application/json',
      JSON.stringify(
        {
          url: result.primary.url,
          score: result.primary.score,
          grade: result.primary.grade,
          pageType: result.primary.pageType,
          metrics: result.primary.metrics,
          categoryScores: result.primary.categoryScores,
          comparison: result.comparison,
          calibration: result.calibration,
          scoringModel: result.scoringModel,
        },
        null,
        2,
      ),
    )
  }

  const exportChecklistCsv = () => {
    if (!result) return

    const rows = result.primary.checklistResults.map((item) => ({
      number: item.number,
      actionItem: item.actionItem,
      pageArea: item.pageArea,
      impact: item.impact,
      effort: item.effort,
      state: item.state,
      detectorMode: item.detectorMode,
      weightedPoints: Math.round(item.weightedPoints * 100) / 100,
      maxPoints: item.maxPoints,
      rationale: item.rationale,
      recommendation: item.recommendation,
      references: item.exampleReferences.join(' | '),
    }))

    const headers = Object.keys(rows[0] ?? {})
    const csv = [
      headers.join(','),
      ...rows.map((row) =>
        headers
          .map((header) => escapeCsvValue(String(row[header as keyof typeof row] ?? '')))
          .join(','),
      ),
    ].join('\n')

    downloadTextFile('cro-checklist-results.csv', 'text/csv;charset=utf-8', csv)
  }

  const handleScan = async () => {
    if (!url.trim()) {
      setError('Add a primary page URL for CRO scoring.')
      return
    }

    setIsLoading(true)
    setError('')

    try {
      const data = await readJson<CroResponse>('/api/cro-score/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          checklistMode,
          competitorUrls: competitorUrls
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean),
        }),
      })

      setResult(data)
    } catch (requestError) {
      setResult(null)
      setError(requestError instanceof Error ? requestError.message : 'CRO scan failed.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <section id="cro-root" className="cro-shell">
      <section className="panel toolbar-panel compact-toolbar-panel cro-entry-panel">
        <div className="cro-entry-grid">
          <div className="cro-entry-copy">
            <p className="panel-kicker">CRO score &amp; optimization</p>
            <h2>Scan a page against your CRO checklist</h2>
            <p>
              This feature grades a page using the checklist you uploaded, highlights the strongest
              missing CRO opportunities, and compares your page against competitor URLs.
            </p>
          </div>
          <div className="cro-entry-form">
            <label className="stacked-field">
              <span>Primary page URL</span>
              <input
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/pricing"
              />
            </label>
            <label className="stacked-field">
              <span>Checklist mode</span>
              <select value={checklistMode} onChange={(event) => setChecklistMode(event.target.value)}>
                <option value="auto">Auto detect</option>
                <option value="service">Service page</option>
                <option value="homepage">Homepage</option>
                <option value="landing">Landing page</option>
                <option value="demo">Demo page</option>
                <option value="pricing">Pricing page</option>
                <option value="product">Product page</option>
                <option value="blog">Blog page</option>
                <option value="template">Template page</option>
              </select>
            </label>
            <label className="stacked-field">
              <span>Competitor pages to compare</span>
              <textarea
                rows={4}
                value={competitorUrls}
                onChange={(event) => setCompetitorUrls(event.target.value)}
                placeholder={'https://competitor-one.com/pricing\nhttps://competitor-two.com/pricing'}
              />
            </label>
            <div className="cro-entry-actions">
              <button type="button" className="primary-button" onClick={() => void handleScan()} disabled={isLoading}>
                {isLoading ? 'Scanning CRO...' : 'Run CRO score'}
              </button>
              {result ? (
                <>
                  <button type="button" className="secondary-button" onClick={exportChecklistCsv}>
                    Export checklist CSV
                  </button>
                  <button type="button" className="secondary-button" onClick={exportSummary}>
                    Export summary
                  </button>
                </>
              ) : null}
              {result ? (
                <div className="feature-badge">
                  {result.primary.automationCoverage.automatedItems}/{result.primary.automationCoverage.applicableItems} automated checks
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {error ? <p className="error-text">{error}</p> : null}

      {result ? (
        <>
          <section id="cro-overview" className="dashboard-shell cro-dashboard-shell">
            <div className="dashboard-main">
              <article className="panel output-panel preview-panel cro-hero-panel">
                <div className="cro-hero-grid">
                  <div className="cro-hero-copy">
                    <p className="report-source">{result.primary.url}</p>
                    <h3>{result.primary.title || 'Untitled page'}</h3>
                    <p className="dashboard-reason">
                      This score is based on {result.primary.automationCoverage.automatedItems} automated checks
                      from your CRO checklist, weighted by impact and adjusted for full vs partial
                      implementation.
                    </p>
                    <div className="cro-grade-strip">
                      <div className={`cro-grade-card cro-grade-${getScoreTone(result.primary.score)}`}>
                        <span>CRO grade</span>
                        <strong>{result.primary.grade}</strong>
                      </div>
                      <div className={`cro-grade-card cro-grade-${getScoreTone(result.primary.score)}`}>
                        <span>CRO score</span>
                        <strong>{result.primary.score}/100</strong>
                      </div>
                    <div className="cro-grade-card">
                      <span>Page type</span>
                      <strong>{result.primary.pageType}</strong>
                    </div>
                    <div className="cro-grade-card">
                      <span>Checklist mode</span>
                      <strong>{result.primary.checklistModeLabel}</strong>
                    </div>
                    <div className={`cro-grade-card cro-grade-${getScoreTone(result.calibration.calibratedScore)}`}>
                      <span>Checklist-aligned grade</span>
                      <strong>{result.calibration.calibratedGrade}</strong>
                    </div>
                    <div className={`cro-grade-card cro-grade-${getScoreTone(result.calibration.calibratedScore)}`}>
                      <span>Checklist-aligned score</span>
                      <strong>{result.calibration.calibratedScore}/100</strong>
                    </div>
                    <div className="cro-grade-card">
                      <span>Checklist position</span>
                      <strong>{result.calibration.positionLabel}</strong>
                    </div>
                  </div>
                  </div>
                  <div className="cro-hero-visual">
                    {result.primary.screenshotDataUrl ? (
                      <img src={result.primary.screenshotDataUrl} alt="CRO page capture" className="cro-screenshot" />
                    ) : (
                      <div className="empty-state">Rendered screenshot not available for this scan.</div>
                    )}
                    <p className="mini-note">{result.primary.visualNote}</p>
                  </div>
                </div>
              </article>

              <section className="dashboard-module-grid">
                <article className="panel preview-panel dashboard-module-panel">
                  <div className="subsection-heading">
                    <div>
                      <p className="panel-kicker">Summary</p>
                      <h3>CRO score snapshot</h3>
                    </div>
                  </div>
                  <div className="metric-grid compact-metric-grid">
                    {result.primary.metrics.map((metric) => (
                      <article key={metric.label} className="metric-card">
                        <span>{metric.label}</span>
                        <strong>{metric.value}</strong>
                        <small>{metric.hint}</small>
                      </article>
                    ))}
                  </div>
                  {biggestGapCategory ? (
                    <div className="cro-gap-callout">
                      <strong>Biggest score gap</strong>
                      <span>{biggestGapCategory.category}</span>
                      <small>{biggestGapCategory.score}/100 for this checklist section</small>
                    </div>
                  ) : null}
                  <div className="cro-gap-callout">
                    <strong>Checklist areas used</strong>
                    <span>{result.primary.appliedAreas.join(', ')}</span>
                    <small>The score only uses these checklist sections plus Site Wide.</small>
                  </div>
                </article>

                <article id="cro-quick-wins" className="panel preview-panel dashboard-module-panel">
                  <div className="subsection-heading">
                    <div>
                      <p className="panel-kicker">Optimization</p>
                      <h3>Top CRO quick wins</h3>
                    </div>
                  </div>
                  <div className="cro-quickwins-grid">
                    {result.primary.quickWins.slice(0, 5).map((item) => (
                      <article key={item.id} className="cro-quickwin-card">
                        <div className="cro-quickwin-topline">
                          <span className={`risk-pill risk-${item.state === 'missing' ? 'high' : 'medium'}`}>
                            {stateLabel(item.state)}
                          </span>
                          <span>Quick win {item.quickWinRank ?? '-'}</span>
                        </div>
                        <h4>{item.strategistHeading || item.actionItem}</h4>
                        <p>{item.strategistBody || item.rationale}</p>
                        {item.strategistEvidence ? (
                          <div className="cro-quickwin-detail-block">
                            <strong>What we saw</strong>
                            <p>{item.strategistEvidence}</p>
                          </div>
                        ) : null}
                        {item.strategistInstruction ? (
                          <div className="cro-quickwin-detail-block">
                            <strong>What to change</strong>
                            <p>{item.strategistInstruction}</p>
                          </div>
                        ) : null}
                        {item.strategistExample ? (
                          <div className="cro-quickwin-detail-block cro-quickwin-example">
                            <strong>Example implementation</strong>
                            <p>{item.strategistExample}</p>
                          </div>
                        ) : null}
                        <small>{item.impact} impact · {item.effort} effort</small>
                      </article>
                    ))}
                  </div>
                </article>
              </section>

              <section id="cro-comparison" className="dashboard-module-grid">
                <article className="panel preview-panel dashboard-module-panel dashboard-module-wide">
                  <div className="subsection-heading">
                    <div>
                      <p className="panel-kicker">Comparison</p>
                      <h3>Overall CRO comparison</h3>
                    </div>
                  </div>
                  <div className="cro-scoreboard">
                    {result.comparison.scoreComparison.map((item) => (
                      <article key={`${item.label}-${item.url}`} className="cro-scoreboard-row">
                        <div>
                          <strong>{item.label}</strong>
                          <p>{item.url}</p>
                        </div>
                        <div className="cro-scoreboard-bar">
                          <span
                            className={`cro-scoreboard-fill cro-scoreboard-${getScoreTone(item.score)}`}
                            style={{ width: `${item.score}%` }}
                          />
                        </div>
                        <div className="cro-scoreboard-stats">
                          <strong>{item.score}</strong>
                          <span>{item.grade}</span>
                        </div>
                      </article>
                    ))}
                  </div>
                </article>

                <article className="panel preview-panel dashboard-module-panel">
                  <div className="subsection-heading">
                    <div>
                      <p className="panel-kicker">Features</p>
                      <h3>CRO feature comparison</h3>
                    </div>
                  </div>
                  <div className="cro-feature-matrix">
                    {result.comparison.featureComparison.map((feature) => (
                      <div key={feature.label} className="cro-feature-row">
                        <strong>{feature.label}</strong>
                        <div className="cro-feature-state-row">
                          <span className={`cro-feature-pill cro-feature-${feature.primary}`}>You: {feature.primary}</span>
                          {feature.competitors.map((competitor) => (
                            <span
                              key={`${feature.label}-${competitor.label}`}
                              className={`cro-feature-pill cro-feature-${competitor.state}`}
                            >
                              {competitor.label}: {competitor.state}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </article>
              </section>

              <section id="cro-categories" className="panel preview-panel dashboard-module-panel dashboard-module-wide">
                <div className="subsection-heading">
                  <div>
                    <p className="panel-kicker">Checklist sections</p>
                    <h3>Category score chart</h3>
                  </div>
                </div>
                <div className="cro-category-chart">
                  {result.comparison.categoryComparison.map((row) => (
                    <article key={row.category} className="cro-category-row">
                      <div className="cro-category-title">
                        <strong>{row.category}</strong>
                      </div>
                      <div className="cro-category-bars">
                        {row.scores.map((scoreRow) => (
                          <div key={`${row.category}-${scoreRow.label}`} className="cro-category-bar-row">
                            <span>{scoreRow.label}</span>
                            <div className="cro-scoreboard-bar">
                              <span
                                className={`cro-scoreboard-fill cro-scoreboard-${getScoreTone(scoreRow.score)}`}
                                style={{ width: `${scoreRow.score}%` }}
                              />
                            </div>
                            <strong>{scoreRow.score}</strong>
                          </div>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <section id="cro-strengths" className="dashboard-module-grid">
                <article className="panel preview-panel dashboard-module-panel">
                  <div className="subsection-heading">
                    <div>
                      <p className="panel-kicker">Checklist read</p>
                      <h3>How the score was interpreted</h3>
                    </div>
                  </div>
                  <div className="findings-list compact-findings">
                    {result.calibration.notes.map((note) => (
                      <article key={note} className="finding-card severity-low">
                        <p>{note}</p>
                      </article>
                    ))}
                  </div>
                </article>
              </section>

              <section id="cro-checklist" className="panel preview-panel dashboard-module-panel dashboard-module-wide">
                <div className="subsection-heading">
                  <div>
                    <p className="panel-kicker">Checklist detail</p>
                    <h3>CRO checklist results</h3>
                  </div>
                  <div className="cro-filter-tabs">
                    {(['all', 'missing', 'partial', 'found'] as const).map((filter) => (
                      <button
                        key={filter}
                        type="button"
                        className={`dashboard-tab ${stateFilter === filter ? 'active' : ''}`}
                        onClick={() => setStateFilter(filter)}
                      >
                        {filter}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="cro-checklist-stack">
                  {filteredChecklist.slice(0, 10).map((item) => (
                    <article key={item.id} className={`cro-checklist-card ${item.state}`}>
                      <div className="cro-checklist-header">
                        <div>
                          <span className="cro-checklist-number">#{item.number}</span>
                          <strong>{item.actionItem}</strong>
                        </div>
                        <div className="card-pill-stack">
                          <span className={`risk-pill risk-${item.state === 'found' ? 'low' : item.state === 'partial' ? 'medium' : 'high'}`}>
                            {stateLabel(item.state)}
                          </span>
                          <span className="workspace-chip">{item.pageArea}</span>
                        </div>
                      </div>
                      <p>{item.rationale}</p>
                      <div className="dashboard-meta">
                        <span>{item.impact} impact</span>
                        <span>{item.effort} effort</span>
                        <span>{item.detectorMode === 'manual' ? 'manual review' : `${Math.round(item.weightedPoints)}/${item.maxPoints} pts`}</span>
                      </div>
                      <small>{item.recommendation}</small>
                    </article>
                  ))}
                </div>
              </section>
            </div>

            <aside className="dashboard-rail">
              <section className="panel rail-panel">
                <div className="subsection-heading">
                  <div>
                    <p className="panel-kicker">Checklist basis</p>
                    <h3>Scoring inputs</h3>
                  </div>
                </div>
                <div className="rail-metric-list">
                  <div className="rail-metric-item">
                    <span>Total checklist items</span>
                    <strong>{result.checklistSummary.totalItems}</strong>
                  </div>
                  <div className="rail-metric-item">
                    <span>High-impact checks</span>
                    <strong>{result.checklistSummary.highImpactCount}</strong>
                  </div>
                  <div className="rail-metric-item">
                    <span>Quick-win checks</span>
                    <strong>{result.checklistSummary.quickWinCount}</strong>
                  </div>
                </div>
              </section>

              <section className="panel rail-panel">
                <div className="subsection-heading">
                  <div>
                    <p className="panel-kicker">How the score works</p>
                    <h3>Weighted CRO grade</h3>
                  </div>
                </div>
                <div className="findings-list compact-findings">
                  <article className="finding-card severity-low">
                    <div className="finding-topline">
                      <span>found</span>
                      <strong>full points</strong>
                    </div>
                    <p>Checklist items fully detected on the page receive full impact weight.</p>
                  </article>
                  <article className="finding-card severity-medium">
                    <div className="finding-topline">
                      <span>partial</span>
                      <strong>55% points</strong>
                    </div>
                    <p>Partial implementation still counts, but less than a clean full implementation.</p>
                  </article>
                  <article className="finding-card severity-high">
                    <div className="finding-topline">
                      <span>missing</span>
                      <strong>0 points</strong>
                    </div>
                    <p>Missing items create the biggest opportunities, especially when impact is high and effort is low.</p>
                  </article>
                </div>
              </section>
            </aside>
          </section>
        </>
      ) : (
        <div className="empty-state">
          <p>Run a CRO scan to grade the page against the checklist, surface quick wins, and compare it with competitor pages.</p>
        </div>
      )}
    </section>
  )
}

