import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import './cro-score.css'

type ScoreTone = 'excellent' | 'good' | 'mixed' | 'weak'
type FeatureState = 'found' | 'partial' | 'missing' | 'manual-review' | 'not-applicable'
type ChecklistMode =
  | 'auto'
  | 'service'
  | 'homepage'
  | 'landing'
  | 'demo'
  | 'pricing'
  | 'product'
  | 'blog'
  | 'template'

type CroMetric = {
  label: string
  value: string
  hint?: string
}

type CroQuickWin = {
  id: string
  strategistHeading: string
  whyItMatters?: string
  whatWeSaw?: string
  whatToChange?: string
  exampleImplementation?: string
  impact: 'High' | 'Mid' | 'Low'
  effort: 'High' | 'Mid' | 'Low'
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
  state: FeatureState
  rationale: string
  recommendation: string
  maxPoints: number
  weightedPoints: number
  priorityWeight: number
}

type CategoryScore = {
  category: string
  score: number
  foundCount: number
  missingCount: number
  partialCount: number
}

type FeatureSnapshot = {
  label: string
  state: FeatureState
}

type ClarityInsight = {
  connected: boolean
  matched: boolean
  source: string
  projectLabel: string
  lastDays: number
  message?: string
  frictionScore?: number
  frictionGrade?: string
  confidenceLabel?: string
  sessions?: number
  engagementTime?: number
  scrollDepth?: number
  rageClicks?: number
  deadClicks?: number
  quickbacks?: number
  excessiveScrolls?: number
  scriptErrors?: number
  errorClicks?: number
  findings?: string[]
  opportunities?: string[]
}

type CroPageAnalysis = {
  url: string
  title: string
  pageType: string
  checklistMode: string
  checklistModeLabel: string
  appliedAreas: string[]
  score: number
  baseScore: number
  clarityAdjustment: number
  grade: string
  screenshotDataUrl: string
  visualNote: string
  automationCoverage: {
    automatedItems: number
    manualItems: number
    applicableItems: number
  }
  metrics: CroMetric[]
  categoryScores: CategoryScore[]
  quickWins: CroQuickWin[]
  strengths: string[]
  checklistResults: CroChecklistResult[]
  featureSnapshot: FeatureSnapshot[]
  clarity: ClarityInsight | null
}

type CroComparison = {
  scoreComparison: Array<{
    label: string
    url: string
    score: number
    grade: string
    quickWins: number
  }>
  clarityComparison: Array<{
    label: string
    url: string
    frictionScore: number
    frictionGrade: string
    sessions: number
    rageClicks: number
    deadClicks: number
    quickbacks: number
    scrollDepth: number
  }>
  categoryComparison: Array<{
    category: string
    scores: Array<{ label: string; score: number }>
  }>
  featureComparison: Array<{
    label: string
    primary: FeatureState
    competitors: Array<{ label: string; state: FeatureState }>
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
    stateWeights: Record<string, number>
    impactWeights: Record<string, number>
    gradeBands: Array<{ min: number; grade: string }>
    notes: string[]
  }
  primary: CroPageAnalysis
  competitors: CroPageAnalysis[]
  comparison: CroComparison
  calibration: {
    calibratedScore: number
    calibratedGrade: string
    positionLabel: string
    percentileLabel: string
    notes: string[]
  }
}

type ClarityStatus = {
  connected?: boolean
  projectLabel?: string
  source?: string
  lastValidatedAt?: string
  lastError?: string
  tokenConfigured?: boolean
}

type HeatmapHotspot = {
  page?: string
  target?: string
  clicks?: number
  percent?: number
}

type HeatmapCsvSummary = {
  totalRows: number
  hotspots: HeatmapHotspot[]
}

const CHECKLIST_MODES: Array<{ value: ChecklistMode; label: string }> = [
  { value: 'auto', label: 'Auto detect' },
  { value: 'service', label: 'Service page' },
  { value: 'homepage', label: 'Homepage' },
  { value: 'landing', label: 'Landing page' },
  { value: 'demo', label: 'Demo page' },
  { value: 'pricing', label: 'Pricing page' },
  { value: 'product', label: 'Product page' },
  { value: 'blog', label: 'Blog page' },
  { value: 'template', label: 'Template page' },
]

