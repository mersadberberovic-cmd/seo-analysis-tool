import { useEffect, useMemo, useState } from 'react'
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
type RecentOptimizationMode = 'exclude' | 'deprioritize'

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
  recentlyOptimized: boolean
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

type ToolId = 'onpage' | 'eeat'
type EeatConfidence = 'high' | 'medium' | 'low'

type EeatEvidenceBlock = {
  id: string
  label: string
  screenshotDataUrl: string
  note: string
  matchedText?: string
}

type EeatCategory = {
  id: string
  label: string
  earned: number
  max: number
  confidence: EeatConfidence
  summary: string
  findings: string[]
  gaps: string[]
  recommendation: string
  evidenceIds: string[]
}

type EeatScanResponse = {
  url: string
  title: string
  geminiEnhancement?: {
    provider: 'gemini'
    enabled: boolean
    status: 'disabled' | 'missing_key' | 'rate_limited' | 'error' | 'applied'
    keySource?: 'server' | 'session' | 'none'
    model?: string
    message: string
    summary?: string
    trustVerdict?: 'supports' | 'mixed' | 'weak'
    confidence?: EeatConfidence
    agreementWithRules?: string
    overstatementRisk?: string[]
    blindSpots?: string[]
    refinedQuickWins?: Array<{
      label: string
      reason: string
      action: string
    }>
  }
  visualCapture?: {
    available: boolean
    screenshotDataUrl?: string
    title?: string
    visibleTextPreview?: string
    note: string
    evidenceBlocks: EeatEvidenceBlock[]
  }
  analysis: {
    score: number
    summary: string
    formula: {
      earnedPoints: number
      totalPoints: number
      explanation: string
      categories: Array<{
        id: string
        label: string
        earned: number
        max: number
        confidence: EeatConfidence
      }>
    }
    strengths: string[]
    priorities: string[]
    actionPlan: Array<{
      priority: number
      label: string
      reason: string
      recommendation: string
    }>
    visualSummary: {
      meaningfulImageCount: number
      decorativeImageCount: number
      videoCount: number
      screenshotLikeImages: number
    }
    visualCapture?: {
      available: boolean
      screenshotDataUrl?: string
      title?: string
      visibleTextPreview?: string
      note: string
      evidenceBlocks: EeatEvidenceBlock[]
    }
    evidenceCoverage: string
    evidenceBlocks: EeatEvidenceBlock[]
    categories: EeatCategory[]
    firstWords: string
    title: string
    metaDescription: string
    pageSignals: {
      wordCount: number
      headingCount: number
      contactLinkCount: number
      policyLinkCount: number
      visibleContactDetailCount: number
      outboundLinkCount: number
      authoritativeOutboundLinkCount: number
    }
  }
}

type BulkScanResult = PageScanResponse & {
  opportunityId: string
}

type RowRecord = Record<string, string | number | boolean | null | undefined>
type SignalState = 'found' | 'partial' | 'missing'

type GeminiStatus = {
  availableFromEnv: boolean
  recommendedConnectionMethod: 'api-key'
  message: string
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number, init?: RequestInit) {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const contentType = response.headers.get('content-type') ?? ''
    const rawBody = await response.text()
    const data = contentType.includes('application/json')
      ? JSON.parse(rawBody)
      : { error: 'The EEAT scan backend did not return JSON. Restart the dev server so the new backend route loads.' }

    if (!response.ok) {
      throw new Error(data.error ?? 'Request failed.')
    }

    return data
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('This scan took too long to finish. The page may be slow or blocking the live render step. Try again, or use a different URL.')
    }

    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }
}

type AnalysisSettings = {
  minimumSearchVolume: number
  strategy: RankingStrategy
  relevanceMode: RelevanceMode
  brandTerms: string
  competitorTerms: string
  excludeBrandTerms: boolean
  deprioritizeCompetitors: boolean
  recentOptimizationMode: RecentOptimizationMode
  recentOptimizationWindowDays: number
}

type UsedOpportunityLookup = {
  keys: Set<string>
  datedKeys: Map<string, number>
  hasDateColumn: boolean
}

type FieldKey =
  | 'url'
  | 'keyword'
  | 'searchVolume'
  | 'ranking'
  | 'keywordDifficulty'
  | 'traffic'
  | 'relevance'
  | 'lastOptimized'

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
  recentOptimizationMode: 'exclude',
  recentOptimizationWindowDays: 120,
}

const fieldLabels: Record<FieldKey, string> = {
  url: 'URL',
  keyword: 'Keyword',
  searchVolume: 'Search volume',
  ranking: 'Keyword ranking',
  keywordDifficulty: 'Keyword difficulty',
  traffic: 'Traffic',
  relevance: 'Relevance',
  lastOptimized: 'Last optimized',
}

const fieldAliases: Record<FieldKey, string[]> = {
  url: ['url', 'page url', 'page', 'address', 'landing page', 'landing url', 'target url', 'destination url', 'slug'],
  keyword: ['keyword', 'query', 'search query', 'term', 'target keyword', 'primary keyword'],
  searchVolume: ['search volume', 'volume', 'avg monthly searches', 'average monthly search volume', 'monthly volume', 'keyword volume', 'sv'],
  ranking: ['ranking', 'rank', 'position', 'avg position', 'average position', 'keyword ranking', 'current position', 'serp position'],
  keywordDifficulty: ['keyword difficulty', 'difficulty', 'kd', 'seo difficulty'],
  traffic: ['traffic', 'estimated traffic', 'organic traffic', 'monthly traffic', 'est traffic'],
  relevance: ['relevance', 'relevant', 'page relevance', 'match', 'alignment', 'intent match'],
  lastOptimized: ['last optimized', 'optimized date', 'date optimized', 'last updated', 'completed date', 'published date', 'date'],
}

const overrideOptions: Array<{ value: OverrideChoice; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'priority', label: 'Priority' },
  { value: 'likely-relevant', label: 'Likely Relevant' },
  { value: 'needs-review', label: 'Needs Review' },
  { value: 'not-relevant', label: 'Not Relevant' },
]

