import fs from 'node:fs'
import * as cheerio from 'cheerio'
import * as XLSX from 'xlsx'
import { chromium } from 'playwright-core'
import { getClarityPageInsights } from './clarity-service.mjs'

const CHECKLIST_URL = new URL('../reference-cro-checklist.csv', import.meta.url)

const IMPACT_WEIGHTS = {
  High: 10,
  Mid: 6,
  Low: 3,
}

const GRADE_BANDS = [
  { min: 85, grade: 'A' },
  { min: 72, grade: 'B' },
  { min: 58, grade: 'C' },
  { min: 42, grade: 'D' },
  { min: 0, grade: 'E' },
]

const WELL_KNOWN_BRANDS = [
  'salesforce',
  'hubspot',
  'slack',
  'notion',
  'monday',
  'clickup',
  'atlassian',
  'intercom',
  'dropbox',
  'g2',
  'capterra',
  'zapier',
  'shopify',
  'pandadoc',
  'gong',
  'okta',
  'brex',
  'linear',
  'webflow',
  'klaviyo',
  'zendesk',
  'semrush',
  'ahrefs',
]

const JARGON_TERMS = [
  'synergy',
  'best-in-class',
  'revolutionary',
  'disruptive',
  'omnichannel',
  'hyperautomation',
  'enablement',
  'solutioning',
  'frictionless',
  'next-gen',
  'leverage',
  'robust',
  'seamless',
  'innovative',
]

const CTA_STRONG_TERMS = /(start|book|request|get|try|watch|contact|talk|schedule|see|download|compare|explore|claim)/i
const CTA_PRIMARY_TERMS = /(book a demo|start free|start for free|start trial|start free trial|request demo|get demo|get started|contact sales|talk to sales)/i
const CTA_SECONDARY_TERMS = /(watch|tour|learn more|see how|view demo|read case study|compare plans|explore)/i
const TRUST_TERMS = /(trusted by|used by|customers|logos|rated|stars?|reviews?|case studies?|customer stories?)/i
const PAIN_TERMS = /(pain|slow|manual|wasted|frustrat|problem|challenge|inefficient|messy|stuck|hard to|without)/i
const SOLUTION_TERMS = /(solution|platform|product|software|tool|automate|streamline|centralize|improve|help you)/i

let checklistCache = null

export async function scanCroExperience({ url, competitorUrls = [], benchmarkUrls = [], checklistMode = 'auto' }) {
  const checklist = loadCroChecklist()
  const dedupedCompetitors = [...new Set((competitorUrls ?? []).map((item) => String(item).trim()).filter(Boolean))]
  void benchmarkUrls

  const primary = await analyzeCroPage({
    url,
    checklist,
    includeScreenshot: true,
    checklistMode,
  })

  const competitors = []
  for (const competitorUrl of dedupedCompetitors.slice(0, 5)) {
    competitors.push(await analyzeCroPage({
      url: competitorUrl,
      checklist,
      includeScreenshot: false,
      checklistMode,
    }))
  }

  return {
    checklistSummary: buildChecklistSummary(checklist),
    scoringModel: {
      stateWeights: {
        found: 1,
        partial: 0.55,
        missing: 0,
      },
      impactWeights: IMPACT_WEIGHTS,
      gradeBands: GRADE_BANDS,
      notes: [
        'Only Site Wide plus the detected page-type checklist sections are scored.',
        'Manual-review checks stay visible but do not inflate the numeric score.',
        'High-impact, low-effort missing items are prioritized as quick wins.',
      ],
    },
    primary,
    competitors,
    comparison: buildCroComparison(primary, competitors),
    calibration: buildCroCalibration(primary),
  }
}

function buildCroCalibration(primary) {
  const automatedItems = primary.checklistResults.filter(
    (item) => item.applicable && item.detectorMode === 'automated',
  )
  const highImpactItems = automatedItems.filter((item) => item.impact === 'High')
  const foundHighImpactItems = highImpactItems.filter((item) => item.state === 'found')
  const lowEffortGaps = automatedItems.filter(
    (item) => item.state === 'missing' && item.effort === 'Low',
  )
  const partialItems = automatedItems.filter((item) => item.state === 'partial')
  const coverageScore = automatedItems.length
    ? Math.round((primary.automationCoverage.automatedItems / automatedItems.length) * 100)
    : 0
  const highImpactCoverage = highImpactItems.length
    ? Math.round((foundHighImpactItems.length / highImpactItems.length) * 100)
    : 0
  const quickWinPressure = Math.min(100, lowEffortGaps.length * 10)
  const calibratedScore = Math.max(
    0,
    Math.min(
      100,
      Math.round((primary.score * 0.7) + (highImpactCoverage * 0.2) + (coverageScore * 0.1) - (quickWinPressure * 0.1)),
    ),
  )
  const calibratedGrade = getGrade(calibratedScore)

  let positionLabel = 'Checklist fundamentals need work'
  if (calibratedScore >= 75) {
    positionLabel = 'Checklist fundamentals are in a strong place'
  } else if (calibratedScore >= 58) {
    positionLabel = 'Checklist fundamentals are decent but still uneven'
  } else if (calibratedScore >= 42) {
    positionLabel = 'Checklist fundamentals are mixed'
  }

  const readinessLabel =
    lowEffortGaps.length === 0
      ? 'Most of the obvious low-effort CRO wins are already covered.'
      : `There are ${lowEffortGaps.length} low-effort gaps still open in the checklist, so the page likely has straightforward CRO improvements available.`

  return {
    benchmarkCount: 0,
    matchedBenchmarkCount: 0,
    benchmarkMedianScore: null,
    benchmarkTopScore: null,
    benchmarkBottomScore: null,
    averageBenchmarkScore: null,
    calibratedScore,
    calibratedGrade,
    positionLabel,
    percentileLabel: readinessLabel,
    primaryVsMedian: null,
    primaryVsTop: null,
    scoreDistribution: [],
    categoryBenchmarks: primary.categoryScores.map((category) => ({
      category: category.category,
      primaryScore: category.score,
      benchmarkAverage: null,
      deltaToBenchmarkAverage: null,
    })),
    notes: [
      `High-impact coverage: ${highImpactCoverage}% of scored high-impact checklist items were fully found.`,
      `Low-effort missing items: ${lowEffortGaps.length}. Partial items still needing polish: ${partialItems.length}.`,
      'Calibration is now grounded in checklist coverage and gap pressure instead of asking for separate benchmark pages.',
    ],
  }
}

function loadCroChecklist() {
  if (checklistCache) return checklistCache

  const workbook = XLSX.read(fs.readFileSync(CHECKLIST_URL), { type: 'buffer' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false, header: 1 })
  const headerRow = rows[2] ?? []
  const dataRows = rows.slice(3)

  checklistCache = dataRows
    .map((row) => {
      const rowRecord = Object.fromEntries(headerRow.map((header, index) => [header, row[index] ?? '']))
      const number = Number(String(rowRecord['#'] ?? '').trim())
      if (!Number.isFinite(number)) return null

      const actionItem = String(rowRecord['Action Item'] ?? '').trim()
      if (!actionItem) return null

      const impact = normalizeImpact(String(rowRecord.Impact ?? '').trim())
      const effort = normalizeEffort(String(rowRecord.Effort ?? '').trim())

      return {
        id: `cro-${number}`,
        number,
        actionItem,
        pageArea: normalizePageArea(String(rowRecord['Page / Area'] ?? '').trim()),
        impact,
        effort,
        impactWeight: IMPACT_WEIGHTS[impact] ?? 4,
        whatToDo: String(rowRecord['What To Do and Why It Matters'] ?? '').trim(),
        exampleReferences: String(rowRecord['Example References'] ?? '')
          .split(/[\s,]+/)
          .map((item) => item.trim())
          .filter((item) => /^https?:\/\//i.test(item)),
      }
    })
    .filter(Boolean)

  return checklistCache
}

async function analyzeCroPage({ url, checklist, includeScreenshot, checklistMode, includeClarity }) {
  const snapshot = await fetchCroSnapshot(url, { includeScreenshot })
  const resolvedChecklistMode = resolveChecklistMode(snapshot.pageType, checklistMode)
  const applicableAreas = getApplicableAreas(snapshot.pageType, resolvedChecklistMode)
  const signals = deriveCroSignals(snapshot)
  const clarity = includeClarity
    ? await getClarityPageInsights(snapshot.url).catch((error) => ({
        connected: true,
        matched: false,
        source: 'saved',
        projectLabel: '',
        lastDays: 3,
        message: error instanceof Error ? error.message : 'Clarity data could not be loaded.',
      }))
    : null

  const checklistResults = checklist.map((item) => evaluateChecklistItem(item, snapshot, signals, applicableAreas))
  const automatedResults = checklistResults.filter((item) => item.detectorMode === 'automated' && item.applicable)
  const earnedPoints = automatedResults.reduce((sum, item) => sum + item.weightedPoints, 0)
  const maxPoints = automatedResults.reduce((sum, item) => sum + item.maxPoints, 0)
  const baseScore = maxPoints > 0 ? Math.round((earnedPoints / maxPoints) * 100) : 0
  const clarityAdjustment = clarity?.matched ? calculateClarityScoreAdjustment(clarity.frictionScore) : 0
  const score = clamp(baseScore + clarityAdjustment, 0, 100)

  return {
    url: snapshot.url,
    title: snapshot.title,
    pageType: snapshot.pageType,
    checklistMode: resolvedChecklistMode.id,
    checklistModeLabel: resolvedChecklistMode.label,
    appliedAreas: [...applicableAreas],
    score,
    baseScore,
    clarityAdjustment,
    grade: getGrade(score),
    screenshotDataUrl: snapshot.screenshotDataUrl ?? '',
    visualNote: snapshot.visualNote,
    automationCoverage: {
      automatedItems: automatedResults.length,
      manualItems: checklistResults.filter((item) => item.detectorMode === 'manual' && item.applicable).length,
      applicableItems: checklistResults.filter((item) => item.applicable).length,
    },
    metrics: buildCroMetrics(snapshot, signals, checklistResults, clarity),
    categoryScores: buildCategoryScores(checklistResults),
    quickWins: buildCroQuickWins(checklistResults, snapshot, signals, clarity),
    strengths: buildCroStrengths(checklistResults),
    checklistResults,
    featureSnapshot: buildFeatureSnapshot(signals, clarity),
    clarity,
  }
}

async function fetchCroSnapshot(rawUrl, { includeScreenshot }) {
  let parsedUrl
  try {
    parsedUrl = new URL(String(rawUrl).trim())
  } catch {
    throw new Error(`The CRO scan URL is invalid: ${rawUrl}`)
  }

  const fetched = await fetch(parsedUrl, {
    headers: {
      'user-agent': 'SEOAnalysisToolBot/0.1 (+https://github.com/mersadberberovic-cmd/seo-analysis-tool)',
      accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(20000),
  })

  if (!fetched.ok) {
    throw new Error(`Could not fetch CRO page. Status ${fetched.status}.`)
  }

  const html = await fetched.text()
  const $ = cheerio.load(html)
  const title = $('title').first().text().trim()
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() ?? ''
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim()
  const headings = $('h1, h2, h3')
    .map((_index, element) => ({
      level: Number(element.tagName?.slice(1) ?? 2),
      text: $(element).text().trim(),
    }))
    .get()
    .filter((item) => item.text)
  const scripts = $('script[src]').map((_index, element) => $(element).attr('src') ?? '').get()
  const links = $('a[href]')
    .map((_index, element) => ({
      text: $(element).text().trim(),
      href: $(element).attr('href') ?? '',
      rel: $(element).attr('rel') ?? '',
    }))
    .get()
  const images = $('img')
    .map((_index, element) => ({
      alt: $(element).attr('alt') ?? '',
      src: $(element).attr('src') ?? '',
      width: Number($(element).attr('width') ?? 0) || 0,
      height: Number($(element).attr('height') ?? 0) || 0,
    }))
    .get()
  const forms = $('form')
    .map((_index, element) => ({
      action: $(element).attr('action') ?? '',
      fieldCount: $(element).find('input, select, textarea').length,
    }))
    .get()

  const rendered = await captureCroRender(parsedUrl, includeScreenshot)

  return {
    url: parsedUrl.toString(),
    title,
    metaDescription,
    bodyText,
    headings,
    scripts,
    links,
    images,
    forms,
    tables: $('table').length,
    videoCount: $('video, iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="loom"]').length,
    rendered,
    pageType: inferCroPageType(parsedUrl, title, bodyText, rendered),
    screenshotDataUrl: rendered.screenshotDataUrl ?? '',
    visualNote: rendered.visualNote ?? 'Rendered DOM signals were used where available.',
  }
}

async function captureCroRender(targetUrl, includeScreenshot) {
  const executablePath = getBrowserExecutablePath()
  if (!executablePath) {
    return emptyRenderSnapshot('No supported browser executable was found, so CRO visual signals were limited to raw HTML.')
  }

  let browser
  try {
    browser = await chromium.launch({ executablePath, headless: true })
    const page = await browser.newPage({
      viewport: { width: 1440, height: 920 },
      deviceScaleFactor: 1,
    })
    page.setDefaultNavigationTimeout(18000)
    page.setDefaultTimeout(12000)
    await page.goto(targetUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 18000 })
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(1100).catch(() => {})

    const renderSnapshot = await page.evaluate(() => {
      const viewportHeight = window.innerHeight || 920
      const normalizeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
      const isVisible = (element) => {
        const style = window.getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') !== 0 && rect.width > 6 && rect.height > 6
      }
      const serialiseRect = (rect) => ({
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        bottom: Math.round(rect.bottom),
      })
      const ctas = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'))
        .filter((element) => isVisible(element))
        .map((element) => {
          const rect = element.getBoundingClientRect()
          const style = window.getComputedStyle(element)
          const text = normalizeText(element.textContent || element.getAttribute('value') || element.getAttribute('aria-label') || '')
          return {
            text,
            href: element instanceof HTMLAnchorElement ? element.href : '',
            rect: serialiseRect(rect),
            background: style.backgroundColor,
            color: style.color,
            borderColor: style.borderColor,
            fontWeight: style.fontWeight,
            position: style.position,
            classes: element.className ? String(element.className) : '',
            tagName: element.tagName.toLowerCase(),
          }
        })
        .filter((item) => item.text)
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .filter((element) => isVisible(element))
        .map((element) => ({
          level: Number(element.tagName.toLowerCase().replace('h', '')) || 2,
          text: normalizeText(element.textContent || ''),
          rect: serialiseRect(element.getBoundingClientRect()),
        }))
        .filter((item) => item.text)
      const images = Array.from(document.querySelectorAll('img'))
        .filter((element) => isVisible(element))
        .map((element) => ({
          alt: element.getAttribute('alt') || '',
          src: element.getAttribute('src') || '',
          rect: serialiseRect(element.getBoundingClientRect()),
          classes: element.className ? String(element.className) : '',
        }))
      const videos = Array.from(document.querySelectorAll('video, iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="loom"]'))
        .filter((element) => isVisible(element))
        .map((element) => ({
          rect: serialiseRect(element.getBoundingClientRect()),
          src: element.getAttribute('src') || '',
        }))
      const forms = Array.from(document.querySelectorAll('form'))
        .filter((element) => isVisible(element))
        .map((element) => ({
          rect: serialiseRect(element.getBoundingClientRect()),
          fieldCount: element.querySelectorAll('input, select, textarea').length,
          submitCount: element.querySelectorAll('button, input[type="submit"]').length,
          text: normalizeText(element.textContent || ''),
        }))
      const tables = Array.from(document.querySelectorAll('table'))
        .filter((element) => isVisible(element))
        .map((element) => ({
          rect: serialiseRect(element.getBoundingClientRect()),
          rows: element.querySelectorAll('tr').length,
          text: normalizeText(element.textContent || '').slice(0, 300),
        }))
      const navLabels = Array.from(document.querySelectorAll('nav a, header a'))
        .filter((element) => isVisible(element))
        .map((element) => normalizeText(element.textContent || ''))
        .filter(Boolean)
        .slice(0, 24)
      const stickyElements = Array.from(document.querySelectorAll('header, nav, [class*="sticky"], [class*="banner"], [id*="banner"], [class*="chat"], [id*="chat"], [class*="cta"], [id*="cta"]'))
        .filter((element) => isVisible(element))
        .map((element) => {
          const rect = element.getBoundingClientRect()
          const style = window.getComputedStyle(element)
          return {
            text: normalizeText(element.textContent || '').slice(0, 220),
            rect: serialiseRect(rect),
            position: style.position,
            classes: element.className ? String(element.className) : '',
            tagName: element.tagName.toLowerCase(),
          }
        })
        .filter((item) => item.text)
        .slice(0, 40)
      const bodyText = normalizeText(document.body.innerText || '')
      const topBanner = stickyElements.find((item) => item.rect.top <= 20 && item.rect.height <= 130)
      return {
        viewportHeight,
        ctas,
        headings,
        images,
        videos,
        forms,
        tables,
        navLabels,
        stickyElements,
        visibleText: bodyText.slice(0, 9000),
        topBannerText: topBanner?.text || '',
      }
    })

    let screenshotDataUrl = ''
    if (includeScreenshot) {
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: false })
      screenshotDataUrl = `data:image/jpeg;base64,${screenshot.toString('base64')}`
    }

    return {
      available: true,
      ...renderSnapshot,
      screenshotDataUrl,
      visualNote: 'Rendered DOM and above-the-fold layout signals were captured for CRO scoring.',
    }
  } catch (error) {
    return emptyRenderSnapshot(error instanceof Error ? error.message : 'Rendered CRO capture failed.')
  } finally {
    if (browser) {
      await browser.close().catch(() => {})
    }
  }
}

