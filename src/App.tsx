import { useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import * as XLSX from 'xlsx'
import './App.css'

type Severity = 'high' | 'medium' | 'low'
type RankingStrategy = 'second-page-first' | 'second-page-only' | 'below-page-two'
type RelevanceMode = 'assume-relevant' | 'require-column-when-present'
type OverrideChoice = 'auto' | 'priority' | 'likely-relevant' | 'needs-review' | 'not-relevant'
type ReviewStatus = 'pending' | 'approved' | 'rejected'
type OpportunityBucket = 'second-page' | 'below-second-page' | 'other'
type CannibalizationRisk = 'none' | 'medium' | 'high'
type Intent = 'commercial' | 'informational' | 'navigational' | 'mixed'
type PageType = 'service' | 'blog' | 'category' | 'homepage' | 'general'

type Finding = {
  id: string
  severity: Severity
  title: string
  detail: string
}

type Metric = {
  label: string
  value: string
  hint: string
}

type Opportunity = {
  id: string
  url: string
  keyword: string | null
  searchVolume: number
  ranking: number
  keywordDifficulty: number | null
  traffic: number | null
  relevanceLabel: string
  reason: string
  bucket: OpportunityBucket
  baseOpportunityScore: number
  inferredIntent: Intent
  inferredPageType: PageType
  cannibalizationRisk: CannibalizationRisk
  competingUrlCount: number
}

type AnalysisReport = {
  sourceLabel: string
  score: number
  summary: string
  findings: Finding[]
  metrics: Metric[]
  opportunities: Opportunity[]
  detectedColumns: Array<{ field: string; header: string | null }>
}

type PageScanResponse = {
  url: string
  keyword: string
  title: string
  metaDescription: string
  headings: string[]
  contentSample: string
  analysis: {
    score: number
    strategistVerdict: string
    reasons: string[]
    inferredIntent: Intent
    pageType: PageType
    matchBreakdown: {
      urlMatches: number
      titleExactMatch: boolean
      titleMatches: number
      headingMatches: number
      metaMatches: number
      bodyMatches: number
      exactPhraseInBody: boolean
      repeatedTermPresence: boolean
      topicClueCoverage: boolean
      mixedPhraseAndTerms: boolean
      keywordInFirstHundredWords: boolean
      wordCount: number
      titleLength: number
      metaLength: number
      h1TitleAlignment: boolean
    }
  }
}

type BulkScanResult = PageScanResponse & {
  opportunityId: string
}

type RowRecord = Record<string, string | number | boolean | null | undefined>

type AnalysisSettings = {
  minimumSearchVolume: number
  strategy: RankingStrategy
  relevanceMode: RelevanceMode
  brandTerms: string
  competitorTerms: string
  excludeBrandTerms: boolean
  deprioritizeCompetitors: boolean
}

type FieldKey =
  | 'url'
  | 'keyword'
  | 'searchVolume'
  | 'ranking'
  | 'keywordDifficulty'
  | 'traffic'
  | 'relevance'

type BaseCandidate = {
  url: string
  keyword: string | null
  searchVolume: number
  ranking: number
  keywordDifficulty: number | null
  traffic: number | null
  bucket: OpportunityBucket
  inferredIntent: Intent
  inferredPageType: PageType
  relevanceLabel: string
  strategistRelevance: number
}

const defaultSettings: AnalysisSettings = {
  minimumSearchVolume: 50,
  strategy: 'second-page-first',
  relevanceMode: 'assume-relevant',
  brandTerms: '',
  competitorTerms: '',
  excludeBrandTerms: true,
  deprioritizeCompetitors: true,
}

const fieldLabels: Record<FieldKey, string> = {
  url: 'URL',
  keyword: 'Keyword',
  searchVolume: 'Search volume',
  ranking: 'Keyword ranking',
  keywordDifficulty: 'Keyword difficulty',
  traffic: 'Traffic',
  relevance: 'Relevance',
}

const fieldAliases: Record<FieldKey, string[]> = {
  url: ['url', 'page url', 'page', 'address', 'landing page', 'landing url', 'target url', 'destination url', 'slug'],
  keyword: ['keyword', 'query', 'search query', 'term', 'target keyword', 'primary keyword'],
  searchVolume: ['search volume', 'volume', 'avg monthly searches', 'average monthly search volume', 'monthly volume', 'keyword volume', 'sv'],
  ranking: ['ranking', 'rank', 'position', 'avg position', 'average position', 'keyword ranking', 'current position', 'serp position'],
  keywordDifficulty: ['keyword difficulty', 'difficulty', 'kd', 'seo difficulty'],
  traffic: ['traffic', 'estimated traffic', 'organic traffic', 'monthly traffic', 'est traffic'],
  relevance: ['relevance', 'relevant', 'page relevance', 'match', 'alignment', 'intent match'],
}

const overrideOptions: Array<{ value: OverrideChoice; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'priority', label: 'Priority' },
  { value: 'likely-relevant', label: 'Likely Relevant' },
  { value: 'needs-review', label: 'Needs Review' },
  { value: 'not-relevant', label: 'Not Relevant' },
]