function App() {
  const [activeTool, setActiveTool] = useState<ToolId>('onpage')
  const [currentView, setCurrentView] = useState<'dashboard' | 'opportunities'>('dashboard')
  const [settings, setSettings] = useState<AnalysisSettings>(defaultSettings)
  const [uploadedRows, setUploadedRows] = useState<RowRecord[]>([])
  const [fileName, setFileName] = useState('')
  const [isProcessingFile, setIsProcessingFile] = useState(false)
  const [usedOpportunityFileName, setUsedOpportunityFileName] = useState('')
  const [usedOpportunityLookup, setUsedOpportunityLookup] = useState<UsedOpportunityLookup>({
    keys: new Set(),
    datedKeys: new Map(),
    hasDateColumn: false,
  })
  const [isProcessingUsedFile, setIsProcessingUsedFile] = useState(false)
  const [scanUrl, setScanUrl] = useState('')
  const [scanKeyword, setScanKeyword] = useState('')
  const [scanResult, setScanResult] = useState<PageScanResponse | null>(null)
  const [scanError, setScanError] = useState('')
  const [isScanningPage, setIsScanningPage] = useState(false)
  const [eeatUrl, setEeatUrl] = useState('')
  const [eeatBatchInput, setEeatBatchInput] = useState('')
  const [eeatResult, setEeatResult] = useState<EeatScanResponse | null>(null)
  const [eeatBatchResults, setEeatBatchResults] = useState<EeatScanResponse[]>([])
  const [eeatError, setEeatError] = useState('')
  const [eeatBatchError, setEeatBatchError] = useState('')
  const [isScanningEeat, setIsScanningEeat] = useState(false)
  const [isBatchScanningEeat, setIsBatchScanningEeat] = useState(false)
  const [useGeminiEnhancement, setUseGeminiEnhancement] = useState(true)
  const [geminiApiKey, setGeminiApiKey] = useState('')
  const [geminiStatus, setGeminiStatus] = useState<GeminiStatus | null>(null)
  const [isBulkScanning, setIsBulkScanning] = useState(false)
  const [scanOverride, setScanOverride] = useState<OverrideChoice>('auto')
  const [opportunityOverrides, setOpportunityOverrides] = useState<Record<string, OverrideChoice>>({})
  const [reviewStatuses, setReviewStatuses] = useState<Record<string, ReviewStatus>>({})
  const [bulkScanResults, setBulkScanResults] = useState<Record<string, BulkScanResult>>({})
  const report = useMemo(() => {
    if (!fileName || uploadedRows.length === 0) {
      return null
    }

    return analyzeSheet(fileName, uploadedRows, settings, '', usedOpportunityLookup)
  }, [fileName, settings, uploadedRows, usedOpportunityLookup])

  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchJsonWithTimeout('/api/gemini-status', 12000)
        const status = data as GeminiStatus
        setGeminiStatus(status)
        if (!status.availableFromEnv) {
          setUseGeminiEnhancement(false)
        }
      } catch {
        setGeminiStatus({
          availableFromEnv: false,
          recommendedConnectionMethod: 'api-key',
          message: 'Gemini status could not be loaded right now. The base audit still works normally.',
        })
        setUseGeminiEnhancement(false)
      }
    })()
  }, [])

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
      setUploadedRows(rows)
      setCurrentView('dashboard')
    } finally {
      setIsProcessingFile(false)
      event.target.value = ''
    }
  }

  const handleUsedOpportunitiesChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    setIsProcessingUsedFile(true)
    setUsedOpportunityFileName(file.name)

    try {
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer, { type: 'array' })
      const firstSheetName = workbook.SheetNames[0]
      const firstSheet = workbook.Sheets[firstSheetName]
      const rows = XLSX.utils.sheet_to_json<RowRecord>(firstSheet, { defval: '' })
      setUsedOpportunityLookup(buildUsedOpportunityLookup(rows))
    } finally {
      setIsProcessingUsedFile(false)
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

  const runEeatScan = async (targetUrl: string) => {
    if (!targetUrl.trim()) {
      setEeatError('Add a URL for the EEAT scan.')
      setEeatResult(null)
      return
    }

    setIsScanningEeat(true)
    setEeatError('')
    setEeatUrl(targetUrl)

    try {
      const data = await fetchJsonWithTimeout('/api/eeat-scan', 60000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl.trim(),
          useGemini: useGeminiEnhancement,
          geminiApiKey: geminiApiKey.trim(),
        }),
      })
      setEeatResult(data as EeatScanResponse)
    } catch (error) {
      setEeatResult(null)
      setEeatError(error instanceof Error ? error.message : 'EEAT scan failed.')
    } finally {
      setIsScanningEeat(false)
    }
  }

  const runBatchEeatScan = async () => {
    const urls = eeatBatchInput
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)

    if (urls.length === 0) {
      setEeatBatchError('Add one URL per line to run a batch EEAT scan.')
      return
    }

    setIsBatchScanningEeat(true)
    setEeatBatchError('')

      try {
        const results: EeatScanResponse[] = []
        for (const url of urls) {
        const data = await fetchJsonWithTimeout('/api/eeat-scan', 60000, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url,
            useGemini: useGeminiEnhancement,
            geminiApiKey: geminiApiKey.trim(),
          }),
        })
        results.push(data as EeatScanResponse)
      }

      setEeatBatchResults(results)
    } catch (error) {
      setEeatBatchError(error instanceof Error ? error.message : 'Batch EEAT scan failed.')
    } finally {
      setIsBatchScanningEeat(false)
    }
  }

  const exportEeatJson = (results: EeatScanResponse[], fileName: string) => {
    if (results.length === 0) return
    downloadFile(
      fileName,
      'application/json',
      JSON.stringify(results.length === 1 ? results[0] : results, null, 2),
    )
  }

  const exportEeatCsv = (results: EeatScanResponse[], fileName: string) => {
    if (results.length === 0) return

    const rows = results.flatMap((result) =>
      result.analysis.categories.map((category) => ({
        url: result.url,
        pageTitle: result.analysis.title,
        overallScore: result.analysis.score,
        criterion: category.label,
        earned: category.earned,
        max: category.max,
        confidence: category.confidence,
        summary: category.summary,
        findings: category.findings.join(' | '),
        gaps: category.gaps.join(' | '),
        recommendation: category.recommendation,
      })),
    )

    const headers = Object.keys(rows[0] ?? {})
    const csv = [
      headers.join(','),
      ...rows.map((row) =>
        headers
          .map((header) => escapeCsvValue(String(row[header as keyof typeof row] ?? '')))
          .join(','),
      ),
    ].join('\n')

    downloadFile(fileName, 'text/csv;charset=utf-8', csv)
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
  const eeatEvidenceById = useMemo(() => {
    const blocks = eeatResult?.analysis.evidenceBlocks ?? []
    return blocks.reduce<Record<string, EeatEvidenceBlock>>((map, block) => {
      map[block.id] = block
      return map
    }, {})
  }, [eeatResult])
  const eeatSignalSnapshot = useMemo(() => {
    if (!eeatResult) return []

    const labels: Record<string, string> = {
      'author-credibility': 'Author',
      'first-hand-experience': 'Experience',
      'reviewed-by': 'Validation',
      'contact-visibility': 'Contact',
      'policy-legal-visibility': 'Policy',
      'schema-markup': 'Schema',
    }

    return eeatResult.analysis.categories
      .filter((category) => category.id in labels)
      .map((category) => {
        const ratio = category.max > 0 ? category.earned / category.max : 0
        let state: SignalState = 'missing'
        if (ratio >= 0.7) state = 'found'
        else if (ratio > 0) state = 'partial'

        return {
          id: category.id,
          label: labels[category.id],
          state,
          detail: category.summary,
        }
      })
  }, [eeatResult])
  const eeatWeakestCategories = useMemo(() => {
    if (!eeatResult) return []

    return [...eeatResult.analysis.categories]
      .sort((left, right) => (left.earned / left.max) - (right.earned / right.max))
      .slice(0, 4)
  }, [eeatResult])
  const showGeminiFallbackKeyField = useMemo(() => {
    if (!geminiStatus?.availableFromEnv) return true

    const resultStatus = eeatResult?.geminiEnhancement?.status
    return resultStatus === 'rate_limited' || resultStatus === 'missing_key'
  }, [eeatResult, geminiStatus])
  const showGeminiSetupPanel = useMemo(() => {
    if (!geminiStatus?.availableFromEnv) return true
    return showGeminiFallbackKeyField
  }, [geminiStatus, showGeminiFallbackKeyField])
  const geminiFallbackMessage = useMemo(() => {
    const status = eeatResult?.geminiEnhancement?.status
    if (status === 'rate_limited') {
      return 'Built-in Gemini has hit its current quota. Add your own Gemini API key below if you want to keep using AI-enhanced reviews right now.'
    }
    if (status === 'missing_key' && !geminiStatus?.availableFromEnv) {
      return 'Gemini is not connected on this app instance. Add a Gemini API key below if you want to use the AI second opinion.'
    }
    return geminiStatus?.message ?? 'Gemini enhancement is available when configured.'
  }, [eeatResult, geminiStatus])

  return (
    <main className="app-shell app-layout">
      <aside className="tool-sidebar panel">
        <div>
          <p className="eyebrow">SEO Opportunity Finder</p>
          <h2 className="sidebar-title">Tools</h2>
        </div>
        <div className="tool-nav">
          <button
            type="button"
            className={`tool-nav-button ${activeTool === 'onpage' ? 'active' : ''}`}
            onClick={() => setActiveTool('onpage')}
          >
            <span>Onpage Optimization Planning Tool</span>
            <small>Prioritize URLs and optimization opportunities from exports.</small>
          </button>
          <button
            type="button"
            className={`tool-nav-button ${activeTool === 'eeat' ? 'active' : ''}`}
            onClick={() => setActiveTool('eeat')}
          >
            <span>EEAT Tool</span>
            <small>Scan a page for experience, expertise, authority, and trust signals.</small>
          </button>
        </div>
      </aside>

      <div className="tool-content">
          <header className="topbar">
            <div>
              <p className="eyebrow">{activeTool === 'onpage' ? 'Onpage Optimization Planning Tool' : 'EEAT Tool'}</p>
              <h1 className="topbar-title">
                {activeTool === 'onpage'
                ? currentView === 'dashboard'
                  ? 'Main dashboard'
                  : 'Opportunity workspace'
                  : 'Page-level EEAT analysis'}
              </h1>
            </div>
            {activeTool === 'eeat' && geminiStatus?.availableFromEnv ? (
              <div className="topbar-actions">
                <span className="feature-badge">Gemini built in</span>
              </div>
            ) : null}
            {activeTool === 'onpage' && report ? (
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

        {activeTool === 'onpage' ? (
        <>
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
                <label className="upload-card toolbar-upload secondary-upload" htmlFor="used-opportunities-input">
                  <input id="used-opportunities-input" type="file" accept=".csv,.xlsx,.xls,.tsv" onChange={handleUsedOpportunitiesChange} />
                  <strong>{isProcessingUsedFile ? 'Cross-referencing history...' : 'Upload recent optimizations'}</strong>
                  <span>{usedOpportunityFileName ? `Loaded: ${usedOpportunityFileName}` : 'Optional list of already used opportunities'}</span>
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
                              <div className="card-pill-stack">
                                {opportunity.recentlyOptimized ? <span className="risk-pill risk-recent">recently optimized</span> : null}
                                <span className={`risk-pill risk-${opportunity.cannibalizationRisk}`}>
                                  {opportunity.cannibalizationRisk}
                                </span>
                              </div>
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

                  <label className="setting-card">
                    <span>Recent optimization handling</span>
                    <select
                      value={settings.recentOptimizationMode}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          recentOptimizationMode: event.target.value as RecentOptimizationMode,
                        }))
                      }
                    >
                      <option value="exclude">Exclude recent opportunities</option>
                      <option value="deprioritize">Deprioritize recent opportunities</option>
                    </select>
                    <small>Controls how the tool treats pages or keywords already worked on recently.</small>
                  </label>

                  <label className="setting-card">
                    <span>Recent optimization window (days)</span>
                    <input
                      type="number"
                      min="1"
                      value={settings.recentOptimizationWindowDays}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          recentOptimizationWindowDays: Number(event.target.value || 1),
                        }))
                      }
                    />
                    <small>Used when the history file includes a date column.</small>
                  </label>
                </div>
                {usedOpportunityFileName ? (
                  <p className="rail-note">
                    History loaded: {usedOpportunityFileName}
                    {usedOpportunityLookup.hasDateColumn ? `, using a ${settings.recentOptimizationWindowDays}-day window.` : ', no date column detected so all matched rows count as recent.'}
                  </p>
                ) : null}
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
                          <div className="card-pill-stack">
                            {opportunity.recentlyOptimized ? <span className="risk-pill risk-recent">recently optimized</span> : null}
                            <span className={`risk-pill risk-${opportunity.cannibalizationRisk}`}>
                              {opportunity.cannibalizationRisk} cannibalization
                            </span>
                          </div>
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
                                <div className="table-pill-stack">
                                  {opportunity.recentlyOptimized ? <span className="risk-pill risk-recent">recent</span> : null}
                                  <span className={`risk-pill risk-${opportunity.cannibalizationRisk}`}>
                                    {opportunity.cannibalizationRisk} ({opportunity.competingUrlCount})
                                  </span>
                                </div>
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
        </>
      ) : (
        <section className="eeat-shell">
          <section className="panel toolbar-panel">
            <div className="toolbar-row">
              <div>
                <p className="panel-kicker">EEAT Scanner</p>
                <h2>Scan a page for trust and authority signals</h2>
                <p className="panel-copy">
                  This tool audits only the page you enter. It reviews visible content, media, links, markup, and writing signals on that exact URL, then scores each EEAT criterion with evidence, gaps, and recommendations.
                </p>
              </div>
              <div className="toolbar-actions eeat-toolbar-actions">
                <input
                  type="url"
                  placeholder="https://example.com/page-to-review"
                  value={eeatUrl}
                  onChange={(event) => setEeatUrl(event.target.value)}
                />
                <button type="button" onClick={() => void runEeatScan(eeatUrl)}>
                  {isScanningEeat ? 'Scanning page...' : 'Run EEAT scan'}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!eeatResult}
                  onClick={() => eeatResult ? exportEeatJson([eeatResult], 'eeat-audit.json') : undefined}
                >
                  Export JSON
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!eeatResult}
                  onClick={() => eeatResult ? exportEeatCsv([eeatResult], 'eeat-audit.csv') : undefined}
                >
                  Export CSV
                </button>
              </div>
            </div>
            {showGeminiSetupPanel ? (
              <details className="disclosure-panel eeat-batch-panel">
                <summary>{geminiStatus?.availableFromEnv ? 'Gemini fallback access' : 'AI enhancement with Gemini'}</summary>
                <div className="disclosure-body">
                  <div className="settings-grid">
                    <label className="setting-card">
                      <span>Gemini second opinion</span>
                      <select value={useGeminiEnhancement ? 'on' : 'off'} onChange={(event) => setUseGeminiEnhancement(event.target.value === 'on')}>
                        <option value="off">Off</option>
                        <option value="on">On</option>
                      </select>
                      <small>
                        {geminiStatus?.availableFromEnv
                          ? 'Built-in Gemini is already available. This section only matters if you need a personal fallback key.'
                          : 'Your standard audit still works without Gemini.'}
                      </small>
                    </label>

                    {showGeminiFallbackKeyField ? (
                      <label className="setting-card">
                        <span>{geminiStatus?.availableFromEnv ? 'Use your own Gemini API key' : 'Gemini API key'}</span>
                        <input
                          type="password"
                          placeholder={geminiStatus?.availableFromEnv ? 'Only needed if built-in Gemini hits its limit' : 'Paste a Gemini API key for this session'}
                          value={geminiApiKey}
                          onChange={(event) => setGeminiApiKey(event.target.value)}
                        />
                        <small>
                          {geminiStatus?.availableFromEnv
                            ? 'If shared Gemini usage is exhausted, users can continue immediately by adding their own Gemini API key.'
                            : 'This stays in the current app session. In a hosted product, this would only appear if shared Gemini usage is unavailable.'}
                        </small>
                      </label>
                    ) : null}
                  </div>
                  <article className="finding-card severity-low">
                    <div className="finding-topline">
                      <span>status</span>
                      <h4>{geminiStatus?.availableFromEnv ? 'One-click Gemini available' : 'Bring-your-own Gemini key supported'}</h4>
                    </div>
                    <p>{geminiFallbackMessage}</p>
                  </article>
                </div>
              </details>
            ) : null}
            <details className="disclosure-panel eeat-batch-panel">
              <summary>Batch audit and exports</summary>
              <div className="disclosure-body">
                <div className="findings-list">
                  <label className="input-block">
                    <span>URLs, one per line</span>
                    <textarea
                      value={eeatBatchInput}
                      onChange={(event) => setEeatBatchInput(event.target.value)}
                      placeholder={'https://example.com/page-one\nhttps://example.com/page-two'}
                    />
                  </label>
                  <div className="toolbar-actions">
                    <button type="button" onClick={() => void runBatchEeatScan()}>
                      {isBatchScanningEeat ? 'Scanning list...' : 'Run batch scan'}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={eeatBatchResults.length === 0}
                      onClick={() => exportEeatJson(eeatBatchResults, 'eeat-batch-audit.json')}
                    >
                      Export batch JSON
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={eeatBatchResults.length === 0}
                      onClick={() => exportEeatCsv(eeatBatchResults, 'eeat-batch-audit.csv')}
                    >
                      Export batch CSV
                    </button>
                  </div>
                  {eeatBatchError ? <p className="error-text">{eeatBatchError}</p> : null}
                  {eeatBatchResults.length > 0 ? (
                    <div className="opportunity-table-wrap">
                      <table className="opportunity-table">
                        <thead>
                          <tr>
                            <th>URL</th>
                            <th>EEAT score</th>
                            <th>Weakest criterion</th>
                            <th>Top action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {eeatBatchResults.map((result) => {
                            const weakest = [...result.analysis.categories].sort((left, right) => (left.earned / left.max) - (right.earned / right.max))[0]
                            return (
                              <tr key={result.url}>
                                <td className="url-cell">{result.url}</td>
                                <td>{result.analysis.score}</td>
                                <td>{weakest?.label ?? 'n/a'}</td>
                                <td>{result.analysis.actionPlan[0]?.recommendation ?? 'No urgent fixes surfaced.'}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              </div>
            </details>
          </section>

          {eeatError ? <p className="error-text">{eeatError}</p> : null}

          {eeatResult ? (
            <section className="dashboard-shell eeat-dashboard-shell">
              <div className="dashboard-main">
                <article className="panel output-panel preview-panel">
                  <div className="report-hero">
                    <div>
                      <p className="report-source">{eeatResult.url}</p>
                      <h3>{eeatResult.analysis.summary}</h3>
                    </div>
                    <div className="score-badge">
                      <span>EEAT score</span>
                      <strong>{eeatResult.analysis.score}</strong>
                    </div>
                  </div>

                  <div className="queue-summary">
                    <span>Page-only audit</span>
                    <span>{eeatResult.analysis.formula.earnedPoints} of {eeatResult.analysis.formula.totalPoints} points earned</span>
                    <span>{eeatResult.analysis.categories.length} rubric criteria reviewed</span>
                    <span>{eeatResult.analysis.evidenceCoverage}</span>
                  </div>

                  <div className="signal-snapshot-grid">
                    {eeatSignalSnapshot.map((signal) => (
                      <article key={signal.id} className={`signal-card signal-${signal.state}`}>
                        <span>{signal.label}</span>
                        <strong>{signal.state === 'found' ? 'Found' : signal.state === 'partial' ? 'Partial' : 'Missing'}</strong>
                        <small>{signal.detail}</small>
                      </article>
                    ))}
                  </div>

                  {eeatResult.analysis.actionPlan.length > 0 ? (
                    <div className="panel-subsection eeat-action-plan">
                      <div className="subsection-heading">
                        <div>
                          <p className="panel-kicker">Quick Wins</p>
                          <h3>Top 5 EEAT quick wins</h3>
                        </div>
                      </div>
                      <div className="findings-list compact-findings">
                        {eeatResult.analysis.actionPlan.map((action) => (
                          <article key={`${action.priority}-${action.label}`} className="finding-card severity-medium">
                            <div className="finding-topline">
                              <span>priority {action.priority}</span>
                              <h4>{action.label}</h4>
                            </div>
                            <p><strong>Why:</strong> {action.reason}</p>
                            <p><strong>Do next:</strong> {action.recommendation}</p>
                          </article>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {eeatResult.geminiEnhancement?.enabled ? (
                    <div className="panel-subsection eeat-action-plan">
                      <div className="subsection-heading">
                        <div>
                          <p className="panel-kicker">AI Review</p>
                          <h3>Gemini second opinion</h3>
                        </div>
                      </div>
                      <article className={`finding-card ${eeatResult.geminiEnhancement.status === 'applied' ? 'severity-low' : 'severity-medium'}`}>
                        <div className="finding-topline">
                          <span>{eeatResult.geminiEnhancement.model ?? 'gemini'}</span>
                          <h4>{eeatResult.geminiEnhancement.status === 'applied' ? 'Applied' : 'Not applied'}</h4>
                        </div>
                        <p>{eeatResult.geminiEnhancement.message}</p>
                        {eeatResult.geminiEnhancement.summary ? <p><strong>Summary:</strong> {eeatResult.geminiEnhancement.summary}</p> : null}
                        {eeatResult.geminiEnhancement.agreementWithRules ? <p><strong>Agreement:</strong> {eeatResult.geminiEnhancement.agreementWithRules}</p> : null}
                        {eeatResult.geminiEnhancement.trustVerdict ? (
                          <p>
                            <strong>Verdict:</strong> {eeatResult.geminiEnhancement.trustVerdict}
                            {eeatResult.geminiEnhancement.confidence ? ` (${eeatResult.geminiEnhancement.confidence} confidence)` : ''}
                          </p>
                        ) : null}
                      </article>

                      {eeatResult.geminiEnhancement.status === 'applied' ? (
                        <div className="findings-list compact-findings">
                          {(eeatResult.geminiEnhancement.refinedQuickWins ?? []).map((item) => (
                            <article key={`gemini-${item.label}`} className="finding-card severity-low">
                              <div className="finding-topline">
                                <span>ai quick win</span>
                                <h4>{item.label}</h4>
                              </div>
                              <p><strong>Why:</strong> {item.reason}</p>
                              <p><strong>Do next:</strong> {item.action}</p>
                            </article>
                          ))}
                          {(eeatResult.geminiEnhancement.overstatementRisk ?? []).map((item) => (
                            <article key={`over-${item}`} className="finding-card severity-medium">
                              <div className="finding-topline">
                                <span>overstatement risk</span>
                                <h4>{item}</h4>
                              </div>
                            </article>
                          ))}
                          {(eeatResult.geminiEnhancement.blindSpots ?? []).map((item) => (
                            <article key={`blind-${item}`} className="finding-card severity-low">
                              <div className="finding-topline">
                                <span>blind spot</span>
                                <h4>{item}</h4>
                              </div>
                            </article>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="metric-grid eeat-hero-metrics">
                    <article className="metric-card">
                      <span>Meaningful images</span>
                      <strong>{eeatResult.analysis.visualSummary.meaningfulImageCount}</strong>
                      <small>Non-decorative images detected on the page</small>
                    </article>
                    <article className="metric-card">
                      <span>Videos</span>
                      <strong>{eeatResult.analysis.visualSummary.videoCount}</strong>
                      <small>Video or embedded media blocks found</small>
                    </article>
                    <article className="metric-card">
                      <span>Screenshot-like visuals</span>
                      <strong>{eeatResult.analysis.visualSummary.screenshotLikeImages}</strong>
                      <small>Images that look like examples, screenshots, or proof</small>
                    </article>
                    <article className="metric-card">
                      <span>Decorative images</span>
                      <strong>{eeatResult.analysis.visualSummary.decorativeImageCount}</strong>
                      <small>Likely logos, icons, or decorative assets</small>
                    </article>
                  </div>
                </article>

                <article className="panel preview-panel">
                  <div className="subsection-heading">
                    <div>
                      <p className="panel-kicker">Evidence</p>
                      <h3>Visual proof and rendered page review</h3>
                    </div>
                  </div>
                  {eeatResult.analysis.visualCapture?.available && eeatResult.analysis.visualCapture.screenshotDataUrl ? (
                    <div className="eeat-visual-wrap">
                      <img className="eeat-visual" src={eeatResult.analysis.visualCapture.screenshotDataUrl} alt="Rendered page screenshot for EEAT review" />
                      <p className="mini-note">{eeatResult.analysis.visualCapture.note}</p>
                      {eeatResult.analysis.evidenceBlocks.length > 0 ? (
                        <div className="eeat-evidence-grid">
                          {eeatResult.analysis.evidenceBlocks.map((block) => (
                            <article key={block.id} className="finding-card severity-low evidence-card">
                              <div className="finding-topline">
                                <span>evidence</span>
                                <h4>{block.label}</h4>
                              </div>
                              <img className="eeat-evidence-image" src={block.screenshotDataUrl} alt={block.label} />
                              <p>{block.note}</p>
                              {block.matchedText ? <p className="mini-note">Matched text: {block.matchedText}</p> : null}
                            </article>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <article className="finding-card severity-medium">
                      <div className="finding-topline">
                        <span>visual</span>
                        <h4>No screenshot was captured</h4>
                      </div>
                      <p>{eeatResult.analysis.visualCapture?.note ?? 'Visual capture was not available for this scan.'}</p>
                    </article>
                  )}
                </article>

                <article className="panel preview-panel">
                  <div className="subsection-heading">
                    <div>
                      <p className="panel-kicker">Opening copy</p>
                      <h3>First-screen content preview</h3>
                    </div>
                  </div>
                  <div className="panel-subsection">
                    <p className="mini-note">{eeatResult.analysis.firstWords || 'No opening copy preview could be extracted.'}</p>
                  </div>
                </article>
              </div>

              <aside className="dashboard-rail">
                <section className="panel rail-panel">
                  <div className="subsection-heading">
                    <div>
                      <p className="panel-kicker">Page summary</p>
                      <h3>Key page details</h3>
                    </div>
                  </div>
                  <div className="settings-grid">
                    <article className="setting-card">
                      <span>Title tag</span>
                      <small>{eeatResult.analysis.title || 'No title detected'}</small>
                    </article>
                    <article className="setting-card">
                      <span>Meta description</span>
                      <small>{eeatResult.analysis.metaDescription || 'No meta description detected'}</small>
                    </article>
                    <article className="setting-card">
                      <span>Word count</span>
                      <small>{eeatResult.analysis.pageSignals.wordCount} visible words on the scanned page</small>
                    </article>
                    <article className="setting-card">
                      <span>Heading count</span>
                      <small>{eeatResult.analysis.pageSignals.headingCount} headings detected on the page</small>
                    </article>
                    <article className="setting-card">
                      <span>Authority links</span>
                      <small>{eeatResult.analysis.pageSignals.authoritativeOutboundLinkCount} authoritative outbound link(s) visible on the page</small>
                    </article>
                    <article className="setting-card">
                      <span>Contact links on page</span>
                      <small>{eeatResult.analysis.pageSignals.contactLinkCount} unique About, Contact, Team, or location link(s) visible on the page</small>
                    </article>
                    <article className="setting-card">
                      <span>Visible contact details</span>
                      <small>{eeatResult.analysis.pageSignals.visibleContactDetailCount} visible phone, email, or address detail(s) detected in the page copy</small>
                    </article>
                    <article className="setting-card">
                      <span>Policy links on page</span>
                      <small>{eeatResult.analysis.pageSignals.policyLinkCount} unique Privacy, Terms, warranty, or policy link(s) visible on the page</small>
                    </article>
                  </div>
                </section>

                <section className="panel rail-panel">
                  <div className="subsection-heading">
                    <div>
                      <p className="panel-kicker">Formula</p>
                      <h3>How the score is calculated</h3>
                    </div>
                  </div>
                  <div className="findings-list">
                    <article className="finding-card severity-low">
                      <div className="finding-topline">
                        <span>formula</span>
                        <h4>{eeatResult.analysis.formula.earnedPoints} / {eeatResult.analysis.formula.totalPoints} points</h4>
                      </div>
                      <p>{eeatResult.analysis.formula.explanation}</p>
                    </article>
                    {eeatWeakestCategories.map((category) => (
                      <article key={category.id} className="finding-card severity-low">
                        <div className="finding-topline">
                          <span>watchlist</span>
                          <h4>{category.label}</h4>
                        </div>
                        <p>{category.earned} / {category.max} points</p>
                        <span className={`confidence-pill confidence-${category.confidence}`}>{category.confidence} confidence</span>
                      </article>
                    ))}
                  </div>
                </section>
              </aside>
            </section>
          ) : (
            <section className="panel empty-state center-empty">
              <p>Enter a page URL to review EEAT signals on that page.</p>
            </section>
          )}

          {eeatResult ? (
            <section className="panel output-panel workspace-panel">
              <details className="disclosure-panel">
                <summary>Open full rubric and evidence breakdown</summary>
                <div className="disclosure-body">
                  <div className="panel-heading">
                    <div>
                      <p className="panel-kicker">EEAT categories</p>
                      <h2>Signal-by-signal breakdown</h2>
                    </div>
                    <p className="panel-copy">Open this when you want the full evidence-by-evidence rubric, beyond the top 5 quick wins.</p>
                  </div>

                  <div className="dashboard-list eeat-category-grid">
                    {eeatResult.analysis.categories.map((category) => (
                      <article key={category.id} className="dashboard-card eeat-card">
                        <div className="dashboard-header">
                          <div>
                            <span className="dashboard-score">{category.earned}/{category.max}</span>
                            <h4>{category.label}</h4>
                          </div>
                          <span className={`confidence-pill confidence-${category.confidence}`}>{category.confidence} confidence</span>
                        </div>
                        <p className="dashboard-reason">{category.summary}</p>
                        {category.evidenceIds.length > 0 ? (
                          <div className="eeat-inline-evidence">
                            {category.evidenceIds.map((evidenceId) => {
                              const block = eeatEvidenceById[evidenceId]
                              if (!block) return null

                              return (
                                <article key={`${category.id}-${evidenceId}`} className="finding-card severity-low evidence-card">
                                  <div className="finding-topline">
                                    <span>visual proof</span>
                                    <h4>{block.label}</h4>
                                  </div>
                                  <img className="eeat-evidence-image" src={block.screenshotDataUrl} alt={block.label} />
                                  <p>{block.note}</p>
                                  {block.matchedText ? <p className="mini-note">Matched text: {block.matchedText}</p> : null}
                                </article>
                              )
                            })}
                          </div>
                        ) : null}
                        <div className="findings-list compact-findings">
                          {category.findings.map((item) => (
                            <article key={`${category.id}-${item}`} className="finding-card severity-low">
                              <div className="finding-topline">
                                <span>found</span>
                                <h4>{item}</h4>
                              </div>
                            </article>
                          ))}
                          {category.gaps.map((item) => (
                            <article key={`${category.id}-gap-${item}`} className="finding-card severity-medium">
                              <div className="finding-topline">
                                <span>gap</span>
                                <h4>{item}</h4>
                              </div>
                            </article>
                          ))}
                          <article className="finding-card severity-low">
                            <div className="finding-topline">
                              <span>recommendation</span>
                              <h4>{category.recommendation}</h4>
                            </div>
                          </article>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              </details>
            </section>
          ) : null}
        </section>
      )}
      </div>
    </main>
  )
}

function analyzeSheet(
  fileName: string,
  rows: RowRecord[],
  settings: AnalysisSettings,
  customRules: string,
  usedOpportunityLookup: UsedOpportunityLookup,
): AnalysisReport {
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

  const lowValueRows = rows.filter((row) => isLowValueOpportunityUrl(asText(row[fieldMap.url ?? ''])))
  if (lowValueRows.length > 0) {
    findings.push({
      id: 'low-value-urls-filtered',
      severity: 'medium',
      title: 'Low-value SEO target URLs were filtered out',
      detail: `${lowValueRows.length} rows looked like pagination, archive, search, or faceted/filter URLs, so they were excluded from recommendations.`,
    })
  }

  const baseCandidates = rows
    .map((row) => buildBaseCandidate(row, fieldMap, settings))
    .filter((candidate): candidate is BaseCandidate => candidate !== null)

  const keywordGroups = buildKeywordGroups(baseCandidates)
  const allCandidates = baseCandidates
    .map((candidate) => finalizeOpportunityCandidate(candidate, keywordGroups, settings, usedOpportunityLookup))
    .sort((left, right) => right.baseOpportunityScore - left.baseOpportunityScore)
  const recentlyOptimizedCandidates = allCandidates.filter((candidate) => candidate.recentlyOptimized)
  const eligibleCandidates = settings.recentOptimizationMode === 'exclude'
    ? allCandidates.filter((candidate) => !candidate.recentlyOptimized)
    : allCandidates

  const secondPageCandidates = eligibleCandidates.filter((candidate) => candidate.bucket === 'second-page')
  const belowSecondPageCandidates = eligibleCandidates.filter((candidate) => candidate.bucket === 'below-second-page')
  const candidates = settings.strategy === 'second-page-first'
    ? (secondPageCandidates.length > 0 ? secondPageCandidates : belowSecondPageCandidates).slice(0, 12)
    : eligibleCandidates.slice(0, 12)

  const cannibalizedCandidates = eligibleCandidates.filter((candidate) => candidate.cannibalizationRisk !== 'none')
  const reviewCandidates = eligibleCandidates.filter((candidate) => candidate.relevanceLabel.includes('review') || candidate.relevanceLabel.includes('Low'))

  if (candidates.length === 0) findings.push({ id: 'no-matches', severity: 'medium', title: 'No rows matched the current opportunity rules', detail: 'This usually means rankings, search volume, or relevance conditions filtered everything out.' })
  if (secondPageCandidates.length > 0) findings.push({ id: 'second-page-targets', severity: 'high', title: 'Second-page opportunities were found', detail: `${secondPageCandidates.length} rows are ranking between positions 11 and 20 with enough search volume to target now.` })
  else if (belowSecondPageCandidates.length > 0) findings.push({ id: 'fallback-targets', severity: 'medium', title: 'The tool fell back to below-page-two opportunities', detail: 'No strong second-page rows were found, so the app surfaced lower-ranked opportunities instead.' })
  if (cannibalizedCandidates.length > 0) findings.push({ id: 'cannibalization-risk', severity: 'high', title: 'Possible cannibalization was detected', detail: `${cannibalizedCandidates.length} candidate rows share keywords with competing URLs and may need consolidation or clearer targeting.` })
  if (reviewCandidates.length > 0) findings.push({ id: 'review-needed', severity: 'medium', title: 'Some surfaced rows still need strategist review', detail: `${reviewCandidates.length} surfaced rows have weak or uncertain relevance signals and should be checked manually.` })
  if (recentlyOptimizedCandidates.length > 0) findings.push({
    id: 'recently-optimized-filter',
    severity: 'medium',
    title: settings.recentOptimizationMode === 'exclude' ? 'Recently optimized opportunities were filtered out' : 'Recently optimized opportunities were deprioritized',
    detail: usedOpportunityLookup.hasDateColumn
      ? `${recentlyOptimizedCandidates.length} rows matched your optimization history within the last ${settings.recentOptimizationWindowDays} days.`
      : `${recentlyOptimizedCandidates.length} rows matched your previously used opportunities list${settings.recentOptimizationMode === 'exclude' ? ' and were excluded' : ' and were deprioritized'}.`,
  })
  if (usedOpportunityLookup.keys.size > 0 && !usedOpportunityLookup.hasDateColumn) findings.push({ id: 'used-opportunities-no-date', severity: 'low', title: 'Optimization history loaded without a date column', detail: 'The tool can still cross-reference by URL and keyword, but the time window only works when the history file includes a date-style column.' })
  if (fieldMap.relevance) findings.push({ id: 'relevance-column-found', severity: 'low', title: 'A relevance-style column was detected', detail: `The app detected ${fieldMap.relevance} and uses it when your relevance setting allows it.` })
  if (customRules.trim()) findings.push({ id: 'custom-rule-note', severity: 'low', title: 'Custom rule note captured', detail: 'Your notes are saved in the UI and ready for the next coding round.' })

  const averageVolume = candidates.length > 0 ? Math.round(candidates.reduce((sum, candidate) => sum + candidate.searchVolume, 0) / candidates.length) : 0
  const metrics: Metric[] = [
    { label: 'Rows analyzed', value: String(rows.length), hint: 'Rows processed from the first sheet' },
    { label: 'Top matches', value: String(candidates.length), hint: 'Rows surfaced by your current rules' },
    { label: 'Low-value URLs', value: String(lowValueRows.length), hint: 'Pagination, archive, search, or filter URLs excluded' },
    { label: 'Used matches', value: String(recentlyOptimizedCandidates.length), hint: settings.recentOptimizationMode === 'exclude' ? 'Rows excluded because they were recently optimized' : 'Rows deprioritized because they were recently optimized' },
    { label: 'Cannibalized rows', value: String(cannibalizedCandidates.length), hint: 'Candidates sharing keywords across URLs' },
    { label: 'Average volume', value: String(averageVolume), hint: 'Across surfaced recommendations' },
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
  if (isLowValueOpportunityUrl(url)) return null
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
function finalizeOpportunityCandidate(
  candidate: BaseCandidate,
  keywordGroups: Map<string, Set<string>>,
  settings: AnalysisSettings,
  usedOpportunityLookup: UsedOpportunityLookup,
): Opportunity {
  const normalizedKeyword = normalizeHeader(candidate.keyword ?? '')
  const competingUrlCount = normalizedKeyword ? (keywordGroups.get(normalizedKeyword)?.size ?? 1) : 1
  const cannibalizationRisk: CannibalizationRisk = competingUrlCount >= 4 ? 'high' : competingUrlCount >= 2 ? 'medium' : 'none'
  const pageTypeAlignment = scorePageTypeAlignment(candidate.inferredIntent, candidate.inferredPageType)
  const recentlyOptimized = isRecentlyOptimized(candidate.url, candidate.keyword, usedOpportunityLookup, settings.recentOptimizationWindowDays)

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
    recentlyOptimized,
    recentOptimizationMode: settings.recentOptimizationMode,
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
    recentlyOptimized,
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

function isLowValueOpportunityUrl(url: string) {
  if (!url.trim()) return false

  try {
    const parsed = new URL(url)
    const path = parsed.pathname.toLowerCase()
    const normalizedUrl = `${parsed.hostname}${parsed.pathname}${parsed.search}`.toLowerCase()
    const pageParam = parsed.searchParams.get('page')
    const pagedParam = parsed.searchParams.get('paged')
    const startsAtParam = parsed.searchParams.get('start')
    const hasSearchPath = /\/(search|results)\//.test(path) || path === '/search'
    const hasArchivePath = /\/(tag|author|archive|category|product-category)\//.test(path)
    const hasSortOrFilterParam = Array.from(parsed.searchParams.keys()).some((key) =>
      /^(filter_|orderby|order|sort|min_price|max_price|price|brand|color|size|view|query_type_|stock_status|product_cat|rating_filter|filter|facet)/.test(key.toLowerCase()),
    )

    if (/\/page\/\d+\/?$/.test(path)) return true
    if (hasArchivePath && /\/page\/\d+\/?$/.test(path)) return true
    if ((pageParam && Number(pageParam) > 1) || (pagedParam && Number(pagedParam) > 1)) return true
    if (startsAtParam && Number(startsAtParam) > 0) return true
    if (hasSearchPath || parsed.searchParams.has('s') || parsed.searchParams.has('search')) return true
    if (hasSortOrFilterParam) return true
    if (hasArchivePath && !/\/(product|service|services|blog|guide|collection)\//.test(path) && !/\/page\/?$/.test(path)) {
      return normalizedUrl.includes('?') || /\/tag\/|\/author\/|\/archive\//.test(path)
    }
    return false
  } catch {
    const normalized = url.toLowerCase()
    return (
      /\/page\/\d+\/?$/.test(normalized) ||
      /[?&](page|paged)=\d+/.test(normalized) ||
      /\/(tag|author|archive|search|results)\//.test(normalized) ||
      /[?&](s|search|orderby|order|sort|min_price|max_price|brand|color|size|filter)=/.test(normalized)
    )
  }
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
  recentlyOptimized: boolean
  recentOptimizationMode: RecentOptimizationMode
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
  if (input.recentlyOptimized && input.recentOptimizationMode === 'deprioritize') score -= 28
  return Math.round(Math.max(0, score))
}

function calculateOpportunityScore(candidates: Opportunity[], settings: AnalysisSettings) {
  if (candidates.length === 0) return 0
  const bestCandidate = candidates[0]
  let score = Math.min(100, bestCandidate.baseOpportunityScore)
  if (settings.strategy === 'second-page-first' && bestCandidate.bucket === 'second-page') score = Math.min(100, score + 8)
  return score
}

function buildUsedOpportunityLookup(rows: RowRecord[]): UsedOpportunityLookup {
  if (rows.length === 0) {
    return {
      keys: new Set<string>(),
      datedKeys: new Map<string, number>(),
      hasDateColumn: false,
    }
  }

  const headers = Object.keys(rows[0])
  const fieldMap = detectFieldMap(headers)
  const hasDateColumn = Boolean(fieldMap.lastOptimized)
  const keys = new Set<string>()
  const datedKeys = new Map<string, number>()

  rows.forEach((row) => {
    const url = normalizeComparableUrl(asText(row[fieldMap.url ?? '']))
    const keyword = normalizeHeader(asText(row[fieldMap.keyword ?? '']))
    const optimizedAt = parseDateValue(row[fieldMap.lastOptimized ?? ''])

    if (url) {
      keys.add(`url:${url}`)
      if (optimizedAt !== null) datedKeys.set(`url:${url}`, optimizedAt)
    }

    if (url && keyword) {
      const key = `url-keyword:${url}::${keyword}`
      keys.add(key)
      if (optimizedAt !== null) datedKeys.set(key, optimizedAt)
    }
  })

  return { keys, datedKeys, hasDateColumn }
}

function isRecentlyOptimized(
  url: string,
  keyword: string | null,
  usedOpportunityLookup: UsedOpportunityLookup,
  recentOptimizationWindowDays: number,
) {
  if (usedOpportunityLookup.keys.size === 0) return false

  const normalizedUrl = normalizeComparableUrl(url)
  const normalizedKeyword = normalizeHeader(keyword ?? '')
  const now = Date.now()
  const maxAgeMs = Math.max(1, recentOptimizationWindowDays) * 24 * 60 * 60 * 1000
  const matchesWindow = (key: string) => {
    const optimizedAt = usedOpportunityLookup.datedKeys.get(key)
    if (optimizedAt === undefined) return !usedOpportunityLookup.hasDateColumn
    return now - optimizedAt <= maxAgeMs
  }

  if (
    normalizedUrl &&
    normalizedKeyword &&
    usedOpportunityLookup.keys.has(`url-keyword:${normalizedUrl}::${normalizedKeyword}`) &&
    matchesWindow(`url-keyword:${normalizedUrl}::${normalizedKeyword}`)
  ) {
    return true
  }

  if (normalizedUrl && usedOpportunityLookup.keys.has(`url:${normalizedUrl}`) && matchesWindow(`url:${normalizedUrl}`)) {
    return true
  }

  return false
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

function downloadFile(fileName: string, mimeType: string, contents: string) {
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

function normalizeHeader(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() }
function normalizeComparableUrl(value: string) {
  const text = value.trim()
  if (!text) return ''
  try {
    const parsed = new URL(text)
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase()
  } catch {
    return text.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')
  }
}
function parseDateValue(value: RowRecord[string]) {
  const text = asText(value)
  if (!text) return null
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}
function parseTermList(value: string) { return value.split(',').map((item) => normalizeHeader(item)).filter(Boolean) }
function asText(value: RowRecord[string]) { return String(value ?? '').trim() }
function parseNumber(value: RowRecord[string]) { const text = asText(value); if (!text) return null; const cleaned = text.replace(/,/g, '').replace(/%/g, ''); const parsed = Number(cleaned); return Number.isFinite(parsed) ? parsed : null }

export default App