function emptyRenderSnapshot(visualNote) {
  return {
    available: false,
    viewportHeight: 920,
    ctas: [],
    headings: [],
    images: [],
    videos: [],
    forms: [],
    tables: [],
    navLabels: [],
    stickyElements: [],
    visibleText: '',
    topBannerText: '',
    screenshotDataUrl: '',
    visualNote,
  }
}

function deriveCroSignals(snapshot) {
  const text = `${snapshot.bodyText} ${snapshot.rendered.visibleText}`.replace(/\s+/g, ' ').trim()
  const topText = text.slice(0, 2200)
  const ctas = snapshot.rendered.ctas
  const primaryCtas = ctas.filter((item) => CTA_PRIMARY_TERMS.test(item.text) || (CTA_STRONG_TERMS.test(item.text) && item.rect.top < snapshot.rendered.viewportHeight))
  const aboveFoldCtas = ctas.filter((item) => item.rect.top >= 0 && item.rect.top < snapshot.rendered.viewportHeight * 0.95)
  const strongAboveFoldCtas = aboveFoldCtas.filter((item) => CTA_STRONG_TERMS.test(item.text))
  const secondaryCtas = ctas.filter((item) => CTA_SECONDARY_TERMS.test(item.text))
  const topImages = snapshot.rendered.images.filter((item) => item.rect.top < snapshot.rendered.viewportHeight + 120)
  const largeTopImages = topImages.filter((item) => item.rect.width >= 240 && item.rect.height >= 160)
  const videoAboveFold = snapshot.rendered.videos.some((item) => item.rect.top < snapshot.rendered.viewportHeight + 120)
  const hasStickyCta = snapshot.rendered.stickyElements.some((item) => /cta|demo|get started|start free|book/i.test(item.text))
  const headingTexts = snapshot.headings.map((item) => item.text).join(' ')
  const firstHeading = snapshot.headings[0]?.text ?? ''
  const wordCount = text.split(/\s+/).filter(Boolean).length
  const paragraphs = snapshot.bodyText.split(/\n+/).map((item) => item.trim()).filter(Boolean)
  const averageParagraphWords = paragraphs.length > 0
    ? Math.round(paragraphs.reduce((sum, paragraph) => sum + paragraph.split(/\s+/).filter(Boolean).length, 0) / paragraphs.length)
    : Math.round(wordCount / Math.max(snapshot.headings.length, 1))
  const numericClaims = countRegex(text, /\b\d+(?:[.,]\d+)?(?:%|x)?\b/g)
  const benefitHeadings = snapshot.headings.filter((item) => /(save|reduce|increase|faster|better|grow|book|close|win|convert|clarity|organize|track|improve|see)/i.test(item.text)).length
  const featureHeadings = snapshot.headings.filter((item) => /(automation|workflow|dashboard|analytics|reporting|integration|feature|module|platform)/i.test(item.text)).length
  const testimonialMentions = countRegex(text, /(testimonial|customer story|case study|ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“|ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â|review|results? in|roi|stars?|trusted by)/gi)
  const hasFaq = /faq|frequently asked questions/i.test(text) || countRegex(text, /\?/g) >= 4
  const hasKeyTakeaways = /key takeaways|what you.ll learn|in this article/i.test(text)
  const hasToc = /table of contents|jump to|on this page/i.test(text)
  const hasReferences = /references|sources|citations/i.test(text)
  const hasSocialShare = /share on|linkedin|twitter|facebook/i.test(text)
  const hasRelatedArticles = /related articles|you may also like|read next/i.test(text)
  const hasAnnouncementBanner = snapshot.rendered.topBannerText.length > 0 && /new|launch|announcement|limited|save|offer|trial|webinar/i.test(snapshot.rendered.topBannerText)
  const hasLiveChat = /(intercom|drift|crisp|tawk|hubspot conversations|zendesk widget|livechatinc)/i.test(`${snapshot.scripts.join(' ')} ${snapshot.bodyText}`)
  const hasExitIntent = /(exit intent|ouibounce|mouseleave|exit-popup|exit intent)/i.test(`${snapshot.scripts.join(' ')} ${snapshot.bodyText}`)
  const reviewPlatformMentions = countRegex(text, /(g2|capterra|trustpilot|gartner|forrester|product hunt)/gi)
  const starRatingVisible = /\b[1-5](?:\.\d)?\s*(stars?|\/5|rating)\b/i.test(text)
  const hasGuarantee = /(money-back|free trial|cancel anytime|no credit card|guarantee|risk-free)/i.test(text)
  const hasPricingToggle = /(monthly|annual|yearly|save \d|save \$|save ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£|save ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬)/i.test(text)
  const hasPricingMatrix = snapshot.tables > 0 || snapshot.rendered.tables.length > 0 || /compare plans|feature matrix|all features/i.test(text)
  const pricingCardCount = countRegex(text, /(starter|pro|business|enterprise|most popular|recommended)/gi)
  const hasCalculator = /(calculator|estimate|custom price|roi calculator)/i.test(text)
  const hasRoiSection = /(roi|return on investment|payback|saves .* hours|saves .* per)/i.test(text)
  const hasPlanDescriptors = countRegex(text, /(best for|ideal for|for teams|for startups|for enterprise)/gi) >= 2
  const hasUrgency = /(offer ends|ends on|limited time|through [A-Z][a-z]+ \d{1,2}|only until)/i.test(text)
  const hasObjectionHandling = /(no credit card|setup in|migrate|security|switching|cancel anytime|implementation|faq)/i.test(text)
  const hasPainFirst = getFirstIndex(text, PAIN_TERMS) >= 0 && (getFirstIndex(text, SOLUTION_TERMS) === -1 || getFirstIndex(text, PAIN_TERMS) < getFirstIndex(text, SOLUTION_TERMS))
  const hasBeforeAfter = /(before and after|before you|after you|without .* with .*|from .* to .*)/i.test(text)
  const hasIntegrations = /(integrations|connects with|salesforce|hubspot|slack|zapier|pipedrive|shopify)/i.test(text)
  const integrationMentions = countRegex(text, /(salesforce|hubspot|slack|zapier|pipedrive|shopify|stripe|intercom|notion)/gi)
  const hasAuthorBox = /(written by|author|about the author|updated by|reviewed by)/i.test(text)
  const hasTipsBoxes = /(pro tip|expert tip|tip:|quick tip)/i.test(text)
  const hasExpertPicks = /(expert pick|our expert recommends|best for)/i.test(text)
  const hasCaseStudy = /(case study|read story|customer story|results? achieved|used by)/i.test(text)
  const hasTimeline = /(what happens next|step 1|step 2|step 3|within \d+ hours|response time)/i.test(text)
  const hasInlineCalendar = /(calendly|book a time|pick a time|schedule a call)/i.test(`${snapshot.bodyText} ${snapshot.scripts.join(' ')}`)
  const hasTrustAboveFold = TRUST_TERMS.test(topText) || reviewPlatformMentions > 0 || /\btrusted by\b/i.test(topText)
  const hasValueBullets = countRegex(text, /(what you.ll get|see the demo|get a custom|you.ll see|in the demo|you get)/gi) >= 2
  const recognisableBrands = [...new Set(WELL_KNOWN_BRANDS.filter((brand) => text.toLowerCase().includes(brand.toLowerCase())))]
  const secondPersonCount = countRegex(text, /\b(you|your|your team)\b/gi)
  const jargonHits = countRegex(text, new RegExp(`\\b(${JARGON_TERMS.join('|')})\\b`, 'gi'))
  const navLabels = snapshot.rendered.navLabels
  const vagueNavLabels = navLabels.filter((item) => /solutions|platform|why us|resources/i.test(item))
  const descriptiveNavLabels = navLabels.filter((item) => /(pricing|features|integrations|for |demo|customers|blog|contact|security)/i.test(item))
  const titleMetaBenefit = /(free|demo|book|compare|best|save|improve|faster|reduce|grow)/i.test(`${snapshot.title} ${snapshot.metaDescription}`)
  const hasMessageMatchSignals = /(for |best |compare|vs |solution for )/i.test(snapshot.title)
  const hasHeatmapScript = /(hotjar|clarity|fullstory|crazyegg)/i.test(snapshot.scripts.join(' '))
  const topForm = snapshot.rendered.forms.find((item) => item.rect.top < snapshot.rendered.viewportHeight + 120)
  const shortForm = topForm ? topForm.fieldCount <= 5 : snapshot.forms.some((item) => item.fieldCount <= 5)
  const distractionFree = navLabels.length <= 5
  const topLogoBar = /trusted by|customers include|teams at|as seen in/i.test(topText)
  const usageStatCount = countRegex(text, /\b\d{2,}(?:,\d{3})*\s+(users|teams|customers|tasks|companies|reviews?)\b/gi)
  const contentUpgrade = /(download|template|checklist|playbook|pdf|resource)/i.test(text)

  return {
    ctas,
    primaryCtas,
    aboveFoldCtas,
    strongAboveFoldCtas,
    secondaryCtas,
    topImages,
    largeTopImages,
    videoAboveFold,
    hasStickyCta,
    wordCount,
    averageParagraphWords,
    numericClaims,
    benefitHeadings,
    featureHeadings,
    testimonialMentions,
    hasFaq,
    hasKeyTakeaways,
    hasToc,
    hasReferences,
    hasSocialShare,
    hasRelatedArticles,
    hasAnnouncementBanner,
    hasLiveChat,
    hasExitIntent,
    reviewPlatformMentions,
    starRatingVisible,
    hasGuarantee,
    hasPricingToggle,
    hasPricingMatrix,
    pricingCardCount,
    hasCalculator,
    hasRoiSection,
    hasPlanDescriptors,
    hasUrgency,
    hasObjectionHandling,
    hasPainFirst,
    hasBeforeAfter,
    hasIntegrations,
    integrationMentions,
    hasAuthorBox,
    hasTipsBoxes,
    hasExpertPicks,
    hasCaseStudy,
    hasTimeline,
    hasInlineCalendar,
    hasTrustAboveFold,
    hasValueBullets,
    recognisableBrands,
    secondPersonCount,
    jargonHits,
    navLabels,
    vagueNavLabels,
    descriptiveNavLabels,
    titleMetaBenefit,
    hasMessageMatchSignals,
    hasHeatmapScript,
    topForm,
    shortForm,
    distractionFree,
    topLogoBar,
    usageStatCount,
    contentUpgrade,
    firstHeading,
    headingTexts,
  }
}