function App() {
  const [currentView, setCurrentView] = useState<'dashboard' | 'opportunities'>('dashboard')
  const [settings, setSettings] = useState<AnalysisSettings>(defaultSettings)
  const [report, setReport] = useState<AnalysisReport | null>(null)
  const [fileName, setFileName] = useState('')
  const [isProcessingFile, setIsProcessingFile] = useState(false)
  const [scanUrl, setScanUrl] = useState('')
  const [scanKeyword, setScanKeyword] = useState('')
  const [scanResult, setScanResult] = useState<PageScanResponse | null>(null)
  const [scanError, setScanError] = useState('')
  const [isScanningPage, setIsScanningPage] = useState(false)
  const [isBulkScanning, setIsBulkScanning] = useState(false)
  const [scanOverride, setScanOverride] = useState<OverrideChoice>('auto')
  const [opportunityOverrides, setOpportunityOverrides] = useState<Record<string, OverrideChoice>>({})
  const [reviewStatuses, setReviewStatuses] = useState<Record<string, ReviewStatus>>({})
  const [bulkScanResults, setBulkScanResults] = useState<Record<string, BulkScanResult>>({})

  const displayedOpportunities = useMemo(() => {
    if (!report) {
      return []
    }

    return [...report.opportunities]
      .map((opportunity) => ({
        ...opportunity,
        override: opportunityOverrides[opportunity.id] ?? 'auto',
        reviewStatus: reviewStatuses[opportunity.id] ?? 'pending',
        displayScore: applyOverride(opportunity.baseOpportunityScore, opportunityOverrides[opportunity.id] ?? 'auto'),
      }))
      .filter((opportunity) => (reviewStatuses[opportunity.id] ?? 'pending') !== 'rejected')
      .sort((left, right) => right.displayScore - left.displayScore)
  }, [opportunityOverrides, report, reviewStatuses])

  const displayedReportScore = useMemo(() => {
    if (displayedOpportunities.length === 0) {
      return report?.score ?? 0
    }

    return Math.max(0, Math.min(100, displayedOpportunities[0].displayScore))
  }, [displayedOpportunities, report])

  const displayedScanScore = scanResult ? applyOverride(scanResult.analysis.score, scanOverride) : 0
  const dashboardOpportunities = displayedOpportunities.slice(0, 6)
  const previewOpportunities = displayedOpportunities.slice(0, 3)

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    setIsProcessingFile(true)
    setFileName(file.name)

    try {
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer, { type: 'array' })
      const firstSheetName = workbook.SheetNames[0]
      const firstSheet = workbook.Sheets[firstSheetName]
      const rows = XLSX.utils.sheet_to_json<RowRecord>(firstSheet, { defval: '' })
      setOpportunityOverrides({})
      setReviewStatuses({})
      setBulkScanResults({})
      setReport(analyzeSheet(file.name, rows, settings, ''))
      setCurrentView('dashboard')
    } finally {
      setIsProcessingFile(false)
      event.target.value = ''
    }
  }

  const fetchPageScan = async (targetUrl: string, keyword: string) => {
    if (!targetUrl.trim() || !keyword.trim()) {
      throw new Error('Add both a URL and a keyword for the live page scan.')
    }

    const params = new URLSearchParams({ url: targetUrl.trim(), keyword: keyword.trim() })
    const response = await fetch(`/api/page-scan?${params.toString()}`)
    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error ?? 'Page scan failed.')
    }

    return data as PageScanResponse
  }

  const runPageScan = async (targetUrl: string, keyword: string) => {
    setIsScanningPage(true)
    setScanError('')
    setScanOverride('auto')
    setScanUrl(targetUrl)
    setScanKeyword(keyword)

    try {
      const data = await fetchPageScan(targetUrl, keyword)
      setScanResult(data)
    } catch (error) {
      setScanResult(null)
      setScanError(error instanceof Error ? error.message : 'Page scan failed.')
    } finally {
      setIsScanningPage(false)
    }
  }

  const runBulkPageScans = async () => {
    const targets = dashboardOpportunities.filter((opportunity) => opportunity.keyword)

    if (targets.length === 0) {
      setScanError('There are no shortlisted opportunities with keywords available for bulk scanning.')
      return
    }

    setIsBulkScanning(true)
    setScanError('')

    try {
      const results = await Promise.all(
        targets.map(async (opportunity) => {
          const data = await fetchPageScan(opportunity.url, opportunity.keyword ?? '')
          return {
            ...data,
            opportunityId: opportunity.id,
          } satisfies BulkScanResult
        }),
      )

      setBulkScanResults((current) => {
        const next = { ...current }
        results.forEach((result) => {
          next[result.opportunityId] = result
        })
        return next
      })
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Bulk page scan failed.')
    } finally {
      setIsBulkScanning(false)
    }
  }

  const scanOverrideMeta = getOverrideMeta(scanOverride)

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">SEO Opportunity Finder</p>
          <h1 className="topbar-title">
            {currentView === 'dashboard' ? 'Main dashboard' : 'Opportunity workspace'}
          </h1>
        </div>
        {report ? (
          <div className="topbar-actions">
            {currentView === 'opportunities' ? (
              <button type="button" className="secondary-button" onClick={() => setCurrentView('dashboard')}>
                Back to dashboard
              </button>
            ) : (
              <button type="button" className="secondary-button" onClick={() => setCurrentView('opportunities')}>
                Open opportunities
              </button>
            )}
          </div>
        ) : null}
      </header>

      {currentView === 'dashboard' ? (
        <>
          <section className="panel toolbar-panel">
            <div className="toolbar-row">
              <div>
                <p className="panel-kicker">Workspace</p>
                <h2>Upload and review</h2>
                <p className="panel-copy">Load a sheet, review the best opportunities in the center, and adjust controls from the right rail.</p>
              </div>
              <div className="toolbar-actions">
                <label className="upload-card toolbar-upload" htmlFor="spreadsheet-input">
                  <input id="spreadsheet-input" type="file" accept=".csv,.xlsx,.xls,.tsv" onChange={handleFileChange} />
                  <strong>{isProcessingFile ? 'Reading your sheet...' : 'Upload SEO sheet'}</strong>
                  <span>{fileName ? `Loaded: ${fileName}` : 'CSV, Excel, and TSV supported'}</span>
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setCurrentView('opportunities')}
                  disabled={!report}
                >
                  Open opportunities
                </button>
              </div>
            </div>
          </section>

          <section className="dashboard-shell">
            <div className="dashboard-main">
              {report ? (
                <>
                  <article className="panel output-panel preview-panel">
                    <div className="report-hero">
                      <div>
                        <p className="report-source">{report.sourceLabel}</p>
                        <h3>{report.summary}</h3>
                      </div>
                      <div className="score-badge">
                        <span>Opportunity score</span>
                        <strong>{displayedReportScore}</strong>
                      </div>
                    </div>

                    <div className="metric-grid">
                      {report.metrics.map((metric) => (
                        <article key={metric.label} className="metric-card">
                          <span>{metric.label}</span>
                          <strong>{metric.value}</strong>
                          <small>{metric.hint}</small>
                        </article>
                      ))}
                    </div>
                  </article>

                  <article className="panel preview-panel">
                    <div className="subsection-heading">
                      <div>
                        <p className="panel-kicker">Results</p>
                        <h3>Top opportunities</h3>
                      </div>
                      <button type="button" className="secondary-button" onClick={() => setCurrentView('opportunities')}>
                        Full workspace
                      </button>
                    </div>

                    {previewOpportunities.length > 0 ? (
                      <div className="dashboard-list preview-list">
                        {previewOpportunities.map((opportunity) => (
                          <article key={`preview-${opportunity.id}`} className="dashboard-card compact-card">
                            <div className="dashboard-header">
                              <div>
                                <span className="dashboard-score">{opportunity.displayScore}</span>
                                <h4>{opportunity.keyword ?? 'Untitled opportunity'}</h4>
                              </div>
                              <span className={`risk-pill risk-${opportunity.cannibalizationRisk}`}>
                                {opportunity.cannibalizationRisk}
                              </span>
                            </div>
                            <p className="dashboard-url">{opportunity.url}</p>
                            <p className="dashboard-reason">{opportunity.reason}</p>
                            <div className="dashboard-meta">
                              <span>Rank {opportunity.ranking}</span>
                              <span>Volume {opportunity.searchVolume}</span>
                              <span>{opportunity.inferredIntent} intent</span>
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-state">
                        <p>No opportunities are ready yet for preview.</p>
                      </div>
                    )}
                  </article>

                  <article className="panel preview-panel">
                    <div className="subsection-heading">
                      <div>
                        <p className="panel-kicker">Signals</p>
                        <h3>Detected columns</h3>
                      </div>
                    </div>
                    <div className="chip-list">
                      {report.detectedColumns.map((column) => (
                        <span key={column.field} className={`column-chip ${column.header ? 'found' : 'missing'}`}>
                          {column.field}: {column.header ?? 'not found'}
                        </span>
                      ))}
                    </div>
                  </article>
                </>
              ) : (
                <section className="panel empty-state center-empty">
                  <p>Upload a spreadsheet to generate your first opportunity list.</p>
                </section>
              )}
            </div>

            <aside className="dashboard-rail">
              <section className="panel rail-panel">
                <div className="subsection-heading">
                  <div>
                    <p className="panel-kicker">Right rail</p>
                    <h3>Analysis controls</h3>
                  </div>
                </div>
                <div className="settings-grid">
                  <label className="setting-card">
                    <span>Minimum search volume</span>
                    <input
                      type="number"
                      min="0"
                      value={settings.minimumSearchVolume}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          minimumSearchVolume: Number(event.target.value || 0),
                        }))
                      }
                    />
                    <small>Default is 50+.</small>
                  </label>

                  <label className="setting-card">
                    <span>Ranking strategy</span>
                    <select
                      value={settings.strategy}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          strategy: event.target.value as RankingStrategy,
                        }))
                      }
                    >
                      <option value="second-page-first">Second page first</option>
                      <option value="second-page-only">Second page only</option>
                      <option value="below-page-two">Below page 2 only</option>
                    </select>
                    <small>Choose how aggressive the shortlist should be.</small>
                  </label>

                  <label className="setting-card">
                    <span>Brand terms</span>
                    <input
                      type="text"
                      placeholder="brand, company, product"
                      value={settings.brandTerms}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          brandTerms: event.target.value,
                        }))
                      }
                    />
                    <small>Comma-separated. Used for brand filtering.</small>
                  </label>

                  <label className="setting-card">
                    <span>Competitor terms</span>
                    <input
                      type="text"
                      placeholder="competitor one, competitor two"
                      value={settings.competitorTerms}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          competitorTerms: event.target.value,
                        }))
                      }
                    />
                    <small>Comma-separated. Used to deprioritize competitor keywords.</small>
                  </label>
                </div>
              </section>

              <section className="panel rail-panel">
                <div className="subsection-heading">
                  <div>
                    <p className="panel-kicker">Page check</p>
                    <h3>Live page scan</h3>
                  </div>
                </div>

                <div className="scan-grid rail-scan-grid">
                  <input type="url" placeholder="https://example.com/target-page" value={scanUrl} onChange={(event) => setScanUrl(event.target.value)} />
                  <input type="text" placeholder="target keyword" value={scanKeyword} onChange={(event) => setScanKeyword(event.target.value)} />
                  <button type="button" onClick={() => void runPageScan(scanUrl, scanKeyword)}>
                    {isScanningPage ? 'Scanning...' : 'Run scan'}
                  </button>
                </div>

                {scanError ? <p className="error-text">{scanError}</p> : null}

                {scanResult ? (
                  <div className="report-stack page-scan-result compact-scan">
                    <div className="report-hero">
                      <div>
                        <p className="report-source">{scanResult.url}</p>
                        <h3>{scanOverride === 'auto' ? scanResult.analysis.strategistVerdict : scanOverrideMeta.verdict}</h3>
                      </div>
                      <div className="score-badge">
                        <span>Relevance</span>
                        <strong>{displayedScanScore}</strong>
                      </div>
                    </div>

                    <div className="override-strip">
                      <label>
                        <span>Manual override</span>
                        <select value={scanOverride} onChange={(event) => setScanOverride(event.target.value as OverrideChoice)}>
                          {overrideOptions.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                      <p>{scanOverrideMeta.note}</p>
                    </div>

                    <div className="metric-grid compact-metric-grid">
                      <article className="metric-card"><span>Intent</span><strong>{scanResult.analysis.inferredIntent}</strong><small>Inferred from keyword wording</small></article>
                      <article className="metric-card"><span>Page type</span><strong>{scanResult.analysis.pageType}</strong><small>Inferred from URL and page signals</small></article>
                    </div>
                  </div>
                ) : null}
              </section>
            </aside>
          </section>
        </>
      ) : (
        <section className="panel output-panel workspace-panel">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">Workspace</p>
              <h2>Review the opportunities</h2>
            </div>
            <p className="panel-copy">This ranking combines upside, intent fit, cannibalization risk, and your manual calls.</p>
          </div>

          {report ? (
            <div className="report-stack">
              <div className="detected-columns panel-subsection">
                <div className="subsection-heading">
                  <h3>Detected columns</h3>
                  <p>The app tries to understand varied column names automatically.</p>
                </div>
                <div className="chip-list">
                  {report.detectedColumns.map((column) => (
                    <span key={column.field} className={`column-chip ${column.header ? 'found' : 'missing'}`}>
                      {column.field}: {column.header ?? 'not found'}
                    </span>
                  ))}
                </div>
              </div>

              <div className="panel-subsection">
                <div className="subsection-heading">
                  <h3>Opportunity Dashboard</h3>
                  <p>Shortlist first, review in context, and only export later if you want it.</p>
                </div>
                <div className="dashboard-toolbar">
                  <p>Top shortlisted opportunities with quick reasoning and optional live scan enrichment.</p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void runBulkPageScans()}
                    disabled={isBulkScanning || dashboardOpportunities.length === 0}
                  >
                    {isBulkScanning ? 'Bulk scanning...' : 'Bulk scan shortlist'}
                  </button>
                </div>
                <div className="queue-summary">
                  <span>Approved: {displayedOpportunities.filter((item) => item.reviewStatus === 'approved').length}</span>
                  <span>Pending: {displayedOpportunities.filter((item) => item.reviewStatus === 'pending').length}</span>
                  <span>Rejected hidden: {Object.values(reviewStatuses).filter((status) => status === 'rejected').length}</span>
                </div>
                <div className="dashboard-list">
                  {dashboardOpportunities.map((opportunity) => {
                    const bulkScan = bulkScanResults[opportunity.id]
                    return (
                      <article key={`dashboard-${opportunity.id}`} className="dashboard-card">
                        <div className="dashboard-header">
                          <div>
                            <span className="dashboard-score">{opportunity.displayScore}</span>
                            <h4>{opportunity.keyword ?? 'Untitled opportunity'}</h4>
                          </div>
                          <span className={`risk-pill risk-${opportunity.cannibalizationRisk}`}>
                            {opportunity.cannibalizationRisk} cannibalization
                          </span>
                        </div>
                        <p className="dashboard-url">{opportunity.url}</p>
                        <p className="dashboard-reason">{opportunity.reason}</p>
                        <div className="dashboard-meta">
                          <span>Rank {opportunity.ranking}</span>
                          <span>Volume {opportunity.searchVolume}</span>
                          <span>{opportunity.inferredIntent} intent</span>
                          <span>{opportunity.inferredPageType} page</span>
                        </div>
                        <div className="review-controls">
                          <label>
                            <span>Queue status</span>
                            <select
                              value={opportunity.reviewStatus}
                              onChange={(event) =>
                                setReviewStatuses((current) => ({
                                  ...current,
                                  [opportunity.id]: event.target.value as ReviewStatus,
                                }))
                              }
                            >
                              <option value="pending">Pending</option>
                              <option value="approved">Approved</option>
                              <option value="rejected">Rejected</option>
                            </select>
                          </label>
                        </div>
                        {bulkScan ? (
                          <div className="dashboard-scan-result">
                            <strong>Live scan: {bulkScan.analysis.score}</strong>
                            <span>{bulkScan.analysis.strategistVerdict}</span>
                          </div>
                        ) : (
                          <div className="dashboard-scan-result pending">
                            <span>No live scan attached yet.</span>
                          </div>
                        )}
                      </article>
                    )
                  })}
                </div>
              </div>

              <div className="panel-subsection">
                <div className="subsection-heading">
                  <h3>Top opportunities</h3>
                  <p>Use scan buttons for deeper review, and manual overrides when your judgment should overrule the model.</p>
                </div>

                {displayedOpportunities.length > 0 ? (
                  <div className="opportunity-table-wrap">
                    <table className="opportunity-table">
                      <thead>
                        <tr>
                          <th>URL</th>
                          <th>Keyword</th>
                          <th>Score</th>
                          <th>Rank</th>
                          <th>Volume</th>
                          <th>Intent</th>
                          <th>Page type</th>
                          <th>Cannibalization</th>
                          <th>Override</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedOpportunities.map((opportunity) => {
                          const override = opportunityOverrides[opportunity.id] ?? 'auto'
                          return (
                            <tr key={opportunity.id}>
                              <td className="url-cell">{opportunity.url}</td>
                              <td>{opportunity.keyword ?? '-'}</td>
                              <td>
                                <strong>{opportunity.displayScore}</strong>
                                <div className="mini-note">{opportunity.reason}</div>
                              </td>
                              <td>{opportunity.ranking}</td>
                              <td>{opportunity.searchVolume}</td>
                              <td>{opportunity.inferredIntent}</td>
                              <td>{opportunity.inferredPageType}</td>
                              <td>
                                <span className={`risk-pill risk-${opportunity.cannibalizationRisk}`}>
                                  {opportunity.cannibalizationRisk} ({opportunity.competingUrlCount})
                                </span>
                              </td>
                              <td>
                                <select
                                  value={override}
                                  onChange={(event) =>
                                    setOpportunityOverrides((current) => ({
                                      ...current,
                                      [opportunity.id]: event.target.value as OverrideChoice,
                                    }))
                                  }
                                >
                                  {overrideOptions.map((option) => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="secondary-button"
                                  disabled={!opportunity.keyword}
                                  onClick={() => void runPageScan(opportunity.url, opportunity.keyword ?? '')}
                                >
                                  Scan row
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <article className="finding-card severity-low">
                    <div className="finding-topline">
                      <span>low priority</span>
                      <h4>No opportunities matched the current settings</h4>
                    </div>
                    <p>Try lowering the minimum search volume or checking whether the ranking and keyword columns were detected correctly.</p>
                  </article>
                )}
              </div>

              <div className="findings-list">
                {report.findings.map((finding) => (
                  <article key={finding.id} className={`finding-card severity-${finding.severity}`}>
                    <div className="finding-topline">
                      <span>{finding.severity} priority</span>
                      <h4>{finding.title}</h4>
                    </div>
                    <p>{finding.detail}</p>
                  </article>
                ))}
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <p>Upload a spreadsheet on the dashboard first to generate your first opportunity list.</p>
            </div>
          )}
        </section>
      )}
    </main>
  )
}function analyzeSheet(fileName: string, rows: RowRecord[], settings: AnalysisSettings, customRules: string): AnalysisReport {
  const findings: Finding[] = []
  const headers = rows.length > 0 ? Object.keys(rows[0]) : []
  const fieldMap = detectFieldMap(headers)
  const detectedColumns = (Object.keys(fieldLabels) as FieldKey[]).map((field) => ({ field: fieldLabels[field], header: fieldMap[field] ?? null }))

  if (rows.length === 0) {
    return {
      sourceLabel: fileName,
      score: 0,
      summary: 'The uploaded sheet did not contain any rows yet.',
      findings: [{ id: 'empty-sheet', severity: 'high', title: 'No rows were found in the uploaded file', detail: 'Use a keyword export or page dataset with a header row and data underneath it.' }],
      metrics: [{ label: 'Rows analyzed', value: '0', hint: 'No spreadsheet rows found' }],
      opportunities: [],
      detectedColumns,
    }
  }

  if (!fieldMap.url || !fieldMap.searchVolume || !fieldMap.ranking) {
    const missingRequired = ['url', 'searchVolume', 'ranking']
      .filter((field) => !fieldMap[field as FieldKey])
      .map((field) => fieldLabels[field as FieldKey])
    findings.push({ id: 'missing-core-columns', severity: 'high', title: 'Core opportunity columns are missing', detail: `The app needs ${missingRequired.join(', ')} to surface opportunities reliably.` })
  }

  if (!fieldMap.keyword) {
    findings.push({ id: 'missing-keyword-column', severity: 'medium', title: 'No keyword column was detected', detail: 'The scoring formula works better when the export includes a keyword or query column.' })
  }

  const baseCandidates = rows
    .map((row) => buildBaseCandidate(row, fieldMap, settings))
    .filter((candidate): candidate is BaseCandidate => candidate !== null)

  const keywordGroups = buildKeywordGroups(baseCandidates)
  const allCandidates = baseCandidates
    .map((candidate) => finalizeOpportunityCandidate(candidate, keywordGroups, settings))
    .sort((left, right) => right.baseOpportunityScore - left.baseOpportunityScore)

  const secondPageCandidates = allCandidates.filter((candidate) => candidate.bucket === 'second-page')
  const belowSecondPageCandidates = allCandidates.filter((candidate) => candidate.bucket === 'below-second-page')
  const candidates = settings.strategy === 'second-page-first'
    ? (secondPageCandidates.length > 0 ? secondPageCandidates : belowSecondPageCandidates).slice(0, 12)
    : allCandidates.slice(0, 12)

  const cannibalizedCandidates = allCandidates.filter((candidate) => candidate.cannibalizationRisk !== 'none')
  const reviewCandidates = allCandidates.filter((candidate) => candidate.relevanceLabel.includes('review') || candidate.relevanceLabel.includes('Low'))

  if (candidates.length === 0) findings.push({ id: 'no-matches', severity: 'medium', title: 'No rows matched the current opportunity rules', detail: 'This usually means rankings, search volume, or relevance conditions filtered everything out.' })
  if (secondPageCandidates.length > 0) findings.push({ id: 'second-page-targets', severity: 'high', title: 'Second-page opportunities were found', detail: `${secondPageCandidates.length} rows are ranking between positions 11 and 20 with enough search volume to target now.` })
  else if (belowSecondPageCandidates.length > 0) findings.push({ id: 'fallback-targets', severity: 'medium', title: 'The tool fell back to below-page-two opportunities', detail: 'No strong second-page rows were found, so the app surfaced lower-ranked opportunities instead.' })
  if (cannibalizedCandidates.length > 0) findings.push({ id: 'cannibalization-risk', severity: 'high', title: 'Possible cannibalization was detected', detail: `${cannibalizedCandidates.length} candidate rows share keywords with competing URLs and may need consolidation or clearer targeting.` })
  if (reviewCandidates.length > 0) findings.push({ id: 'review-needed', severity: 'medium', title: 'Some surfaced rows still need strategist review', detail: `${reviewCandidates.length} surfaced rows have weak or uncertain relevance signals and should be checked manually.` })
  if (fieldMap.relevance) findings.push({ id: 'relevance-column-found', severity: 'low', title: 'A relevance-style column was detected', detail: `The app detected ${fieldMap.relevance} and uses it when your relevance setting allows it.` })
  if (customRules.trim()) findings.push({ id: 'custom-rule-note', severity: 'low', title: 'Custom rule note captured', detail: 'Your notes are saved in the UI and ready for the next coding round.' })

  const averageVolume = candidates.length > 0 ? Math.round(candidates.reduce((sum, candidate) => sum + candidate.searchVolume, 0) / candidates.length) : 0
  const metrics: Metric[] = [
    { label: 'Rows analyzed', value: String(rows.length), hint: 'Rows processed from the first sheet' },
    { label: 'Top matches', value: String(candidates.length), hint: 'Rows surfaced by your current rules' },
    { label: 'Cannibalized rows', value: String(cannibalizedCandidates.length), hint: 'Candidates sharing keywords across URLs' },
    { label: 'Average volume', value: String(averageVolume), hint: 'Across surfaced opportunities' },
  ]

  return {
    sourceLabel: fileName,
    score: calculateOpportunityScore(candidates, settings),
    summary: candidates.length > 0 ? 'Opportunity analysis complete using your current formula.' : 'The file loaded, but no rows matched the current opportunity logic.',
    findings,
    metrics,
    opportunities: candidates,
    detectedColumns,
  }
}

function detectFieldMap(headers: string[]) {
  const normalizedHeaders = headers.map((header) => ({ original: header, normalized: normalizeHeader(header) }))
  return (Object.keys(fieldAliases) as FieldKey[]).reduce<Partial<Record<FieldKey, string>>>((map, field) => {
    const directMatch = normalizedHeaders.find(({ normalized }) => fieldAliases[field].some((alias) => normalized === normalizeHeader(alias)))
    if (directMatch) {
      map[field] = directMatch.original
      return map
    }

    const broadMatch = normalizedHeaders.find(({ normalized }) => fieldAliases[field].some((alias) => normalized.includes(normalizeHeader(alias))))
    if (broadMatch) {
      map[field] = broadMatch.original
    }

    return map
  }, {})
}

function buildBaseCandidate(row: RowRecord, fieldMap: Partial<Record<FieldKey, string>>, settings: AnalysisSettings) {
  const url = asText(row[fieldMap.url ?? ''])
  const keyword = asText(row[fieldMap.keyword ?? ''])
  const searchVolume = parseNumber(row[fieldMap.searchVolume ?? ''])
  const ranking = parseNumber(row[fieldMap.ranking ?? ''])

  if (!url || searchVolume === null || ranking === null) return null
  if (searchVolume < settings.minimumSearchVolume) return null

  const normalizedKeyword = normalizeHeader(keyword)
  const brandTerms = parseTermList(settings.brandTerms)
  const competitorTerms = parseTermList(settings.competitorTerms)
  const hasBrandTerm = brandTerms.some((term) => normalizedKeyword.includes(term))
  const hasCompetitorTerm = competitorTerms.some((term) => normalizedKeyword.includes(term))

  if (settings.excludeBrandTerms && hasBrandTerm) return null

  const relevance = readRelevance(row, fieldMap.relevance, settings.relevanceMode)
  if (settings.relevanceMode === 'require-column-when-present' && fieldMap.relevance && !relevance.isRelevant) return null

  const bucket = getRankingBucket(ranking)
  const shouldInclude = settings.strategy === 'second-page-only'
    ? bucket === 'second-page'
    : settings.strategy === 'below-page-two'
      ? bucket === 'below-second-page'
      : bucket === 'second-page' || bucket === 'below-second-page'

  if (!shouldInclude) return null

  const inferredIntent = inferIntent(keyword)
  const inferredPageType = inferPageTypeFromUrl(url)
  const keywordDifficulty = parseNumber(row[fieldMap.keywordDifficulty ?? ''])
  const traffic = parseNumber(row[fieldMap.traffic ?? ''])
  const heuristicRelevance = keyword ? calculateKeywordHeuristic(keyword, url) : { score: 35, label: 'No keyword provided yet' }
  const competitorPenaltyLabel = hasCompetitorTerm && settings.deprioritizeCompetitors ? 'Competitor keyword - deprioritized' : ''

  return {
    url,
    keyword: keyword || null,
    searchVolume,
    ranking,
    keywordDifficulty,
    traffic,
    bucket,
    inferredIntent,
    inferredPageType,
    relevanceLabel: competitorPenaltyLabel || (fieldMap.relevance ? relevance.label : heuristicRelevance.label),
    strategistRelevance: Math.max(
      0,
      (fieldMap.relevance ? relevance.score : heuristicRelevance.score) -
        (hasCompetitorTerm && settings.deprioritizeCompetitors ? 18 : 0),
    ),
  }
}
function finalizeOpportunityCandidate(candidate: BaseCandidate, keywordGroups: Map<string, Set<string>>, settings: AnalysisSettings): Opportunity {
  const normalizedKeyword = normalizeHeader(candidate.keyword ?? '')
  const competingUrlCount = normalizedKeyword ? (keywordGroups.get(normalizedKeyword)?.size ?? 1) : 1
  const cannibalizationRisk: CannibalizationRisk = competingUrlCount >= 4 ? 'high' : competingUrlCount >= 2 ? 'medium' : 'none'
  const pageTypeAlignment = scorePageTypeAlignment(candidate.inferredIntent, candidate.inferredPageType)

  const baseOpportunityScore = calculateCandidateScore({
    ranking: candidate.ranking,
    searchVolume: candidate.searchVolume,
    keywordDifficulty: candidate.keywordDifficulty,
    traffic: candidate.traffic,
    bucket: candidate.bucket,
    strategistRelevance: candidate.strategistRelevance,
    strategy: settings.strategy,
    pageTypeAlignmentScore: pageTypeAlignment.score,
    cannibalizationRisk,
  })

  return {
    id: `${candidate.url}::${candidate.keyword ?? 'no-keyword'}`,
    url: candidate.url,
    keyword: candidate.keyword,
    searchVolume: candidate.searchVolume,
    ranking: candidate.ranking,
    keywordDifficulty: candidate.keywordDifficulty,
    traffic: candidate.traffic,
    relevanceLabel: candidate.relevanceLabel,
    reason: buildReason({
      ranking: candidate.ranking,
      searchVolume: candidate.searchVolume,
      keywordDifficulty: candidate.keywordDifficulty,
      relevanceLabel: candidate.relevanceLabel,
      keyword: candidate.keyword ?? '',
      inferredIntent: candidate.inferredIntent,
      inferredPageType: candidate.inferredPageType,
      cannibalizationRisk,
    }),
    bucket: candidate.bucket,
    baseOpportunityScore,
    inferredIntent: candidate.inferredIntent,
    inferredPageType: candidate.inferredPageType,
    cannibalizationRisk,
    competingUrlCount,
  }
}

function buildKeywordGroups(candidates: BaseCandidate[]) {
  return candidates.reduce<Map<string, Set<string>>>((map, candidate) => {
    const key = normalizeHeader(candidate.keyword ?? '')
    if (!key) return map
    const current = map.get(key) ?? new Set<string>()
    current.add(normalizeHeader(candidate.url))
    map.set(key, current)
    return map
  }, new Map<string, Set<string>>())
}

function readRelevance(row: RowRecord, header: string | undefined, mode: RelevanceMode) {
  if (!header) return { isRelevant: true, score: 60, label: 'Assumed relevant' }

  const raw = asText(row[header])
  if (!raw) return { isRelevant: mode === 'assume-relevant', score: 20, label: 'Blank relevance' }

  const normalized = raw.toLowerCase()
  const numeric = parseNumber(raw)
  const isRelevant = normalized.includes('relevant') || normalized.includes('high') || normalized === 'yes' || normalized === 'true' || (numeric !== null && numeric >= 7)
  const score = numeric !== null ? Math.min(100, numeric * 10) : isRelevant ? 80 : 25
  return { isRelevant, score, label: isRelevant ? raw : `Low match: ${raw}` }
}

function calculateKeywordHeuristic(keyword: string, url: string) {
  const keywordTerms = normalizeHeader(keyword).split(' ').filter((term) => term.length > 2)
  const urlText = normalizeHeader(url)
  const matches = keywordTerms.filter((term) => urlText.includes(term)).length
  const score = keywordTerms.length === 0 ? 35 : Math.min(80, 20 + matches * 20)

  if (matches === 0) return { score, label: 'Keyword not evident in URL - review' }
  if (matches < keywordTerms.length) return { score, label: 'Partial keyword-to-URL match' }
  return { score, label: 'Strong keyword-to-URL match' }
}

function inferIntent(keyword: string | null): Intent {
  const normalized = normalizeHeader(keyword ?? '')
  if (/(buy|price|pricing|cost|quote|service|services|company|agency|near me|hire|book|best)/.test(normalized)) return 'commercial'
  if (/(how to|guide|tips|examples|what is|why|learn|tutorial)/.test(normalized)) return 'informational'
  if (/(login|sign in|dashboard|account|portal)/.test(normalized)) return 'navigational'
  return 'mixed'
}

function inferPageTypeFromUrl(url: string): PageType {
  const normalized = normalizeHeader(url)
  if (/( blog | news | article | guide | learn | insights | tips )/.test(` ${normalized} `)) return 'blog'
  if (/( services | service | solutions | consulting | agency | company )/.test(` ${normalized} `)) return 'service'
  if (/( category | collections | shop | products | collection )/.test(` ${normalized} `)) return 'category'
  try {
    const parsed = new URL(url)
    if (parsed.pathname === '/' || parsed.pathname === '') return 'homepage'
  } catch {
    return 'general'
  }
  return 'general'
}

function scorePageTypeAlignment(intent: Intent, pageType: PageType) {
  if (intent === 'commercial' && pageType === 'service') return { score: 12, reason: 'Commercial keyword fits a service page well.' }
  if (intent === 'commercial' && pageType === 'category') return { score: 8, reason: 'Commercial keyword fits a category page reasonably well.' }
  if (intent === 'commercial' && pageType === 'blog') return { score: -12, reason: 'Commercial keyword may be weak on a blog page.' }
  if (intent === 'informational' && pageType === 'blog') return { score: 10, reason: 'Informational keyword fits a blog or guide page well.' }
  if (intent === 'informational' && pageType === 'service') return { score: -8, reason: 'Informational keyword may be weak on a service page.' }
  if (intent === 'navigational' && pageType === 'homepage') return { score: 8, reason: 'Navigational keyword fits a homepage-like page.' }
  return { score: 0, reason: 'Neutral intent and page-type alignment.' }
}

function getRankingBucket(ranking: number): OpportunityBucket {
  if (ranking >= 11 && ranking <= 20) return 'second-page'
  if (ranking > 20) return 'below-second-page'
  return 'other'
}

function buildReason(input: {
  ranking: number
  searchVolume: number
  keywordDifficulty: number | null
  relevanceLabel: string
  keyword: string
  inferredIntent: Intent
  inferredPageType: PageType
  cannibalizationRisk: CannibalizationRisk
}) {
  const parts = [`ranking ${input.ranking}`, `volume ${input.searchVolume}`, `${input.inferredIntent} intent`, `${input.inferredPageType} page`, input.relevanceLabel]
  if (input.keyword) parts.push(`keyword: ${input.keyword}`)
  if (input.keywordDifficulty !== null) parts.push(`difficulty ${input.keywordDifficulty}`)
  if (input.cannibalizationRisk !== 'none') parts.push(`${input.cannibalizationRisk} cannibalization risk`)
  return parts.join(', ')
}

function calculateCandidateScore(input: {
  ranking: number
  searchVolume: number
  keywordDifficulty: number | null
  traffic: number | null
  bucket: OpportunityBucket
  strategistRelevance: number
  strategy: RankingStrategy
  pageTypeAlignmentScore: number
  cannibalizationRisk: CannibalizationRisk
}) {
  let score = 0
  if (input.bucket === 'second-page') {
    score += input.strategy === 'below-page-two' ? 35 : 80
    score += 20 - Math.max(input.ranking - 11, 0)
  } else if (input.bucket === 'below-second-page') {
    score += input.strategy === 'below-page-two' ? 75 : 52
    score += Math.max(0, 30 - Math.min(input.ranking, 50))
  } else {
    score += 10
  }

  score += Math.min(input.searchVolume / 10, 30)
  score += input.strategistRelevance * 0.35
  score += input.pageTypeAlignmentScore
  if (input.keywordDifficulty !== null) score += Math.max(0, 25 - input.keywordDifficulty / 2)
  if (input.traffic !== null) score += Math.min(input.traffic / 20, 12)
  if (input.cannibalizationRisk === 'high') score -= 18
  if (input.cannibalizationRisk === 'medium') score -= 8
  return Math.round(Math.max(0, score))
}

function calculateOpportunityScore(candidates: Opportunity[], settings: AnalysisSettings) {
  if (candidates.length === 0) return 0
  const bestCandidate = candidates[0]
  let score = Math.min(100, bestCandidate.baseOpportunityScore)
  if (settings.strategy === 'second-page-first' && bestCandidate.bucket === 'second-page') score = Math.min(100, score + 8)
  return score
}

function applyOverride(score: number, override: OverrideChoice) {
  const adjustment = getOverrideMeta(override).adjustment
  return Math.max(0, Math.min(100, score + adjustment))
}

function getOverrideMeta(override: OverrideChoice) {
  switch (override) {
    case 'priority':
      return { adjustment: 18, verdict: 'Manual override: prioritize this item.', note: 'Use when business context or strategist judgment says this should rise.' }
    case 'likely-relevant':
      return { adjustment: 10, verdict: 'Manual override: likely relevant.', note: 'Use when the model is too cautious but the page is clearly a fit.' }
    case 'needs-review':
      return { adjustment: -8, verdict: 'Manual override: needs review.', note: 'Use when the signals are mixed and you want to slow this down.' }
    case 'not-relevant':
      return { adjustment: -30, verdict: 'Manual override: not relevant.', note: 'Use when this should fall out of the shortlist entirely.' }
    default:
      return { adjustment: 0, verdict: 'Auto review: using the model score.', note: 'No manual override applied.' }
  }
}

function normalizeHeader(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() }
function parseTermList(value: string) { return value.split(',').map((item) => normalizeHeader(item)).filter(Boolean) }
function asText(value: RowRecord[string]) { return String(value ?? '').trim() }
function parseNumber(value: RowRecord[string]) { const text = asText(value); if (!text) return null; const cleaned = text.replace(/,/g, '').replace(/%/g, ''); const parsed = Number(cleaned); return Number.isFinite(parsed) ? parsed : null }

export default App