function getScoreTone(score: number): ScoreTone {
  if (score >= 85) return 'excellent'
  if (score >= 70) return 'good'
  if (score >= 55) return 'mixed'
  return 'weak'
}

function stateLabel(state: FeatureState) {
  if (state === 'manual-review') return 'Manual review'
  if (state === 'not-applicable') return 'Not applicable'
  return state.charAt(0).toUpperCase() + state.slice(1)
}

function escapeCsvValue(value: string) {
  const safe = String(value ?? '')
  if (/[",\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`
  return safe
}

function downloadTextFile(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(text.slice(0, 300) || 'The server did not return valid JSON.')
  }
}

async function parseHeatmapCsv(file: File): Promise<HeatmapCsvSummary> {
  const text = await file.text()
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (rows.length <= 1) {
    return { totalRows: 0, hotspots: [] }
  }

  const headers = rows[0].split(',').map((header) => header.trim().toLowerCase())
  const getValue = (cells: string[], aliases: string[]) => {
    const index = headers.findIndex((header) => aliases.includes(header))
    return index >= 0 ? cells[index] ?? '' : ''
  }

  const hotspots = rows.slice(1).map((row) => {
    const cells = row.split(',').map((cell) => cell.trim())
    return {
      page: getValue(cells, ['page', 'url', 'landing page']),
      target: getValue(cells, ['element', 'target', 'selector', 'click target']),
      clicks: Number(getValue(cells, ['clicks', 'total clicks'])) || 0,
      percent: Number(getValue(cells, ['percent', 'click share', '%'])) || 0,
    }
  })

  return {
    totalRows: hotspots.length,
    hotspots: hotspots
      .sort((left, right) => (right.clicks ?? 0) - (left.clicks ?? 0))
      .slice(0, 6),
  }
}

export function CroScoreOptimization() {
  const [url, setUrl] = useState('https://www.varcoe.co.nz/heat-pump-installation/')
  const [competitorUrls, setCompetitorUrls] = useState('')
  const [checklistMode, setChecklistMode] = useState<ChecklistMode>('auto')
  const [result, setResult] = useState<CroResponse | null>(null)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [stateFilter, setStateFilter] = useState<'all' | FeatureState>('all')

  const [clarityStatus, setClarityStatus] = useState<ClarityStatus | null>(null)
  const [clarityProjectLabel, setClarityProjectLabel] = useState('')
  const [clarityToken, setClarityToken] = useState('')
  const [isSavingClarity, setIsSavingClarity] = useState(false)

  const [heatmapImagePreview, setHeatmapImagePreview] = useState('')
  const [heatmapCsvSummary, setHeatmapCsvSummary] = useState<HeatmapCsvSummary | null>(null)

  useEffect(() => {
    void loadClarityStatus()
  }, [])

  async function loadClarityStatus() {
    try {
      const response = await fetch('/api/clarity/status')
      const payload = await readJson<ClarityStatus>(response)
      setClarityStatus(payload)
      if (payload?.projectLabel) {
        setClarityProjectLabel(payload.projectLabel)
      }
    } catch {
      setClarityStatus(null)
    }
  }

  async function handleClaritySave() {
    setIsSavingClarity(true)
    setError('')
    try {
      const response = await fetch('/api/clarity/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiToken: clarityToken,
          projectLabel: clarityProjectLabel,
        }),
      })
      const payload = await readJson<{ error?: string }>(response)
      if (!response.ok) {
        throw new Error(payload.error || 'Could not save Clarity connection.')
      }
      setClarityToken('')
      await loadClarityStatus()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not save Clarity connection.')
    } finally {
      setIsSavingClarity(false)
    }
  }

  async function handleClarityDisconnect() {
    setIsSavingClarity(true)
    setError('')
    try {
      await fetch('/api/clarity/connect', { method: 'DELETE' })
      setClarityToken('')
      setClarityProjectLabel('')
      await loadClarityStatus()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not disconnect Clarity.')
    } finally {
      setIsSavingClarity(false)
    }
  }

  async function handleHeatmapImageUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const preview = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(new Error('Could not read heatmap image.'))
      reader.readAsDataURL(file)
    })
    setHeatmapImagePreview(preview)
  }

  async function handleHeatmapCsvUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const summary = await parseHeatmapCsv(file)
      setHeatmapCsvSummary(summary)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Could not parse heatmap CSV.')
    }
  }

  async function handleScan() {
    setIsLoading(true)
    setError('')
    try {
      const response = await fetch('/api/cro-score/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          competitorUrls: competitorUrls
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean),
          checklistMode,
        }),
      })
      const payload = await readJson<CroResponse & { error?: string }>(response)
      if (!response.ok) {
        throw new Error(payload.error || 'CRO score scan failed.')
      }
      setResult(payload)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'CRO score scan failed.')
    } finally {
      setIsLoading(false)
    }
  }

  function exportSummary() {
    if (!result) return
    downloadTextFile(
      'cro-summary.json',
      JSON.stringify(result, null, 2),
      'application/json;charset=utf-8',
    )
  }

  function exportChecklistCsv() {
    if (!result) return
    const header = [
      'number',
      'action_item',
      'page_area',
      'impact',
      'effort',
      'state',
      'detector_mode',
      'rationale',
      'recommendation',
    ]
    const lines = result.primary.checklistResults.map((item) => [
      String(item.number),
      escapeCsvValue(item.actionItem),
      escapeCsvValue(item.pageArea),
      item.impact,
      item.effort,
      item.state,
      item.detectorMode,
      escapeCsvValue(item.rationale),
      escapeCsvValue(item.recommendation),
    ].join(','))
    downloadTextFile(
      'cro-checklist-results.csv',
      [header.join(','), ...lines].join('\n'),
      'text/csv;charset=utf-8',
    )
  }

  const filteredChecklistResults = useMemo(() => {
    if (!result) return []
    return result.primary.checklistResults.filter((item) => {
      if (stateFilter === 'all') return item.applicable
      return item.state === stateFilter
    })
  }, [result, stateFilter])

  const tone = result ? getScoreTone(result.primary.score) : 'mixed'

  return (
    <section className="workspace-stack cro-shell">
      <section className="workspace-card workspace-card-tight cro-entry-panel">
        <div className="cro-entry-grid">
          <div className="cro-entry-copy">
            <span className="section-kicker">CRO score & optimization</span>
            <h2>Checklist-based CRO scoring with Clarity support</h2>
            <p className="supporting-copy">
              Scan one page deeply, score it against your CRO checklist, layer in Microsoft Clarity
              behavior data when available, and compare the result against competitor pages.
            </p>
            <div className={`cro-clarity-panel ${clarityStatus?.connected ? '' : 'is-muted'}`}>
              <div className="cro-clarity-heading">
                <div>
                  <span>Microsoft Clarity</span>
                  <strong>{clarityStatus?.connected ? 'Connected' : 'Not connected'}</strong>
                </div>
                {clarityStatus?.connected ? (
                  <button className="secondary-button" onClick={handleClarityDisconnect} disabled={isSavingClarity}>
                    Disconnect
                  </button>
                ) : null}
              </div>
              <p className="supporting-copy">
                {clarityStatus?.connected
                  ? `Using ${clarityStatus.projectLabel || 'your saved Clarity project'} for behavioral friction signals.`
                  : 'Connect a Clarity export token to bring rage clicks, dead clicks, scroll depth, and friction signals into the CRO score.'}
              </p>
              <div className="cro-clarity-grid">
                <label className="stacked-field">
                  <span>Clarity project label</span>
                  <input
                    value={clarityProjectLabel}
                    onChange={(event) => setClarityProjectLabel(event.target.value)}
                    placeholder="Client or project name"
                  />
                </label>
                <label className="stacked-field">
                  <span>Clarity API token</span>
                  <input
                    value={clarityToken}
                    onChange={(event) => setClarityToken(event.target.value)}
                    placeholder={clarityStatus?.connected ? 'Leave blank to keep saved token' : 'Paste Clarity export token'}
                  />
                </label>
              </div>
              <div className="cro-entry-actions">
                <button className="primary-button" onClick={handleClaritySave} disabled={isSavingClarity}>
                  {isSavingClarity ? 'Saving Clarity…' : 'Connect Clarity'}
                </button>
                {clarityStatus?.lastError ? (
                  <span className="inline-note">{clarityStatus.lastError}</span>
                ) : null}
              </div>
            </div>
          </div>

          <div className="cro-entry-form">
            <label className="stacked-field">
              <span>Primary page URL</span>
              <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/page" />
            </label>
            <label className="stacked-field">
              <span>Checklist mode</span>
              <select value={checklistMode} onChange={(event) => setChecklistMode(event.target.value as ChecklistMode)}>
                {CHECKLIST_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="stacked-field">
              <span>Competitor URLs</span>
              <textarea
                value={competitorUrls}
                onChange={(event) => setCompetitorUrls(event.target.value)}
                placeholder={'https://competitor-one.com/page\nhttps://competitor-two.com/page'}
              />
            </label>
            <div className="cro-entry-actions">
              <button className="primary-button" onClick={handleScan} disabled={isLoading}>
                {isLoading ? 'Running CRO score…' : 'Run CRO score'}
              </button>
              <button className="secondary-button" onClick={exportSummary} disabled={!result}>
                Export summary
              </button>
              <button className="secondary-button" onClick={exportChecklistCsv} disabled={!result}>
                Export checklist CSV
              </button>
            </div>
            {error ? <p className="error-banner">{error}</p> : null}
          </div>
        </div>
      </section>

      <section className="workspace-card workspace-card-tight cro-entry-panel">
        <div className="cro-entry-grid">
          <div className="cro-entry-copy">
            <span className="section-kicker">Heatmap evidence</span>
            <h3>Optional Clarity heatmap support</h3>
            <p className="supporting-copy">
              You can upload a Clarity heatmap image or CSV as supporting evidence. This does not
              replace the live page scan, but it helps us visually support CRO findings.
            </p>
          </div>
          <div className="cro-entry-form">
            <div className="cro-clarity-grid">
              <label className="stacked-field">
                <span>Heatmap image</span>
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleHeatmapImageUpload} />
              </label>
              <label className="stacked-field">
                <span>Heatmap CSV</span>
                <input type="file" accept=".csv,text/csv" onChange={handleHeatmapCsvUpload} />
              </label>
            </div>
            {heatmapCsvSummary ? (
              <div className="cro-clarity-panel cro-clarity-summary">
                <div className="cro-clarity-heading">
                  <div>
                    <span>Heatmap CSV summary</span>
                    <strong>{heatmapCsvSummary.totalRows} rows parsed</strong>
                  </div>
                </div>
                <div className="cro-clarity-stats">
                  {heatmapCsvSummary.hotspots.map((hotspot, index) => (
                    <span key={`${hotspot.target}-${index}`}>
                      {(hotspot.target || hotspot.page || 'Hotspot').slice(0, 50)} · {hotspot.clicks ?? 0} clicks
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {result ? (
        <section className="workspace-card cro-dashboard-shell">
          <div className="cro-hero-grid">
            <div className="cro-hero-copy">
              <span className="section-kicker">{result.primary.checklistModeLabel}</span>
              <h2>{result.primary.title || result.primary.url}</h2>
              <p className="supporting-copy">
                {result.primary.visualNote}
              </p>

              <div className="cro-grade-strip">
                <div className={`cro-grade-card cro-grade-${tone}`}>
                  <span>CRO score</span>
                  <strong>{result.primary.score}/100</strong>
                  <small>{result.primary.grade} grade</small>
                </div>
                <div className="cro-grade-card">
                  <span>Checklist score</span>
                  <strong>{result.primary.baseScore}/100</strong>
                  <small>Before Clarity adjustment</small>
                </div>
                <div className="cro-grade-card">
                  <span>Page type</span>
                  <strong>{result.primary.pageType}</strong>
                  <small>{result.primary.appliedAreas.join(', ')}</small>
                </div>
                <div className="cro-grade-card">
                  <span>Clarity effect</span>
                  <strong>{result.primary.clarityAdjustment >= 0 ? `+${result.primary.clarityAdjustment}` : result.primary.clarityAdjustment}</strong>
                  <small>{result.primary.clarity?.matched ? 'Behavioral layer applied' : 'No matched Clarity page data'}</small>
                </div>
              </div>

              <div className="cro-gap-callout">
                <span>{result.calibration.positionLabel}</span>
                <p>{result.calibration.percentileLabel}</p>
              </div>
            </div>

            <div className="cro-hero-visual">
              {result.primary.screenshotDataUrl ? (
                <img
                  className="cro-screenshot"
                  src={result.primary.screenshotDataUrl}
                  alt={`Rendered capture of ${result.primary.url}`}
                />
              ) : null}
              {heatmapImagePreview ? (
                <img
                  className="cro-screenshot"
                  src={heatmapImagePreview}
                  alt="Uploaded Clarity heatmap preview"
                />
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {result ? (
        <section className="workspace-grid workspace-grid-2">
          <section className="workspace-card">
            <div className="section-heading">
              <div>
                <span className="section-kicker">Top quick wins</span>
                <h3>What to change first</h3>
              </div>
            </div>
            <div className="cro-quickwins-grid">
              {result.primary.quickWins.slice(0, 5).map((item) => (
                <article key={item.id} className="cro-quickwin-card">
                  <div className="cro-quickwin-topline">
                    <h4>{item.strategistHeading}</h4>
                    <span className={`metric-pill metric-pill-${item.impact === 'High' ? 'high' : item.impact === 'Mid' ? 'medium' : 'neutral'}`}>
                      {item.impact} impact · {item.effort} effort
                    </span>
                  </div>
                  {item.whyItMatters ? (
                    <div className="cro-quickwin-detail-block">
                      <strong>Why this matters</strong>
                      <p>{item.whyItMatters}</p>
                    </div>
                  ) : null}
                  {item.whatWeSaw ? (
                    <div className="cro-quickwin-detail-block">
                      <strong>What we saw</strong>
                      <p>{item.whatWeSaw}</p>
                    </div>
                  ) : null}
                  {item.whatToChange ? (
                    <div className="cro-quickwin-detail-block">
                      <strong>What to change</strong>
                      <p>{item.whatToChange}</p>
                    </div>
                  ) : null}
                  {item.exampleImplementation ? (
                    <div className="cro-quickwin-detail-block cro-quickwin-example">
                      <strong>Example implementation</strong>
                      <p>{item.exampleImplementation}</p>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </section>

          <section className="workspace-card">
            <div className="section-heading">
              <div>
                <span className="section-kicker">Metrics</span>
                <h3>Score breakdown</h3>
              </div>
            </div>
            <div className="cro-rubric-grid">
              {result.primary.metrics.slice(0, 6).map((metric) => (
                <div key={metric.label} className="cro-grade-card">
                  <span>{metric.label}</span>
                  <strong>{metric.value}</strong>
                  <small>{metric.hint}</small>
                </div>
              ))}
            </div>

            <div className="cro-category-chart">
              {result.primary.categoryScores.map((category) => {
                const categoryTone = getScoreTone(category.score)
                return (
                  <div key={category.category} className="cro-category-row">
                    <div>
                      <strong>{category.category}</strong>
                      <p className="supporting-copy">
                        Found {category.foundCount} · Partial {category.partialCount} · Missing {category.missingCount}
                      </p>
                    </div>
                    <div className="cro-scoreboard-bar">
                      <span
                        className={`cro-scoreboard-fill cro-scoreboard-${categoryTone}`}
                        style={{ width: `${category.score}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="workspace-card">
            <div className="section-heading">
              <div>
                <span className="section-kicker">Behavioral friction</span>
                <h3>Clarity layer</h3>
              </div>
            </div>
            {result.primary.clarity?.matched ? (
              <div className="cro-clarity-panel">
                <div className="cro-clarity-heading">
                  <div>
                    <span>{result.primary.clarity.projectLabel || 'Connected Clarity project'}</span>
                    <strong>
                      Friction {result.primary.clarity.frictionScore}/100 · {result.primary.clarity.frictionGrade}
                    </strong>
                  </div>
                  <span className="metric-pill metric-pill-neutral">
                    Last {result.primary.clarity.lastDays} days
                  </span>
                </div>
                <div className="cro-clarity-stats">
                  <span>{result.primary.clarity.sessions} sessions</span>
                  <span>{result.primary.clarity.rageClicks} rage clicks</span>
                  <span>{result.primary.clarity.deadClicks} dead clicks</span>
                  <span>{result.primary.clarity.quickbacks} quickbacks</span>
                  <span>{result.primary.clarity.scrollDepth}% scroll depth</span>
                </div>
                {(result.primary.clarity.findings ?? []).length > 0 ? (
                  <div className="cro-checklist-stack">
                    {(result.primary.clarity.findings ?? []).map((finding) => (
                      <div key={finding} className="cro-quickwin-detail-block">
                        <strong>Finding</strong>
                        <p>{finding}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
                {(result.primary.clarity.opportunities ?? []).length > 0 ? (
                  <div className="cro-checklist-stack">
                    {(result.primary.clarity.opportunities ?? []).map((item) => (
                      <div key={item} className="cro-quickwin-detail-block cro-quickwin-example">
                        <strong>Opportunity</strong>
                        <p>{item}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="cro-clarity-panel">
                <p className="supporting-copy">
                  {result.primary.clarity?.message || 'No matched Clarity data was found for this page, so the CRO score is based on the checklist and live page scan only.'}
                </p>
              </div>
            )}

            {result.comparison.clarityComparison.length > 0 ? (
              <div className="cro-scoreboard">
                {result.comparison.clarityComparison.map((item) => (
                  <div key={item.url} className="cro-scoreboard-row">
                    <div>
                      <strong>{item.label}</strong>
                      <p>{item.sessions} sessions · {item.rageClicks} rage clicks · {item.deadClicks} dead clicks</p>
                    </div>
                    <div className="cro-scoreboard-bar">
                      <span
                        className={`cro-scoreboard-fill cro-scoreboard-${getScoreTone(100 - item.frictionScore)}`}
                        style={{ width: `${Math.max(0, 100 - item.frictionScore)}%` }}
                      />
                    </div>
                    <div className="cro-scoreboard-stats">
                      <strong>{item.frictionScore}</strong>
                      <small>{item.frictionGrade}</small>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className="workspace-card">
            <div className="section-heading">
              <div>
                <span className="section-kicker">Checklist view</span>
                <h3>Compact checklist results</h3>
              </div>
            </div>
            <div className="cro-filter-tabs">
              {(['all', 'missing', 'partial', 'found', 'manual-review'] as const).map((state) => (
                <button
                  key={state}
                  className={`mini-tab ${stateFilter === state ? 'mini-tab-active' : ''}`}
                  onClick={() => setStateFilter(state)}
                >
                  {state === 'all' ? 'All applicable' : stateLabel(state)}
                </button>
              ))}
            </div>
            <div className="cro-checklist-stack">
              {filteredChecklistResults.slice(0, 18).map((item) => (
                <article key={item.id} className={`cro-checklist-card ${item.state}`}>
                  <div className="cro-checklist-header">
                    <div>
                      <span className="cro-checklist-number">#{item.number} · {item.pageArea}</span>
                      <strong>{item.actionItem}</strong>
                    </div>
                    <span className={`cro-feature-pill cro-feature-${item.state === 'manual-review' ? 'partial' : item.state === 'not-applicable' ? 'missing' : item.state}`}>
                      {stateLabel(item.state)}
                    </span>
                  </div>
                  <p>{item.rationale}</p>
                  <p className="supporting-copy">{item.recommendation}</p>
                </article>
              ))}
            </div>
          </section>
        </section>
      ) : null}
    </section>
  )
}