function evaluateChecklistItem(item, snapshot, signals, applicableAreas) {
  const applicable = applicableAreas.has(item.pageArea) || item.pageArea === 'Site Wide'
  const detector = getChecklistDetector(item)

  if (!applicable) {
    return buildChecklistResult(item, {
      applicable: false,
      detectorMode: detector.mode,
      state: 'not-applicable',
      rationale: `This check is scoped to ${item.pageArea} pages, while the scanned page was classified as ${snapshot.pageType}.`,
      evidence: [],
      recommendation: item.whatToDo,
    })
  }

  if (detector.mode === 'manual') {
    return buildChecklistResult(item, {
      applicable: true,
      detectorMode: 'manual',
      state: 'manual-review',
      rationale: detector.note,
      evidence: [],
      recommendation: item.whatToDo,
    })
  }

  return buildChecklistResult(item, {
    applicable: true,
    detectorMode: 'automated',
    ...detector.evaluate(snapshot, signals, item),
  })
}

function getChecklistDetector(item) {
  const action = item.actionItem

  if (/Hero Headline with Clear USP/i.test(action)) return automatedDetector(heroHeadlineDetector)
  if (/ICP-Specific Sub-headline/i.test(action)) return automatedDetector(subheadlineDetector)
  if (/Single Primary CTA Above the Fold|CTA Visible Without Scrolling on All Devices/i.test(action)) return automatedDetector(primaryCtaAboveFoldDetector)
  if (/High-Quality Product Screenshot or UI Visual|Product Screenshots Embedded Inside Articles|High-Quality Template Preview Images/i.test(action)) return automatedDetector(productVisualDetector)
  if (/Demo Video Near the Top|Video Testimonials/i.test(action)) return automatedDetector(videoDetector)
  if (/Social Proof Near CTA|Customer Logos and Trust Badges Near the Top|Customer Logos on the Demo Page|Trust Signals Above the Fold on Landing Pages/i.test(action)) return automatedDetector(trustAboveFoldDetector)
  if (/Outcome-Focused Testimonial Section|Outcome Testimonials on the Pricing Page|Outcome Testimonials Directly on the Demo Page/i.test(action)) return automatedDetector(testimonialDetector)
  if (/Secondary CTA Mid-Page|Primary and Secondary CTA Pairing/i.test(action)) return automatedDetector(secondaryCtaDetector)
  if (/Sticky Navigation with CTA Button|Sticky CTA Bar on Mobile/i.test(action)) return automatedDetector(stickyCtaDetector)
  if (/Benefits Over Features in All Copy|Benefit-Led Feature Headlines/i.test(action)) return automatedDetector(benefitHeadlineDetector)
  if (/Objection-Handling Strip|Objection Pre-emption in Sales Copy/i.test(action)) return automatedDetector(objectionHandlingDetector)
  if (/Final CTA Section with Value Restatement|Styled Conclusion Section with CTA Inside/i.test(action)) return automatedDetector(finalCtaDetector)
  if (/Contrasting CTA Button Colour|CTA Colour and Contrast Audit/i.test(action)) return automatedDetector(ctaContrastDetector)
  if (/Micro-Copy Below Every CTA Button/i.test(action)) return automatedDetector(microcopyDetector)
  if (/G2 or Capterra Badges|Live Review Platform Widget|Awards and Analyst Recognition Badges/i.test(action)) return automatedDetector(reviewBadgeDetector)
  if (/Star Rating Next to CTA/i.test(action)) return automatedDetector(starRatingDetector)
  if (/Top-of-Page Announcement Banner/i.test(action)) return automatedDetector(announcementBannerDetector)
  if (/Live Chat or AI Chatbot/i.test(action)) return automatedDetector(liveChatDetector)
  if (/Exit Intent/i.test(action)) return automatedDetector(exitIntentDetector)
  if (/Custom 404 Page with CTAs/i.test(action)) return automatedDetector(custom404Detector)
  if (/Most Popular Plan Visual Highlight/i.test(action)) return automatedDetector(pricingHighlightDetector)
  if (/Annual and Monthly Toggle|Waterfall Layout/i.test(action)) return automatedDetector(pricingToggleDetector)
  if (/Full Feature Comparison Matrix|Feature Tier Comparison Table|Comparison Tables in Roundup Posts/i.test(action)) return automatedDetector(comparisonTableDetector)
  if (/Money-Back Guarantee|Free Trial Terms/i.test(action)) return automatedDetector(guaranteeDetector)
  if (/Sales Rep Photo/i.test(action)) return automatedDetector(salesRepDetector)
  if (/ROI Section|ROI estimate/i.test(action)) return automatedDetector(roiDetector)
  if (/Custom Price Calculator/i.test(action)) return automatedDetector(calculatorDetector)
  if (/Clear Plan Descriptor/i.test(action)) return automatedDetector(planDescriptorDetector)
  if (/Urgency|Scarcity/i.test(action)) return automatedDetector(urgencyDetector)
  if (/Annotated Screenshots|Short GIFs/i.test(action)) return automatedDetector(annotatedVisualDetector)
  if (/Pain Point Section Before the Solution|Pain-Agitate-Solution|Pain-First Copy Structure/i.test(action)) return automatedDetector(painFirstDetector)
  if (/Before and After Comparison Block|Before & After|Before and After/i.test(action)) return automatedDetector(beforeAfterDetector)
  if (/Secondary Micro-Benefits/i.test(action)) return automatedDetector(microBenefitsDetector)
  if (/Sticky Side Navigation|Clickable Table of Contents/i.test(action)) return automatedDetector(stickySideNavDetector)
  if (/Compact Case Study Card|Filterable Case Study Library|Compact Case Study Cards/i.test(action)) return automatedDetector(caseStudyDetector)
  if (/Integrations Section/i.test(action)) return automatedDetector(integrationsDetector)
  if (/Feature-Specific FAQ Section|Template-Specific FAQs/i.test(action)) return automatedDetector(faqDetector)
  if (/Social Proof Number Near Product CTA|Specific Customer Usage Statistics/i.test(action)) return automatedDetector(usageStatsDetector)
  if (/Breathable Article Structure|Scannable F-Pattern Page Structure/i.test(action)) return automatedDetector(articleStructureDetector)
  if (/Key Takeaways Box/i.test(action)) return automatedDetector(keyTakeawaysDetector)
  if (/Contextually Relevant Sticky CTA|Inline CTAs at Natural Article Breakpoints|Image-Backed Inline CTA Cards/i.test(action)) return automatedDetector(inlineCtaDetector)
  if (/Small or Text-Only Article Header Image/i.test(action)) return automatedDetector(compactHeaderDetector)
  if (/Author Box with Credentials|Author Attribution/i.test(action)) return automatedDetector(authorDetector)
  if (/Pro Tips|Expert Highlight Boxes/i.test(action)) return automatedDetector(tipsDetector)
  if (/Expert Picks/i.test(action)) return automatedDetector(expertPicksDetector)
  if (/Affiliate-Style Layout/i.test(action)) return automatedDetector(reviewLayoutDetector)
  if (/References Behind a Collapsible Toggle/i.test(action)) return automatedDetector(referencesDetector)
  if (/Downloadable Content Upgrade/i.test(action)) return automatedDetector(contentUpgradeDetector)
  if (/Updated Date|Fresh content|Last updated/i.test(action)) return automatedDetector(freshnessDetector)
  if (/Social Share Buttons/i.test(action)) return automatedDetector(socialShareDetector)
  if (/Related Articles Section/i.test(action)) return automatedDetector(relatedArticlesDetector)
  if (/Distraction-Free Layout with No Navigation|Single Conversion Goal Per Landing Page/i.test(action)) return automatedDetector(distractionFreeDetector)
  if (/Short Form with 5 Fields Maximum|Short Form with 3 to 5 Fields/i.test(action)) return automatedDetector(shortFormDetector)
  if (/Value Bullet Points Beside the Form|What to Expect Timeline/i.test(action)) return automatedDetector(valueBulletsDetector)
  if (/Confirmation Page with What Happens Next/i.test(action)) return manualDetector('This item needs post-submit flow testing or thank-you page access, so it is kept as a manual CRO review item.')
  if (/Inline Calendar Booking/i.test(action)) return automatedDetector(calendarDetector)
  if (/Live Review Widget|Recent G2 Quotes/i.test(action)) return automatedDetector(reviewBadgeDetector)
  if (/Optimised Testimonial Format|Testimonials Mapped|Named Quotes from Recognisable Companies/i.test(action)) return automatedDetector(testimonialQualityDetector)
  if (/Media Mention Logo Bar/i.test(action)) return automatedDetector(mediaMentionsDetector)
  if (/One Primary CTA Per Page/i.test(action)) return automatedDetector(onePrimaryCtaDetector)
  if (/Outcome-Oriented CTA Copy/i.test(action)) return automatedDetector(outcomeCtaDetector)
  if (/Message Match Between Ad and Landing Page/i.test(action)) return automatedDetector(messageMatchDetector)
  if (/Social Proof Matched to the Campaign Audience/i.test(action)) return automatedDetector(segmentSocialProofDetector)
  if (/Heatmap and Session Recording/i.test(action)) return automatedDetector(heatmapDetector)
  if (/Voice of Customer Language Integration/i.test(action)) return automatedDetector(voiceOfCustomerDetector)
  if (/Specificity Over Generalisation|Data Points and Numbers in Every Major Claim/i.test(action)) return automatedDetector(specificityDetector)
  if (/Problem-Aware vs Solution-Aware Messaging|Keyword Intent Alignment/i.test(action)) return automatedDetector(intentAlignmentDetector)
  if (/Hero Headline A\/B Test Cadence|CTA Copy Testing Framework/i.test(action)) return manualDetector('Testing cadence requires historical experimentation data, so this stays in manual review.')
  if (/Clarity Over Cleverness/i.test(action)) return automatedDetector(headlineClarityDetector)
  if (/Second-Person Voice Throughout/i.test(action)) return automatedDetector(secondPersonDetector)
  if (/Social Proof Name-Dropping/i.test(action)) return automatedDetector(socialProofNameDropDetector)
  if (/Navigation Labels That Describe/i.test(action)) return automatedDetector(navLabelDetector)
  if (/Avoid Jargon/i.test(action)) return automatedDetector(jargonDetector)
  if (/Title Tags and Meta Descriptions Written as Ad Copy/i.test(action)) return automatedDetector(titleMetaDetector)
  if (/Core Web Vitals Pass/i.test(action)) return manualDetector('Core Web Vitals need field or lab performance testing beyond this page-structure scan.')
  if (/Dedicated Comparison Landing Pages for VS Queries/i.test(action)) return automatedDetector(comparisonQueryDetector)

  return manualDetector('This checklist item still needs manual CRO review because the current automatic scan cannot verify it reliably on a single pass.')
}

function automatedDetector(evaluate) {
  return { mode: 'automated', evaluate }
}

function manualDetector(note) {
  return { mode: 'manual', note }
}

function buildChecklistResult(item, evaluation) {
  const stateWeights = {
    found: 1,
    partial: 0.55,
    missing: 0,
    'manual-review': 0,
    'not-applicable': 0,
  }
  const maxPoints = evaluation.detectorMode === 'automated' && evaluation.applicable ? item.impactWeight : 0
  const weightedPoints = maxPoints * (stateWeights[evaluation.state] ?? 0)

  return {
    id: item.id,
    number: item.number,
    actionItem: item.actionItem,
    pageArea: item.pageArea,
    impact: item.impact,
    effort: item.effort,
    applicable: evaluation.applicable,
    detectorMode: evaluation.detectorMode,
    state: evaluation.state,
    rationale: evaluation.rationale,
    evidence: evaluation.evidence ?? [],
    recommendation: evaluation.recommendation,
    exampleReferences: item.exampleReferences,
    maxPoints,
    weightedPoints,
    priorityWeight: item.impactWeight + (item.effort === 'Low' ? 3 : item.effort === 'Mid' ? 1 : 0),
  }
}

function buildChecklistSummary(checklist) {
  return {
    totalItems: checklist.length,
    pageAreas: [...new Set(checklist.map((item) => item.pageArea))],
    highImpactCount: checklist.filter((item) => item.impact === 'High').length,
    quickWinCount: checklist.filter((item) => item.impact === 'High' && item.effort === 'Low').length,
  }
}

function buildCategoryScores(checklistResults) {
  const groups = new Map()

  checklistResults.forEach((item) => {
    if (!groups.has(item.pageArea)) {
      groups.set(item.pageArea, { category: item.pageArea, earned: 0, max: 0, found: 0, partial: 0, missing: 0 })
    }
    const group = groups.get(item.pageArea)
    if (item.applicable && item.detectorMode === 'automated') {
      group.earned += item.weightedPoints
      group.max += item.maxPoints
      if (item.state === 'found') group.found += 1
      if (item.state === 'partial') group.partial += 1
      if (item.state === 'missing') group.missing += 1
    }
  })

  return [...groups.values()]
    .filter((item) => item.max > 0)
    .map((item) => ({
      ...item,
      score: item.max > 0 ? Math.round((item.earned / item.max) * 100) : 0,
    }))
    .sort((left, right) => right.max - left.max)
}

function buildCroQuickWins(checklistResults, snapshot, signals, clarity) {
  const clarityQuickWins = buildClarityQuickWins(clarity, snapshot)
  const rankedItems = checklistResults
    .filter((item) => item.applicable && item.detectorMode === 'automated' && item.state !== 'found')
    .map((item) => ({
      ...item,
      opportunityScore: item.priorityWeight + (item.state === 'missing' ? 4 : 1) + getQuickWinPriorityBoost(item, snapshot, signals),
    }))
    .sort((left, right) => right.opportunityScore - left.opportunityScore)

  const uniqueItems = []
  const seenHeadings = new Set()

  for (const item of rankedItems) {
    const strategistHeading = buildQuickWinHeading(item, snapshot, signals)
    if (seenHeadings.has(strategistHeading)) continue
    seenHeadings.add(strategistHeading)
    const strategistDetail = buildQuickWinDetail(item, snapshot, signals)
    uniqueItems.push({
      ...item,
      strategistHeading,
      strategistBody: strategistDetail.summary,
      strategistEvidence: strategistDetail.evidence,
      strategistInstruction: strategistDetail.instruction,
      strategistExample: strategistDetail.example,
    })
    if (uniqueItems.length >= 5) break
  }

  return [...clarityQuickWins, ...uniqueItems].slice(0, 5).map((item, index) => ({
    ...item,
    quickWinRank: index + 1,
  }))
}

function buildClarityQuickWins(clarity, snapshot, signals) {
  if (!clarity?.matched) return []

  const quickWins = []

  if (clarity.deadClicks >= 3) {
    quickWins.push({
      id: 'clarity-dead-clicks',
      number: 0,
      actionItem: 'Reduce dead clicks on misleading interface elements',
      pageArea: 'Behavioral Friction',
      impact: 'High',
      effort: 'Mid',
      applicable: true,
      detectorMode: 'automated',
      state: 'missing',
      rationale: 'Clarity detected dead clicks, which usually means people are trying to interact with elements that look clickable but are not.',
      evidence: ['Clarity recorded ' + clarity.deadClicks + ' dead clicks in the last ' + clarity.lastDays + ' days.'],
      recommendation: 'Review cards, logos, images, and decorative panels that visually imply clickability. Make them clickable or visually quiet them down.',
      strategistHeading: 'Fix misleading clickable elements on the page',
      strategistBody: 'Clarity shows visitors are clicking on things that do not respond, which is one of the clearest behavioral signs of interface friction.',
      strategistEvidence: 'Clarity recorded ' + clarity.deadClicks + ' dead clicks for this URL over the last ' + clarity.lastDays + ' days.',
      strategistInstruction: 'Audit hero cards, offer tiles, trust badges, and image blocks that may look interactive. Either make them clickable or remove the visual affordance.',
      strategistExample: 'Example: if an offer card or brand logo looks tappable, make the whole card clickable or restyle it so it no longer behaves like a false button.',
      exampleReferences: [],
      maxPoints: 0,
      weightedPoints: 0,
      priorityWeight: 18,
    })
  }

  if (clarity.rageClicks >= 3) {
    quickWins.push({
      id: 'clarity-rage-clicks',
      number: 0,
      actionItem: 'Resolve frustration around key interactive elements',
      pageArea: 'Behavioral Friction',
      impact: 'High',
      effort: 'Mid',
      applicable: true,
      detectorMode: 'automated',
      state: 'missing',
      rationale: 'Clarity detected rage clicks, which often points to friction around tabs, buttons, sliders, or forms.',
      evidence: ['Clarity recorded ' + clarity.rageClicks + ' rage clicks in the last ' + clarity.lastDays + ' days.'],
      recommendation: 'Stress-test the main CTA path, comparison controls, and sticky UI so the interface responds instantly and predictably.',
      strategistHeading: 'Reduce frustration on the main conversion path',
      strategistBody: 'The page is generating frustration clicks, which usually means people are trying to progress but the interface is not behaving the way they expect.',
      strategistEvidence: 'Clarity recorded ' + clarity.rageClicks + ' rage clicks and ' + (clarity.rates?.rageClicksPer100Sessions ?? 0) + ' rage clicks per 100 sessions.',
      strategistInstruction: 'Check the main CTA, sticky controls, tabbed content, sliders, and quote flow for delayed response, overlapping elements, or poor mobile hit areas.',
      strategistExample: 'Example: if users repeatedly hit the quote button or comparison controls, improve tap targets, reduce delay, and make state changes visually obvious.',
      exampleReferences: [],
      maxPoints: 0,
      weightedPoints: 0,
      priorityWeight: 19,
    })
  }

  if (clarity.quickbacks >= 2 || (clarity.scrollDepth < 45 && snapshot.pageType !== 'blog')) {
    quickWins.push({
      id: 'clarity-message-match',
      number: 0,
      actionItem: 'Tighten above-the-fold message match and page pull',
      pageArea: 'Behavioral Friction',
      impact: 'High',
      effort: 'Low',
      applicable: true,
      detectorMode: 'automated',
      state: 'missing',
      rationale: 'Quickbacks or shallow scroll depth suggest the opening section is not pulling visitors into the page strongly enough.',
      evidence: ['Clarity scroll depth: ' + clarity.scrollDepth + '%', 'Quickbacks: ' + clarity.quickbacks],
      recommendation: 'Bring the core value proposition, proof, and next step higher on the page so users understand the offer immediately.',
      strategistHeading: 'Strengthen the first screen so visitors keep going',
      strategistBody: 'Behavior data suggests the opening section is not doing enough to keep visitors engaged or reassure them quickly.',
      strategistEvidence: 'Clarity shows ' + clarity.scrollDepth + '% scroll depth and ' + clarity.quickbacks + ' quickbacks for this page.',
      strategistInstruction: 'Rewrite the first section to lead with the visitor problem, the offer, and one proof point before asking for action.',
      strategistExample: 'Example: start with the buyer problem, then a concise service promise, then a trust line close to the "' + getPrimaryCtaLabel(signals) + '" CTA.',
      exampleReferences: [],
      maxPoints: 0,
      weightedPoints: 0,
      priorityWeight: 17,
    })
  }

  return quickWins
}

function calculateClarityScoreAdjustment(frictionScore) {
  if (frictionScore >= 85) return 6
  if (frictionScore >= 72) return 3
  if (frictionScore >= 58) return 0
  if (frictionScore >= 45) return -4
  return -8
}


function getQuickWinPriorityBoost(item, snapshot, signals) {
  let boost = 0

  if (snapshot.pageType === 'service') {
    if (/Micro-Copy Below Every CTA Button/i.test(item.actionItem)) boost += 8
    if (/Star Rating Next to CTA|G2 or Capterra Badges|Live Review Widget|Social Proof Near CTA/i.test(item.actionItem)) boost += 7
    if (/Pain Point Section Before the Solution|Pain-Agitate-Solution|Pain-First Copy Structure/i.test(item.actionItem)) boost += 7
    if (/Full Feature Comparison Matrix|Feature Tier Comparison Table|Comparison Tables in Roundup Posts/i.test(item.actionItem)) boost += 7
    if (/Money-Back Guarantee|Free Trial Terms/i.test(item.actionItem)) boost += 7
    if (/Benefits Over Features in All Copy/i.test(item.actionItem)) boost += 5
    if (/Short Form with 5 Fields Maximum|Short Form with 3 to 5 Fields/i.test(item.actionItem)) boost -= 4
    if (/Message Match Between Ad and Landing Page/i.test(item.actionItem)) boost -= 3
  }

  if (signals.primaryCtas.length > 0 && /Micro-Copy Below Every CTA Button/i.test(item.actionItem)) boost += 2
  if (Math.max(signals.testimonialMentions, signals.reviewPlatformMentions) <= 4 && /Star Rating Next to CTA|Social Proof Near CTA/i.test(item.actionItem)) boost += 2
  if (!signals.hasGuarantee && /Money-Back Guarantee|Free Trial Terms/i.test(item.actionItem)) boost += 2
  if (!signals.hasPainFirst && /Pain Point Section Before the Solution|Pain-Agitate-Solution|Pain-First Copy Structure/i.test(item.actionItem)) boost += 2
  if (!signals.hasPricingMatrix && /Full Feature Comparison Matrix|Feature Tier Comparison Table|Comparison Tables in Roundup Posts/i.test(item.actionItem)) boost += 2

  return boost
}

function buildQuickWinHeading(item, snapshot, signals) {
  if (/Micro-Copy Below Every CTA Button/i.test(item.actionItem)) {
    return 'Add reassurance text under your "' + getPrimaryCtaLabel(signals) + '" buttons'
  }
  if (/Star Rating Next to CTA|G2 or Capterra Badges|Live Review Widget/i.test(item.actionItem)) {
    return 'Add a star rating next to your main call-to-action'
  }
  if (/Pain Point Section Before the Solution|Pain-Agitate-Solution|Pain-First Copy Structure/i.test(item.actionItem)) {
    return 'Lead with the buyer problem before the offer'
  }
  if (/Full Feature Comparison Matrix|Feature Tier Comparison Table|Comparison Tables in Roundup Posts/i.test(item.actionItem)) {
    return 'Add a comparison table that makes the offer easy to compare'
  }
  if (/Money-Back Guarantee|Free Trial Terms/i.test(item.actionItem)) {
    return 'Add a visible guarantee or risk-reversal near the CTA'
  }
  if (/Social Proof Near CTA|Customer Logos and Trust Badges/i.test(item.actionItem)) {
    return 'Bring trust signals closer to the conversion point'
  }
  if (/Benefits Over Features in All Copy/i.test(item.actionItem)) {
    return 'Rewrite the opening copy to emphasize outcomes, not just the offer'
  }
  if (/Short Form with 5 Fields Maximum|Short Form with 3 to 5 Fields/i.test(item.actionItem)) {
    return 'Shorten the quote request flow'
  }
  if (/Message Match Between Ad and Landing Page/i.test(item.actionItem)) {
    return 'Tighten the headline so it matches the buyer intent better'
  }

  return item.actionItem
}

function buildQuickWinDetail(item, snapshot, signals) {
  const ctaLabel = getPrimaryCtaLabel(signals)
  const trustSignalCount = Math.max(signals.testimonialMentions, signals.reviewPlatformMentions)
  const heading = signals.firstHeading || snapshot.title || 'this page'
  const serviceContext = inferServiceContext(snapshot)
  const openingSnippet = getOpeningSignalSnippet(snapshot, signals)
  const trustSignalSummary = buildTrustSignalExamples(signals)

  if (/Micro-Copy Below Every CTA Button/i.test(item.actionItem)) {
    return {
      summary: `The "${ctaLabel}" buttons are doing the conversion work on their own right now, without supporting reassurance copy.`,
      evidence: `We detected the CTA "${ctaLabel}" but no supporting micro-copy directly tied to it.`,
      instruction: 'Add a short reassurance line directly underneath the main CTA in smaller muted text. Keep it practical and trust-building rather than promotional.',
      example: `Example: "Free quote ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· No obligation ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${serviceContext.installerTrustLine}"`,
    }
  }

  if (/Star Rating Next to CTA|G2 or Capterra Badges|Live Review Widget/i.test(item.actionItem)) {
    return {
      summary: `The scan only detected ${trustSignalCount} strong social-proof signal${trustSignalCount === 1 ? '' : 's'} on this page, which is light for a page asking someone to take action.`,
      evidence: trustSignalSummary,
      instruction: 'Put a visible rating or review-count proof line beside the main CTA so credibility shows up right at the decision point.',
      example: 'Example: "4.9/5 ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· 200+ reviews" or "Rated 4.9/5 by local customers"',
    }
  }

  if (/Pain Point Section Before the Solution|Pain-Agitate-Solution|Pain-First Copy Structure/i.test(item.actionItem)) {
    return {
      summary: 'The page moves quickly into the offer without first naming the buyer problem that likely brought the visitor here.',
      evidence: `Opening copy detected: "${openingSnippet}"`,
      instruction: `Before the promotional section, add one or two lines that acknowledge the buyer's situation, then bridge into the offer. For "${heading}", the problem framing should come before the sales message.`,
      example: `Example: "${serviceContext.problemLine}"`,
    }
  }

  if (/Full Feature Comparison Matrix|Feature Tier Comparison Table|Comparison Tables in Roundup Posts/i.test(item.actionItem)) {
    return {
      summary: 'There is no strong comparison structure on the page right now, so users have to work out the differences themselves.',
      evidence: 'The scan did not detect a visible comparison table or matrix on the page.',
      instruction: 'Add a simple comparison table showing the most decision-driving attributes side by side so visitors can evaluate options without extra mental effort.',
      example: 'Suggested columns: model / room size / install included / warranty / running cost / best-for use case',
    }
  }

  if (/Money-Back Guarantee|Free Trial Terms/i.test(item.actionItem)) {
    return {
      summary: 'There is no clear risk-reversal or workmanship reassurance close to the conversion point.',
      evidence: 'The scan detected no visible guarantee or risk-reversal statement near the main CTA.',
      instruction: 'Add a plain-language guarantee statement near the main conversion action so people know what happens if the installation or decision goes wrong.',
      example: 'Example: "We back every installation with our 12-month workmanship guarantee ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â if something is not right, we will fix it."',
    }
  }

  if (/Social Proof Near CTA|Customer Logos and Trust Badges/i.test(item.actionItem)) {
    return {
      summary: 'The page would feel more convincing if trust signals sat closer to the CTA instead of being spread through the page.',
      evidence: trustSignalSummary,
      instruction: 'Pull the strongest trust signals into a compact proof strip beside or just below the main CTA so reassurance lands at the point of decision.',
      example: `Example proof strip: "${serviceContext.proofStrip}"`,
    }
  }

  if (/Benefits Over Features in All Copy/i.test(item.actionItem)) {
    return {
      summary: 'The page currently leans more on the offer and service category than on the buyer outcome.',
      evidence: `Headline/context detected: "${heading}"`,
      instruction: 'Rewrite the opening copy so it spells out the real-world result the customer gets, not just the category of service being sold.',
      example: `Example angle: "${serviceContext.outcomeLine}"`,
    }
  }

  if (/Short Form with 5 Fields Maximum|Short Form with 3 to 5 Fields/i.test(item.actionItem)) {
    return {
      summary: 'The quote journey looks heavier than it needs to be for a high-intent service page.',
      evidence: signals.topForm ? `Top visible form appears to ask for ${signals.topForm.fieldCount} fields.` : 'No short high-intent form was detected above the fold.',
      instruction: 'Keep the first conversion step short and gather deeper qualification later so more visitors start the quote process.',
      example: 'Start with: name / phone / suburb / property type / preferred installation timing',
    }
  }

  if (/Message Match Between Ad and Landing Page/i.test(item.actionItem)) {
    return {
      summary: 'The page could do a better job of matching the exact commercial intent a searcher likely had when landing here.',
      evidence: `Current title/headline framing: "${heading}"`,
      instruction: 'Tighten the headline and supporting copy so they directly reflect the search reason ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â installation, pricing, trust, or offer value.',
      example: `Example approach: "${serviceContext.intentMatchLine}"`,
    }
  }

  return {
    summary: item.rationale,
    evidence: 'This recommendation comes from the checklist detector for this page type and the live page scan.',
    instruction: item.recommendation,
    example: item.exampleReferences[0] ? `Reference pattern: ${item.exampleReferences[0]}` : '',
  }
}

function getPrimaryCtaLabel(signals) {
  return signals.primaryCtas[0]?.text || signals.ctas[0]?.text || 'main CTA'
}

function describePageContext(snapshot, signals) {
  if (snapshot.pageType === 'service') return 'a service page'
  if (snapshot.pageType === 'pricing') return 'a pricing page'
  if (snapshot.pageType === 'landing') return 'a landing page'
  if (snapshot.pageType === 'demo') return 'a demo page'
  if (signals.hasUrgency || signals.hasGuarantee) return 'a decision-stage page'
  return 'this page'
}

function inferServiceContext(snapshot) {
  const title = snapshot.title || ''
  const body = snapshot.bodyText.toLowerCase()
  const isHeatPump = /heat pump/.test(`${title} ${body}`)
  const locationMatch = title.match(/\bin ([A-Z][a-zA-Z\s'-]+)/)
  const location = locationMatch?.[1]?.trim() || 'your area'

  if (isHeatPump) {
    return {
      installerTrustLine: 'NZ-certified installers',
      problemLine: `${location} winters are expensive and uncomfortable when the heating setup is wrong. Show that problem first, then explain how this installation offer cuts running costs and improves comfort.`,
      outcomeLine: `A warmer home, lower running costs, and more confidence choosing an installer in ${location}.`,
      proofStrip: '50+ years in business ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· 12,000+ systems installed ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· Fully licensed team',
      intentMatchLine: `Heat pump installation in ${location} with trusted local installers, clearer value, and a stronger reason to request a quote now.`,
    }
  }

  return {
    installerTrustLine: 'trusted local team',
    problemLine: 'Start with the real buyer problem, then bridge into the service offer.',
    outcomeLine: 'A clearer outcome, lower friction, and stronger trust at the point of decision.',
    proofStrip: 'Years in business ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· review rating ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· strong local proof',
    intentMatchLine: 'Make the headline match the exact commercial reason the user searched.',
  }
}

function buildTrustSignalExamples(signals) {
  const parts = []
  if (signals.testimonialMentions > 0) parts.push(`${signals.testimonialMentions} testimonial/review mentions`)
  if (signals.reviewPlatformMentions > 0) parts.push(`${signals.reviewPlatformMentions} review-platform mentions`)
  if (signals.usageStatCount > 0) parts.push(`${signals.usageStatCount} usage/proof stats`)
  if (signals.starRatingVisible) parts.push('a visible star/rating mention')
  return parts.length > 0 ? `Detected trust-proof signals: ${parts.join(', ')}.` : 'Very little visible trust proof was detected near the conversion path.'
}

function getOpeningSignalSnippet(snapshot, signals) {
  const heading = String(signals.firstHeading || '').trim()
  const rendered = String(snapshot.rendered?.visibleText || '')
  const rawBody = String(snapshot.bodyText || '')
  const topBanner = String(snapshot.rendered?.topBannerText || '')
  const navLabelPattern = (signals.navLabels || [])
    .filter(Boolean)
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')

  const sanitize = (value) => {
    let cleaned = String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\b(gtm|googletagmanager|iframe|fbpx|display:none|visibility:hidden|skip to content|cart|menu)\b/gi, '')
      .trim()

    if (topBanner) {
      cleaned = cleaned.replace(topBanner, '')
    }

    if (navLabelPattern) {
      cleaned = cleaned.replace(new RegExp(`\\b(?:${navLabelPattern})\\b`, 'gi'), '')
    }

    if (heading) {
      cleaned = cleaned.replace(heading, '')
    }

    return cleaned
      .replace(/\s{2,}/g, ' ')
      .replace(/^[|:;,\-ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â\s]+/, '')
      .trim()
  }

  const extractAfterHeading = (value) => {
    if (!heading || !value) return ''
    const index = value.toLowerCase().indexOf(heading.toLowerCase())
    if (index < 0) return ''
    return value.slice(index + heading.length)
  }

  const renderedClean = sanitize(extractAfterHeading(rendered) || rendered)
  const bodyClean = sanitize(extractAfterHeading(rawBody) || rawBody)
  const candidates = [renderedClean, bodyClean].filter(Boolean)
  const best = candidates.find((item) => item.split(/\s+/).length >= 10) || candidates[0] || heading || 'Opening copy was not extracted cleanly from the page.'

  const sentenceMatch = best.match(/(.{40,260}?[.!?])(?:\s|$)/)
  return (sentenceMatch?.[1] || best.slice(0, 240)).trim()
}

function buildCroStrengths(checklistResults) {
  return checklistResults
    .filter((item) => item.applicable && item.detectorMode === 'automated' && item.state === 'found')
    .sort((left, right) => right.maxPoints - left.maxPoints)
    .slice(0, 8)
}

function buildCroMetrics(snapshot, signals, checklistResults, clarity) {
  const applicableAutomated = checklistResults.filter((item) => item.applicable && item.detectorMode === 'automated')
  return [
    { label: 'Page type', value: snapshot.pageType, hint: 'Detected from URL, copy, and layout signals.' },
    { label: 'Primary CTAs', value: String(signals.primaryCtas.length), hint: 'Strong CTA elements detected on the page.' },
    { label: 'Social proof signals', value: String(Math.max(signals.testimonialMentions, signals.reviewPlatformMentions)), hint: 'Testimonials, ratings, or trust mentions detected.' },
    { label: 'Automated checks', value: String(applicableAutomated.length), hint: 'Checklist items the scan could verify automatically.' },
    { label: 'Quick wins', value: String(checklistResults.filter((item) => item.applicable && item.detectorMode === 'automated' && item.state !== 'found' && item.impact === 'High' && item.effort === 'Low').length), hint: 'High-impact, low-effort CRO items still open on this page.' },
    ...(clarity?.matched ? [
      { label: 'Clarity friction', value: String(clarity.frictionScore) + '/100', hint: 'Behavioral health based on rage clicks, dead clicks, quickbacks, and scroll depth.' },
      { label: 'Clarity sessions', value: String(clarity.sessions), hint: 'Recent Clarity sessions for this URL over the last 3 days.' },
    ] : []),
  ]
}

function buildFeatureSnapshot(signals, clarity) {
  return [
    { label: 'Hero clarity', state: signals.firstHeading ? 'found' : 'missing' },
    { label: 'CTA clarity', state: signals.primaryCtas.length > 0 ? 'found' : 'missing' },
    { label: 'Trust signals', state: signals.hasTrustAboveFold || signals.testimonialMentions > 0 ? 'found' : 'partial' },
    { label: 'Pricing signals', state: signals.hasPricingMatrix || signals.hasPricingToggle ? 'found' : 'missing' },
    { label: 'FAQ support', state: signals.hasFaq ? 'found' : 'missing' },
    { label: 'Form friction', state: signals.shortForm ? 'found' : 'partial' },
    ...(clarity?.matched ? [{ label: 'Behavioral friction', state: clarity.frictionScore >= 70 ? 'found' : clarity.frictionScore >= 50 ? 'partial' : 'missing' }] : []),
  ]
}

function buildCroComparison(primary, competitors) {
  const allPages = [primary, ...competitors]
  const categoryNames = [...new Set(allPages.flatMap((page) => page.categoryScores.map((category) => category.category)))]

  return {
    scoreComparison: allPages.map((page, index) => ({
      label: index === 0 ? 'Your page' : `Competitor ${index}`,
      url: page.url,
      score: page.score,
      grade: page.grade,
      quickWins: page.quickWins.length,
    })),
    clarityComparison: allPages
      .filter((page) => page.clarity?.matched)
      .map((page, index) => ({
        label: index === 0 ? 'Your page' : `Competitor ${index}`,
        url: page.url,
        frictionScore: page.clarity.frictionScore,
        frictionGrade: page.clarity.frictionGrade,
        sessions: page.clarity.sessions,
        rageClicks: page.clarity.rageClicks,
        deadClicks: page.clarity.deadClicks,
        quickbacks: page.clarity.quickbacks,
        scrollDepth: page.clarity.scrollDepth,
      })),
    categoryComparison: categoryNames.map((category) => ({
      category,
      scores: allPages.map((page, index) => ({
        label: index === 0 ? 'Your page' : `Competitor ${index}`,
        score: page.categoryScores.find((item) => item.category === category)?.score ?? 0,
      })),
    })),
    featureComparison: buildFeatureComparison(primary, competitors),
  }
}

function buildFeatureComparison(primary, competitors) {
  const competitorFeatures = competitors.map((page, index) => ({
    label: `Competitor ${index + 1}`,
    features: page.featureSnapshot,
  }))

  return primary.featureSnapshot.map((feature) => ({
    label: feature.label,
    primary: feature.state,
    competitors: competitorFeatures.map((page) => ({
      label: page.label,
      state: page.features.find((item) => item.label === feature.label)?.state ?? 'missing',
    })),
  }))
}

const CHECKLIST_MODE_CONFIG = {
  auto: { id: 'auto', label: 'Auto', areas: null, description: 'Automatically choose the closest checklist area for the page type.' },
  homepage: { id: 'homepage', label: 'Homepage', areas: ['Homepage'], description: 'Use the homepage items from the checklist.' },
  pricing: { id: 'pricing', label: 'Pricing Page', areas: ['Pricing Page'], description: 'Use the pricing-page items from the checklist.' },
  product: { id: 'product', label: 'Product Page', areas: ['Product Page'], description: 'Use the product-page items from the checklist.' },
  blog: { id: 'blog', label: 'Blog Page', areas: ['Blog Page'], description: 'Use the blog-page items from the checklist.' },
  demo: { id: 'demo', label: 'Demo Page', areas: ['Demo Page'], description: 'Use the demo-page items from the checklist.' },
  landing: { id: 'landing', label: 'Landing Page', areas: ['Landing Page'], description: 'Use the landing-page items from the checklist.' },
  template: { id: 'template', label: 'Template Page', areas: ['Template Page'], description: 'Use the template-page items from the checklist.' },
  service: {
    id: 'service',
    label: 'Service Page',
    areas: ['Homepage', 'Landing Page', 'Demo Page'],
    description: 'Use the closest checklist mix for service-business pages: homepage clarity, landing-page conversion focus, and demo-page trust/form checks.',
  },
}

function getApplicableAreas(pageType, resolvedChecklistMode) {
  const areas = new Set(['Site Wide'])
  if (resolvedChecklistMode?.areas?.length) {
    for (const area of resolvedChecklistMode.areas) {
      areas.add(area)
    }
    return areas
  }

  if (pageType === 'homepage') areas.add('Homepage')
  if (pageType === 'service') {
    areas.add('Homepage')
    areas.add('Landing Page')
    areas.add('Demo Page')
  }
  if (pageType === 'pricing') areas.add('Pricing Page')
  if (pageType === 'product') areas.add('Product Page')
  if (pageType === 'blog') areas.add('Blog Page')
  if (pageType === 'demo') areas.add('Demo Page')
  if (pageType === 'landing') areas.add('Landing Page')
  if (pageType === 'template') areas.add('Template Page')
  return areas
}

function resolveChecklistMode(pageType, requestedMode) {
  const normalizedMode = String(requestedMode ?? 'auto').trim().toLowerCase()
  if (normalizedMode && normalizedMode !== 'auto' && CHECKLIST_MODE_CONFIG[normalizedMode]) {
    return CHECKLIST_MODE_CONFIG[normalizedMode]
  }

  if (pageType === 'service') return CHECKLIST_MODE_CONFIG.service
  if (pageType === 'homepage') return CHECKLIST_MODE_CONFIG.homepage
  if (pageType === 'pricing') return CHECKLIST_MODE_CONFIG.pricing
  if (pageType === 'product') return CHECKLIST_MODE_CONFIG.product
  if (pageType === 'blog') return CHECKLIST_MODE_CONFIG.blog
  if (pageType === 'demo') return CHECKLIST_MODE_CONFIG.demo
  if (pageType === 'landing') return CHECKLIST_MODE_CONFIG.landing
  if (pageType === 'template') return CHECKLIST_MODE_CONFIG.template

  return CHECKLIST_MODE_CONFIG.homepage
}

function inferCroPageType(parsedUrl, title, bodyText, rendered) {
  const path = parsedUrl.pathname.toLowerCase()
  const combined = `${path} ${title} ${bodyText.slice(0, 2000)}`.toLowerCase()
  if (path === '/' || path === '') return 'homepage'
  if (/pricing|plans/.test(combined)) return 'pricing'
  if (
    /install|installation|repair|service|services|maintenance|book now|request a quote|free quote|free assessment|licensed team|call us|heat pump/i.test(combined) &&
    !/blog|article|guide|resources|news/.test(path)
  ) return 'service'
  if (/blog|article|guide|resources|news/.test(path) || (/blog|article|guide|resources|news/.test(combined) && /author|published|read more|related articles|table of contents/i.test(combined))) return 'blog'
  if (/demo|contact-sales|book-a-demo|contact/.test(combined)) return 'demo'
  if (/template/.test(combined)) return 'template'
  if (/landing|\/lp\/|\/campaign\//.test(combined) || (rendered.forms.length > 0 && rendered.navLabels.length <= 5 && rendered.ctas.length <= 3)) return 'landing'
  if (/feature|product|integration|use case|solution/.test(combined)) return 'product'
  return 'general'
}

function getGrade(score) {
  return GRADE_BANDS.find((item) => score >= item.min)?.grade ?? 'E'
}

function countRegex(text, regex) {
  return String(text ?? '').match(regex)?.length ?? 0
}

function getFirstIndex(text, regex) {
  const match = String(text ?? '').match(regex)
  if (!match || typeof match.index !== 'number') return -1
  return match.index
}

function getBrowserExecutablePath() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? ''
}

function normalizePageArea(value) {
  return value.replace(/\s+/g, ' ').trim() || 'Site Wide'
}

function normalizeImpact(value) {
  if (/high/i.test(value)) return 'High'
  if (/mid/i.test(value)) return 'Mid'
  return 'Low'
}

function normalizeEffort(value) {
  if (/high/i.test(value)) return 'High'
  if (/mid/i.test(value)) return 'Mid'
  return 'Low'
}

function evaluateState({ found, partial, missingReason, partialReason, foundReason, evidence = [], recommendation }) {
  if (found) return { state: 'found', rationale: foundReason, evidence, recommendation }
  if (partial) return { state: 'partial', rationale: partialReason, evidence, recommendation }
  return { state: 'missing', rationale: missingReason, evidence, recommendation }
}

function heroHeadlineDetector(_snapshot, signals) {
  return evaluateState({
    found: Boolean(signals.firstHeading) && signals.firstHeading.length >= 10,
    partial: signals.firstHeading.length > 0,
    foundReason: `A visible hero heading was detected: "${signals.firstHeading}".`,
    partialReason: 'The page has a top headline, but it may still be too short or too vague as a USP.',
    missingReason: 'No strong hero headline was detected near the top of the page.',
    evidence: signals.firstHeading ? [signals.firstHeading] : [],
    recommendation: 'Use a clear hero headline that states the core value proposition in plain language.',
  })
}

function subheadlineDetector(_snapshot, signals) {
  const hasSubheadline = signals.wordCount > 80 && /for |help|without|so you can|that lets you|used by/.test(`${signals.headingTexts} ${signals.firstHeading}`)
  return evaluateState({
    found: hasSubheadline,
    partial: signals.wordCount > 40,
    foundReason: 'The opening copy includes supporting context beyond the headline.',
    partialReason: 'There is supporting copy, but it does not clearly sharpen the ICP or offer.',
    missingReason: 'No clear supporting subheadline was detected near the opening section.',
    recommendation: 'Add a short subheadline that clarifies who the page is for and why the offer matters.',
  })
}

function primaryCtaAboveFoldDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.strongAboveFoldCtas.length >= 1,
    partial: signals.aboveFoldCtas.length >= 1,
    foundReason: `A strong CTA is visible above the fold: "${signals.strongAboveFoldCtas[0]?.text ?? ''}".`,
    partialReason: 'A CTA is present above the fold, but it is generic or visually weak.',
    missingReason: 'No clear, high-intent CTA was detected above the fold.',
    evidence: signals.strongAboveFoldCtas.slice(0, 2).map((item) => item.text),
    recommendation: 'Place one strong primary CTA above the fold with direct, action-oriented copy.',
  })
}

function productVisualDetector(snapshot, signals) {
  return evaluateState({
    found: signals.largeTopImages.length >= 1,
    partial: snapshot.images.length >= 1,
    foundReason: 'A large visual asset appears near the top of the page.',
    partialReason: 'Images are present, but no strong product-style visual is clearly featured near the top.',
    missingReason: 'No strong product or preview visual was detected near the top of the page.',
    evidence: signals.largeTopImages.slice(0, 2).map((item) => item.alt || item.src),
    recommendation: 'Add a clear screenshot, UI preview, or other product visual near the opening section.',
  })
}

function videoDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.videoAboveFold,
    partial: false,
    foundReason: 'A video or embedded demo appears near the top of the page.',
    partialReason: '',
    missingReason: 'No demo or testimonial video was detected in the upper page area.',
    recommendation: 'Add a short demo or testimonial video where it can support the buying decision early.',
  })
}

function trustAboveFoldDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasTrustAboveFold || signals.topLogoBar || signals.reviewPlatformMentions > 0,
    partial: signals.testimonialMentions > 0,
    foundReason: 'Trust signals such as logos, ratings, or social proof are visible near the top of the page.',
    partialReason: 'Trust language is present, but it is not clearly surfaced above the fold.',
    missingReason: 'No strong trust signals were detected near the top section.',
    recommendation: 'Surface logos, ratings, usage stats, or review badges near the first CTA.',
  })
}

function testimonialDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.testimonialMentions >= 3,
    partial: signals.testimonialMentions >= 1,
    foundReason: 'Multiple testimonial or customer-result signals were detected.',
    partialReason: 'Some testimonial language is present, but the page could use stronger outcome-driven proof.',
    missingReason: 'No clear testimonial or customer result blocks were detected.',
    recommendation: 'Add testimonials that reference specific, measurable outcomes.',
  })
}

function secondaryCtaDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.primaryCtas.length >= 1 && signals.secondaryCtas.length >= 1,
    partial: signals.primaryCtas.length >= 1,
    foundReason: 'The page shows both a primary CTA and a lower-commitment secondary CTA.',
    partialReason: 'A primary CTA is present, but there is no clear secondary conversion path.',
    missingReason: 'No strong CTA pairing was detected.',
    recommendation: 'Pair the main CTA with a lower-friction secondary action such as a video or tour.',
  })
}

function stickyCtaDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasStickyCta,
    partial: signals.aboveFoldCtas.length >= 1,
    foundReason: 'A sticky or persistent CTA/navigation element was detected.',
    partialReason: 'CTAs exist, but none appear to stay visible while users move down the page.',
    missingReason: 'No sticky CTA or persistent CTA-supporting navigation was detected.',
    recommendation: 'Use a sticky header or bottom CTA so the next step stays accessible during scroll.',
  })
}

function benefitHeadlineDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.benefitHeadings > signals.featureHeadings,
    partial: signals.benefitHeadings >= 1,
    foundReason: 'The page uses more benefit-led headings than feature-label headings.',
    partialReason: 'Some benefit language is present, but feature naming still dominates the messaging.',
    missingReason: 'The page appears more feature-led than benefit-led.',
    recommendation: 'Rewrite key headings to emphasize outcomes and buyer value rather than internal feature labels.',
  })
}

function objectionHandlingDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasObjectionHandling,
    partial: false,
    foundReason: 'The page includes language that addresses common objections such as setup, security, or trial friction.',
    partialReason: '',
    missingReason: 'No obvious objection-handling strip or reassurance messaging was detected.',
    recommendation: 'Address common conversion blockers like setup time, pricing risk, migration, or security directly in the copy.',
  })
}

function finalCtaDetector(snapshot, signals) {
  const lowerCtas = signals.ctas.filter((item) => item.rect.top > snapshot.rendered.viewportHeight * 1.6)
  return evaluateState({
    found: lowerCtas.length >= 1,
    partial: signals.ctas.length >= 1,
    foundReason: 'A CTA is present deeper on the page for visitors who scroll.',
    partialReason: 'CTAs exist, but there is no obvious closing CTA section lower on the page.',
    missingReason: 'No later-page CTA block was detected.',
    recommendation: 'Restate the value proposition near the end of the page and repeat the CTA there.',
  })
}

function ctaContrastDetector(_snapshot, signals) {
  const standout = signals.primaryCtas.some((item) => !/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/i.test(item.background))
  return evaluateState({
    found: standout,
    partial: signals.primaryCtas.length >= 1,
    foundReason: 'At least one primary CTA uses a visible filled treatment instead of a neutral text-link style.',
    partialReason: 'Primary CTAs exist, but they may not stand out strongly enough visually.',
    missingReason: 'No visually prominent primary CTA style was detected.',
    recommendation: 'Use a visually distinct CTA color and treatment so the main action stands out instantly.',
  })
}

function microcopyDetector(_snapshot, signals) {
  return evaluateState({
    found: /(no credit card|cancel anytime|setup in|takes \d+ minutes|free trial|free to start)/i.test(`${signals.headingTexts} ${signals.firstHeading} ${signals.ctas.map((item) => item.text).join(' ')}`),
    partial: false,
    foundReason: 'CTA-adjacent reassurance language was detected.',
    partialReason: '',
    missingReason: 'No obvious CTA reassurance micro-copy was detected.',
    recommendation: 'Add short micro-copy beneath CTAs to reduce friction at the decision point.',
  })
}

function reviewBadgeDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.reviewPlatformMentions >= 1,
    partial: signals.starRatingVisible,
    foundReason: 'Review-platform language such as G2 or Capterra is visible on the page.',
    partialReason: 'A rating signal is visible, but named review-platform evidence is weaker.',
    missingReason: 'No review-platform badges or review widget signals were detected.',
    recommendation: 'Surface recent G2, Capterra, or other earned review badges where buying intent is strongest.',
  })
}

function starRatingDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.starRatingVisible,
    partial: false,
    foundReason: 'A star rating or numeric review score was detected on the page.',
    partialReason: '',
    missingReason: 'No star rating or numeric review score was detected.',
    recommendation: 'Add a visible, crawlable rating next to key CTAs or trust blocks.',
  })
}

function announcementBannerDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasAnnouncementBanner,
    partial: false,
    foundReason: 'A top-of-page banner or announcement strip is visible.',
    partialReason: '',
    missingReason: 'No announcement banner was detected at the top of the page.',
    recommendation: 'Use a top banner for launches, promotions, or campaign-specific messages when relevant.',
  })
}

function liveChatDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasLiveChat,
    partial: false,
    foundReason: 'A live chat or chatbot footprint was detected in the page source.',
    partialReason: '',
    missingReason: 'No live chat or chatbot signal was detected.',
    recommendation: 'Add live chat or an AI chat layer to key high-intent pages.',
  })
}

function exitIntentDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasExitIntent,
    partial: false,
    foundReason: 'Exit-intent style script signals were detected.',
    partialReason: '',
    missingReason: 'No exit-intent or leave-triggered offer signal was detected.',
    recommendation: 'Use a targeted exit-intent offer where it genuinely helps recover abandoning users.',
  })
}

function custom404Detector(snapshot) {
  const is404 = /\b404\b|page not found/i.test(`${snapshot.title} ${snapshot.bodyText}`)
  return evaluateState({
    found: is404 && /search|home|contact|demo|pricing/i.test(snapshot.bodyText),
    partial: is404,
    foundReason: 'This 404 page contains recovery paths and CTA-style navigation.',
    partialReason: 'A 404 state is visible, but recovery links and CTAs are limited.',
    missingReason: 'The scanned page is not a 404 page, so this item needs a dedicated 404 URL review.',
    recommendation: 'Review the 404 page directly and add search, key links, and a conversion path.',
  })
}

function pricingHighlightDetector(_snapshot, signals) {
  return evaluateState({
    found: /most popular|recommended|best value/i.test(`${signals.headingTexts} ${signals.firstHeading}`),
    partial: signals.pricingCardCount >= 2,
    foundReason: 'Pricing-card highlight text such as ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“most popularÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â or ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“recommendedÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â was detected.',
    partialReason: 'Pricing plans appear present, but the recommended plan is not clearly highlighted.',
    missingReason: 'No pricing-card highlight was detected.',
    recommendation: 'Highlight the recommended pricing tier visually to reduce choice friction.',
  })
}

function pricingToggleDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasPricingToggle,
    partial: signals.pricingCardCount >= 2,
    foundReason: 'Monthly/annual pricing or savings-toggle language was detected.',
    partialReason: 'Multiple pricing plans appear present, but no clear billing toggle or savings message was found.',
    missingReason: 'No billing toggle or savings language was detected.',
    recommendation: 'Show monthly and annual pricing with clear savings messaging.',
  })
}

function comparisonTableDetector(snapshot, signals) {
  return evaluateState({
    found: signals.hasPricingMatrix || snapshot.tables > 0 || snapshot.rendered.tables.length > 0,
    partial: false,
    foundReason: 'A table or matrix format is present that can support comparison-driven decisions.',
    partialReason: '',
    missingReason: 'No comparison matrix or scannable table structure was detected.',
    recommendation: 'Add a comparison table or feature matrix to support faster evaluation.',
  })
}

function guaranteeDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasGuarantee,
    partial: false,
    foundReason: 'Guarantee, trial, or risk-reduction terms were detected on the page.',
    partialReason: '',
    missingReason: 'No clear guarantee or trial terms were detected.',
    recommendation: 'State your trial or guarantee terms plainly to reduce purchase anxiety.',
  })
}

function salesRepDetector(snapshot, _signals) {
  return evaluateState({
    found: /contact sales|talk to sales|meet/.test(snapshot.bodyText) && snapshot.images.length >= 1,
    partial: /contact sales|talk to sales/i.test(snapshot.bodyText),
    foundReason: 'Sales-contact language appears alongside imagery that likely humanizes the enterprise CTA area.',
    partialReason: 'Sales-contact language is present, but no obvious humanizing rep block was detected.',
    missingReason: 'No enterprise sales rep block was detected.',
    recommendation: 'Pair enterprise/contact-sales CTAs with a named person, photo, and title when relevant.',
  })
}

function roiDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasRoiSection,
    partial: false,
    foundReason: 'ROI or savings language was detected on the page.',
    partialReason: '',
    missingReason: 'No ROI or measurable value justification block was detected.',
    recommendation: 'Add an ROI section or outcomes block to justify the business case.',
  })
}

function calculatorDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasCalculator,
    partial: false,
    foundReason: 'Calculator or estimate language was detected.',
    partialReason: '',
    missingReason: 'No pricing or ROI calculator signal was detected.',
    recommendation: 'Add a calculator when pricing or ROI depends on usage, seats, or scenario inputs.',
  })
}

function planDescriptorDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasPlanDescriptors,
    partial: signals.pricingCardCount >= 2,
    foundReason: 'Plan descriptors such as ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“best forÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â were detected on the page.',
    partialReason: 'Pricing plans appear present, but descriptors are not clearly visible.',
    missingReason: 'No plan-descriptor language was detected.',
    recommendation: 'Describe who each plan is for so buyers can self-select more quickly.',
  })
}

function urgencyDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasUrgency,
    partial: false,
    foundReason: 'Real urgency or deadline language was detected.',
    partialReason: '',
    missingReason: 'No clear urgency or deadline language was detected.',
    recommendation: 'Use genuine deadline language only when you have a real promotion or timing reason.',
  })
}

function annotatedVisualDetector(snapshot, signals) {
  return evaluateState({
    found: signals.largeTopImages.length >= 1 && /dashboard|feature|workflow|product|template/i.test(snapshot.bodyText),
    partial: signals.largeTopImages.length >= 1,
    foundReason: 'Strong visual coverage is present and appears tied to product or template context.',
    partialReason: 'Visuals are present, but the page could use clearer labeled screenshots or GIFs.',
    missingReason: 'No strong annotated visual support was detected.',
    recommendation: 'Use labeled screenshots, GIFs, or preview visuals that explain what the visitor is seeing.',
  })
}

function painFirstDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasPainFirst,
    partial: signals.hasObjectionHandling,
    foundReason: 'The copy introduces the user problem before moving into the solution.',
    partialReason: 'The copy addresses some friction points, but the problem-to-solution narrative is not clear.',
    missingReason: 'The page appears solution-led without first grounding the buyer problem.',
    recommendation: 'Lead with the buyer pain and consequences before explaining the product or offer.',
  })
}

function beforeAfterDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasBeforeAfter,
    partial: false,
    foundReason: 'Before/after transformation language was detected on the page.',
    partialReason: '',
    missingReason: 'No clear before/after comparison block or transformation language was detected.',
    recommendation: 'Use a before/after block to make the value transition concrete.',
  })
}

function microBenefitsDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.integrationMentions >= 2,
    partial: signals.integrationMentions >= 1,
    foundReason: 'Secondary benefits and integrations are called out in the copy.',
    partialReason: 'Some supporting benefits are present, but they are not strongly developed.',
    missingReason: 'No strong secondary-benefit language was detected.',
    recommendation: 'Add short supporting benefits beneath feature headlines to deepen the value story.',
  })
}

function stickySideNavDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasToc || signals.hasStickyCta,
    partial: signals.navLabels.length >= 4,
    foundReason: 'A sticky navigation or anchor-jump structure appears to be present.',
    partialReason: 'Navigation exists, but there is no clear anchor support for long-form reading.',
    missingReason: 'No sticky side nav or table-of-contents style support was detected.',
    recommendation: 'Use sticky side navigation or anchor jumps on longer pages.',
  })
}

function caseStudyDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasCaseStudy,
    partial: signals.testimonialMentions >= 1,
    foundReason: 'Case study or customer-story language was detected.',
    partialReason: 'Testimonials are present, but dedicated case study support looks limited.',
    missingReason: 'No case study or customer-story content was detected.',
    recommendation: 'Add case study cards or links with a result, customer, and use case.',
  })
}

function integrationsDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasIntegrations && signals.integrationMentions >= 2,
    partial: signals.hasIntegrations,
    foundReason: 'The page visibly calls out integrations or connected tools.',
    partialReason: 'Integration language is present, but the coverage is thin.',
    missingReason: 'No integration section or named integration support was detected.',
    recommendation: 'List major integrations by name and explain the benefit of each connection.',
  })
}

function faqDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasFaq,
    partial: false,
    foundReason: 'An FAQ or question-driven support section was detected.',
    partialReason: '',
    missingReason: 'No FAQ support section was detected.',
    recommendation: 'Add FAQs that answer setup, pricing, security, or feature objections directly.',
  })
}

function usageStatsDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.usageStatCount >= 1,
    partial: signals.numericClaims >= 2,
    foundReason: 'Concrete usage or trust stats were detected on the page.',
    partialReason: 'Numeric claims are present, but they do not clearly function as usage proof near conversion moments.',
    missingReason: 'No strong usage statistics or concrete proof numbers were detected.',
    recommendation: 'Add specific usage or result numbers that reinforce trust and performance claims.',
  })
}

function articleStructureDetector(_snapshot, signals) {
  return evaluateState({
    found: (signals.averageParagraphWords <= 60 && signals.hasToc) || signals.benefitHeadings >= 2,
    partial: signals.averageParagraphWords <= 90,
    foundReason: 'The page structure looks scannable, with shorter copy blocks and navigation or heading support.',
    partialReason: 'The page has some scannability, but the structure could be easier to skim.',
    missingReason: 'The page structure reads densely and may be harder to scan.',
    recommendation: 'Use shorter paragraphs, clearer heading cadence, and bulleting to support scanning behavior.',
  })
}

function keyTakeawaysDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasKeyTakeaways,
    partial: false,
    foundReason: 'A key-takeaways or ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“what youÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ll learnÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â style box was detected.',
    partialReason: '',
    missingReason: 'No key-takeaways box was detected near the top of the content.',
    recommendation: 'Add a short takeaways box near the top so readers know what value to expect.',
  })
}

function inlineCtaDetector(snapshot, signals) {
  const lowerInlineCtas = signals.ctas.filter((item) => item.rect.top > snapshot.rendered.viewportHeight && CTA_STRONG_TERMS.test(item.text))
  return evaluateState({
    found: lowerInlineCtas.length >= 2,
    partial: lowerInlineCtas.length >= 1 || signals.hasStickyCta,
    foundReason: 'Multiple CTAs appear deeper inside the content flow.',
    partialReason: 'Some mid-content CTA support is present, but it is limited.',
    missingReason: 'No meaningful mid-content or sticky CTA support was detected.',
    recommendation: 'Place contextual CTAs at natural breakpoints so the page can convert without waiting for the footer.',
  })
}

function compactHeaderDetector(_snapshot, signals) {
  const hasMassiveHeroImage = signals.topImages.some((item) => item.rect.height > 360)
  return evaluateState({
    found: !hasMassiveHeroImage,
    partial: signals.topImages.length >= 1,
    foundReason: 'The opening visual treatment is compact enough that content can surface quickly.',
    partialReason: 'Header imagery exists, but it may still take up more vertical space than ideal.',
    missingReason: 'A very tall hero image appears to dominate the first fold.',
    recommendation: 'Keep header visuals compact on content pages so users reach substance quickly.',
  })
}

function authorDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasAuthorBox,
    partial: false,
    foundReason: 'Author or reviewer attribution signals were detected.',
    partialReason: '',
    missingReason: 'No author attribution or credentials box was detected.',
    recommendation: 'Add visible author attribution with a name, role, and simple credential or context.',
  })
}

function tipsDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasTipsBoxes,
    partial: false,
    foundReason: 'Tip or highlight callout language was detected.',
    partialReason: '',
    missingReason: 'No pro-tip or standout highlight box language was detected.',
    recommendation: 'Use callout boxes to surface important insights and break up dense sections.',
  })
}

function expertPicksDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasExpertPicks,
    partial: false,
    foundReason: 'Expert pick or recommendation language was detected.',
    partialReason: '',
    missingReason: 'No expert recommendation or expert-pick signal was detected.',
    recommendation: 'Add expert picks or recommendation boxes where readers are choosing between options.',
  })
}

function reviewLayoutDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasFaq && signals.hasPricingMatrix,
    partial: signals.hasPricingMatrix || signals.hasFaq,
    foundReason: 'The page has both scannable comparison structure and objection/support sections, which suits review-style layouts.',
    partialReason: 'Some review-layout ingredients are present, but the full evaluation structure is incomplete.',
    missingReason: 'No clear software review or roundup layout structure was detected.',
    recommendation: 'Use summary cards, pros/cons, pricing, and comparison structure for review-style content.',
  })
}

function referencesDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasReferences,
    partial: false,
    foundReason: 'References or sources language was detected.',
    partialReason: '',
    missingReason: 'No references or source section was detected.',
    recommendation: 'Add a references section where claims or comparison points need source support.',
  })
}

function contentUpgradeDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.contentUpgrade,
    partial: false,
    foundReason: 'Downloadable or upgrade-style content offer language was detected.',
    partialReason: '',
    missingReason: 'No downloadable content upgrade or resource offer was detected.',
    recommendation: 'Add a content upgrade that matches the page topic and buying stage.',
  })
}

function freshnessDetector(snapshot) {
  return evaluateState({
    found: /(last updated|updated|published)/i.test(snapshot.bodyText),
    partial: false,
    foundReason: 'A publish or update date was detected on the page.',
    partialReason: '',
    missingReason: 'No visible freshness date was detected.',
    recommendation: 'Show a publish or update date to reinforce freshness where content recency matters.',
  })
}

function socialShareDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasSocialShare,
    partial: false,
    foundReason: 'Social sharing links or labels were detected.',
    partialReason: '',
    missingReason: 'No social sharing block was detected.',
    recommendation: 'Add relevant social sharing where content distribution matters, especially for blog pages.',
  })
}

function relatedArticlesDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasRelatedArticles,
    partial: false,
    foundReason: 'Related-content or read-next support was detected.',
    partialReason: '',
    missingReason: 'No related-articles block was detected.',
    recommendation: 'Use related content to keep users moving through the funnel after consuming the current page.',
  })
}

function distractionFreeDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.distractionFree,
    partial: signals.navLabels.length <= 8,
    foundReason: 'The page appears relatively distraction-free, with limited navigation options.',
    partialReason: 'The page is somewhat constrained, but still includes several exit paths.',
    missingReason: 'The page still appears to have a full navigation experience rather than a focused conversion path.',
    recommendation: 'Reduce navigation and extraneous exits on high-intent demo or landing pages.',
  })
}

function shortFormDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.shortForm,
    partial: signals.topForm ? signals.topForm.fieldCount <= 7 : false,
    foundReason: `A short form was detected with ${signals.topForm?.fieldCount ?? 'a limited number of'} fields.`,
    partialReason: 'A form is present, but it may still ask for more fields than ideal.',
    missingReason: 'No short high-intent form was detected.',
    recommendation: 'Keep key forms short and capture additional qualification later where possible.',
  })
}

function valueBulletsDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasValueBullets || signals.hasTimeline,
    partial: false,
    foundReason: 'Value bullets or next-step expectation language was detected near the conversion flow.',
    partialReason: '',
    missingReason: 'No strong value bullets or what-happens-next explanation was detected around the form area.',
    recommendation: 'Add short bullets beside the form explaining what the user gets and what happens next.',
  })
}

function calendarDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasInlineCalendar,
    partial: false,
    foundReason: 'Calendar-booking language or tooling was detected.',
    partialReason: '',
    missingReason: 'No inline calendar or immediate scheduling support was detected.',
    recommendation: 'Use inline calendar booking on demo pages to remove scheduling friction.',
  })
}

function testimonialQualityDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.testimonialMentions >= 3 && signals.recognisableBrands.length >= 1,
    partial: signals.testimonialMentions >= 1,
    foundReason: 'Testimonials appear present and anchored by recognisable brand or result cues.',
    partialReason: 'Testimonials exist, but they do not appear richly structured or strongly objection-mapped.',
    missingReason: 'No strong testimonial quality signals were detected.',
    recommendation: 'Use testimonials with real names, roles, companies, and outcome specifics.',
  })
}

function mediaMentionsDetector(_snapshot, signals) {
  return evaluateState({
    found: /as seen in|featured in|mentioned in/.test(`${signals.headingTexts} ${signals.firstHeading} ${signals.navLabels.join(' ')}`),
    partial: false,
    foundReason: 'Media mention language was detected on the page.',
    partialReason: '',
    missingReason: 'No media mention bar or ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“as seen inÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â signal was detected.',
    recommendation: 'Add earned media mentions or authority logos where relevant and truthful.',
  })
}

function onePrimaryCtaDetector(_snapshot, signals) {
  const uniqueStrongCtas = [...new Set(signals.primaryCtas.map((item) => item.text.toLowerCase()))]
  return evaluateState({
    found: uniqueStrongCtas.length === 1 && signals.primaryCtas.length >= 1,
    partial: uniqueStrongCtas.length <= 2 && signals.primaryCtas.length >= 1,
    foundReason: 'The page appears to center one dominant primary CTA.',
    partialReason: 'The page has CTAs, but the primary path may compete with another action.',
    missingReason: 'No clear dominant primary CTA was detected.',
    recommendation: 'Keep one CTA visually dominant on each page so the next step is unmistakable.',
  })
}

function outcomeCtaDetector(_snapshot, signals) {
  const outcomeCta = signals.ctas.find((item) => /(book a demo|get demo|start free|start trial|get started|get my|see .* in action|watch tour)/i.test(item.text))
  return evaluateState({
    found: Boolean(outcomeCta),
    partial: signals.ctas.length > 0,
    foundReason: `Outcome-oriented CTA copy was detected: "${outcomeCta?.text ?? ''}".`,
    partialReason: 'CTAs exist, but the copy is more generic than outcome-oriented.',
    missingReason: 'No strong outcome-oriented CTA copy was detected.',
    recommendation: 'Use CTA labels that describe the result or next step, not generic words like ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“SubmitÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â.',
  })
}

function messageMatchDetector(snapshot, signals) {
  return evaluateState({
    found: signals.hasMessageMatchSignals,
    partial: /for |best |compare|vs /i.test(snapshot.title),
    foundReason: 'The page title suggests a targeted query or campaign match.',
    partialReason: 'There is some query-language in the title, but the match looks only partial.',
    missingReason: 'The page does not clearly signal a specific campaign or query match from the page itself.',
    recommendation: 'Align the headline and page framing tightly with the traffic source or campaign promise.',
  })
}

function segmentSocialProofDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.recognisableBrands.length >= 1 && signals.testimonialMentions >= 1,
    partial: signals.testimonialMentions >= 1,
    foundReason: 'The page includes customer proof and named brand/context signals that can help audience match.',
    partialReason: 'Social proof exists, but it is not obviously segmented to the target audience.',
    missingReason: 'No strong audience-matched social proof signal was detected.',
    recommendation: 'Match testimonials, logos, and examples to the audience segment the page is targeting.',
  })
}

function heatmapDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.hasHeatmapScript,
    partial: false,
    foundReason: 'Heatmap or session-recording tooling appears to be installed.',
    partialReason: '',
    missingReason: 'No Hotjar, Clarity, FullStory, or similar script was detected.',
    recommendation: 'Install behavior analytics on landing pages so CRO changes can be guided by actual behavior.',
  })
}

function voiceOfCustomerDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.testimonialMentions >= 2 && signals.secondPersonCount >= 6,
    partial: signals.testimonialMentions >= 1,
    foundReason: 'The page combines social proof with direct user-language orientation, which is a decent voice-of-customer signal.',
    partialReason: 'Some customer-oriented language is present, but the page does not strongly reflect buyer phrasing yet.',
    missingReason: 'No strong voice-of-customer language signal was detected on the page.',
    recommendation: 'Use phrases buyers actually use in reviews, interviews, and calls instead of internal product language.',
  })
}

function specificityDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.numericClaims >= 5,
    partial: signals.numericClaims >= 2,
    foundReason: 'The page supports claims with multiple concrete numbers or specifics.',
    partialReason: 'Some specificity is present, but major claims could still be more measurable.',
    missingReason: 'The page relies heavily on generic benefits without enough concrete specifics.',
    recommendation: 'Back up claims with numbers, exact outcomes, and specific proof wherever possible.',
  })
}

function intentAlignmentDetector(snapshot, signals) {
  const aligned =
    (snapshot.pageType === 'pricing' && signals.primaryCtas.some((item) => /demo|trial|start|get/i.test(item.text))) ||
    (snapshot.pageType === 'blog' && (signals.hasToc || signals.hasKeyTakeaways)) ||
    (snapshot.pageType === 'demo' && signals.shortForm)
  return evaluateState({
    found: aligned,
    partial: signals.primaryCtas.length >= 1,
    foundReason: 'The page structure and CTA style appear reasonably aligned with the pageÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢s buying stage.',
    partialReason: 'There are some alignment signals, but the page could match buyer intent more tightly.',
    missingReason: 'The pageÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢s CTA and page type do not strongly reinforce the likely visitor intent.',
    recommendation: 'Align the CTA, offer, and proof with the buyer intent stage the page is meant to serve.',
  })
}

function headlineClarityDetector(_snapshot, signals) {
  const headline = signals.firstHeading || ''
  const headlineWordCount = headline.split(/\s+/).filter(Boolean).length
  return evaluateState({
    found: headlineWordCount >= 4 && headlineWordCount <= 14 && !/synergy|revolutionary|next gen|future of/i.test(headline),
    partial: headlineWordCount > 0,
    foundReason: 'The main headline is reasonably direct and readable.',
    partialReason: 'A headline exists, but it may still be too vague, too short, or too abstract.',
    missingReason: 'No clear headline was available to judge for clarity.',
    recommendation: 'Favor clarity and buyer comprehension over clever phrasing in the main headline.',
  })
}

function secondPersonDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.secondPersonCount >= 8,
    partial: signals.secondPersonCount >= 3,
    foundReason: 'The page uses ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“you/yourÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â language enough to feel reader-oriented.',
    partialReason: 'The page uses some second-person language, but it still feels more brand-centric than buyer-centric.',
    missingReason: 'Very little second-person language was detected.',
    recommendation: 'Write directly to the buyer using ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“youÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â and ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“your teamÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â where it fits naturally.',
  })
}

function socialProofNameDropDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.recognisableBrands.length >= 2,
    partial: signals.recognisableBrands.length >= 1,
    foundReason: `Recognisable company names were detected: ${signals.recognisableBrands.slice(0, 3).join(', ')}.`,
    partialReason: 'One recognisable company or proof brand was mentioned, but the page could leverage this more clearly.',
    missingReason: 'No recognisable brand or customer names were detected in the page copy.',
    recommendation: 'Weave credible customer names or known brands into body copy where it strengthens trust.',
  })
}

function navLabelDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.descriptiveNavLabels.length >= Math.max(2, signals.vagueNavLabels.length),
    partial: signals.descriptiveNavLabels.length >= 1,
    foundReason: 'Navigation labels appear more descriptive than vague or marketing-heavy.',
    partialReason: 'Some navigation labels are descriptive, but there is still room to reduce vague labels.',
    missingReason: 'Navigation labels appear vague or too market-y relative to descriptive labels.',
    recommendation: 'Use navigation labels that help buyers find what they need quickly instead of generic umbrella terms.',
  })
}

function jargonDetector(_snapshot, signals) {
  return evaluateState({
    found: signals.jargonHits <= 2,
    partial: signals.jargonHits <= 5,
    foundReason: 'The page keeps jargon relatively under control.',
    partialReason: 'Some jargon-heavy terms are present and may make the page feel more internal than buyer-friendly.',
    missingReason: 'The page leans heavily on vague or jargon-driven language.',
    recommendation: 'Replace internal or abstract jargon with the language buyers actually use when evaluating options.',
  })
}

function titleMetaDetector(snapshot, signals) {
  return evaluateState({
    found: signals.titleMetaBenefit && snapshot.metaDescription.length >= 80,
    partial: snapshot.metaDescription.length > 0,
    foundReason: 'The title/meta pair reads more like ad copy than bare labeling.',
    partialReason: 'Meta tags exist, but they could carry stronger benefit-driven messaging.',
    missingReason: 'No strong title/meta benefit framing was detected.',
    recommendation: 'Write title tags and meta descriptions like concise ad copy with a clear outcome or benefit.',
  })
}

function comparisonQueryDetector(snapshot) {
  const combined = `${snapshot.url} ${snapshot.title}`.toLowerCase()
  return evaluateState({
    found: /\bvs\b|compare|best /.test(combined),
    partial: false,
    foundReason: 'The page appears to be a comparison-style or ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“bestÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â style page.',
    partialReason: '',
    missingReason: 'No comparison-query style page signal was detected.',
    recommendation: 'Create dedicated comparison or ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“vsÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â pages where those buyer-intent queries matter.',
  })
}







function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

