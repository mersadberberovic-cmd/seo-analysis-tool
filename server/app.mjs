import express from 'express'
import * as cheerio from 'cheerio'
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import {
  exportAnswerVisibilityCsv,
  getAnswerVisibilityOverview,
  listCampaigns,
  rerunAnswerVisibilityChecks,
  runAnswerVisibilityChecks,
} from './lib/answer-visibility-service.mjs'

const app = express()
const port = 4174
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_request, response) => {
  response.json({ ok: true })
})

app.get('/api/page-scan', async (request, response) => {
  const targetUrl = String(request.query.url ?? '').trim()
  const keyword = String(request.query.keyword ?? '').trim()

  if (!targetUrl || !keyword) {
    response.status(400).json({ error: 'Both url and keyword are required.' })
    return
  }

  let parsedUrl
  try {
    parsedUrl = new URL(targetUrl)
  } catch {
    response.status(400).json({ error: 'The URL is not valid.' })
    return
  }

  try {
    const fetched = await fetch(parsedUrl, {
      headers: {
        'user-agent': 'SEOAnalysisToolBot/0.1 (+https://github.com/mersadberberovic-cmd/seo-analysis-tool)',
        accept: 'text/html,application/xhtml+xml',
      },
    })

    if (!fetched.ok) {
      response.status(502).json({ error: `Could not fetch page. Status ${fetched.status}.` })
      return
    }

    const html = await fetched.text()
    const $ = cheerio.load(html)
    $('script, style, noscript').remove()

    const title = $('title').first().text().trim()
    const metaDescription = $('meta[name="description"]').attr('content')?.trim() ?? ''
    const headings = $('h1, h2').map((_index, element) => $(element).text().trim()).get().filter(Boolean)
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim()
    const bodyExcerpt = bodyText.slice(0, 5000)

    const analysis = analyzeKeywordFit({
      keyword,
      title,
      metaDescription,
      headings,
      url: parsedUrl.toString(),
      bodyText: bodyExcerpt,
    })

    response.json({
      url: parsedUrl.toString(),
      keyword,
      title,
      metaDescription,
      headings: headings.slice(0, 10),
      contentSample: bodyExcerpt.slice(0, 500),
      analysis,
    })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unexpected page scan failure.',
    })
  }
})

app.get('/api/gemini-status', (_request, response) => {
  response.json({
    availableFromEnv: Boolean(process.env.GEMINI_API_KEY),
    recommendedConnectionMethod: 'api-key',
    message: process.env.GEMINI_API_KEY
      ? 'Gemini AI enhancement is built into this app instance. Users can switch it on with one click, and only need their own key later if the shared Gemini quota is exhausted.'
      : 'Gemini AI enhancement is optional. To use it right now, add a Gemini API key for this session. In a hosted version, this can be powered by the app first and only fall back to user keys when shared limits are hit.',
  })
})

app.get('/api/answer-visibility/campaigns', (_request, response) => {
  response.json({ campaigns: listCampaigns() })
})

app.get('/api/answer-visibility/records', (request, response) => {
  response.json(getAnswerVisibilityOverview({
    campaignId: request.query.campaignId ? String(request.query.campaignId) : '',
    projectTag: request.query.projectTag ? String(request.query.projectTag) : '',
    intent: request.query.intent ? String(request.query.intent) : '',
    dateFrom: request.query.dateFrom ? String(request.query.dateFrom) : '',
    dateTo: request.query.dateTo ? String(request.query.dateTo) : '',
    mentionStatus: request.query.mentionStatus ? String(request.query.mentionStatus) : '',
    brandId: request.query.brandId ? String(request.query.brandId) : '',
    competitorId: request.query.competitorId ? String(request.query.competitorId) : '',
  }))
})

app.get('/api/answer-visibility/export.csv', (request, response) => {
  const csv = exportAnswerVisibilityCsv({
    campaignId: request.query.campaignId ? String(request.query.campaignId) : '',
    projectTag: request.query.projectTag ? String(request.query.projectTag) : '',
    intent: request.query.intent ? String(request.query.intent) : '',
    dateFrom: request.query.dateFrom ? String(request.query.dateFrom) : '',
    dateTo: request.query.dateTo ? String(request.query.dateTo) : '',
    mentionStatus: request.query.mentionStatus ? String(request.query.mentionStatus) : '',
    brandId: request.query.brandId ? String(request.query.brandId) : '',
    competitorId: request.query.competitorId ? String(request.query.competitorId) : '',
  })

  response.setHeader('Content-Type', 'text/csv; charset=utf-8')
  response.setHeader('Content-Disposition', 'attachment; filename="ai-answer-visibility.csv"')
  response.send(csv)
})

app.post('/api/answer-visibility/run', async (request, response) => {
  try {
    const prompts = Array.isArray(request.body?.prompts) ? request.body.prompts : []
    if (prompts.length === 0) {
      response.status(400).json({ error: 'At least one prompt is required.' })
      return
    }

    const result = await runAnswerVisibilityChecks({
      campaignName: String(request.body?.campaignName ?? ''),
      projectTag: String(request.body?.projectTag ?? ''),
      primaryBrand: request.body?.primaryBrand ?? {},
      competitorBrands: Array.isArray(request.body?.competitorBrands) ? request.body.competitorBrands : [],
      prompts,
      providerPreference: String(request.body?.providerPreference ?? 'auto'),
    })

    response.json(result)
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'AI Answer Visibility run failed.',
    })
  }
})

app.post('/api/answer-visibility/rerun', async (request, response) => {
  try {
    const promptIds = Array.isArray(request.body?.promptIds) ? request.body.promptIds.map((item) => String(item)) : []
    if (promptIds.length === 0) {
      response.status(400).json({ error: 'At least one prompt id is required for rerun.' })
      return
    }

    const result = await rerunAnswerVisibilityChecks({
      promptIds,
      providerPreference: String(request.body?.providerPreference ?? 'auto'),
    })

    response.json(result)
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'AI Answer Visibility rerun failed.',
    })
  }
})

async function handleEeatScan(request, response) {
  const isPost = request.method === 'POST'
  const targetUrl = String((isPost ? request.body?.url : request.query.url) ?? '').trim()
  const useGemini = Boolean(isPost ? request.body?.useGemini : false)
  const requestGeminiKey = String(isPost ? request.body?.geminiApiKey ?? '' : '').trim()

  if (!targetUrl) {
    response.status(400).json({ error: 'A url is required.' })
    return
  }

  let parsedUrl
  try {
    parsedUrl = new URL(targetUrl)
  } catch {
    response.status(400).json({ error: 'The URL is not valid.' })
    return
  }

  try {
    const page = await fetchAndParsePage(parsedUrl)
    const visualCapture = await withTimeout(
      capturePageVisual(parsedUrl),
      20000,
      () => ({
        available: false,
        note: 'Visual capture timed out, so the EEAT audit returned text-based results only for this page.',
        evidenceBlocks: [],
      }),
    )
    const analysis = analyzeEeat({ page, visualCapture })
    const geminiEnhancement = useGemini
      ? await runGeminiEnhancement({
          page,
          analysis,
          apiKey: requestGeminiKey || process.env.GEMINI_API_KEY || '',
          apiKeySource: requestGeminiKey ? 'session' : (process.env.GEMINI_API_KEY ? 'server' : 'none'),
        })
      : {
          provider: 'gemini',
          enabled: false,
          status: 'disabled',
          message: 'Gemini AI enhancement is off. Turn it on in the UI if you want an AI second opinion.',
        }

    response.json({
      url: parsedUrl.toString(),
      title: page.title,
      visualCapture,
      analysis,
      geminiEnhancement,
    })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unexpected EEAT scan failure.',
    })
  }
}

app.get('/api/eeat-scan', handleEeatScan)
app.post('/api/eeat-scan', handleEeatScan)

const server = app.listen(port, () => {
  console.log(`SEO analysis server listening on http://localhost:${port}`)
})

server.on('close', () => {
  console.log('SEO analysis server closed')
})

process.stdin.resume()

function analyzeKeywordFit(input) {
  const keywordTerms = normalizeTokens(input.keyword)
  const normalizedKeyword = normalizeText(input.keyword).trim()
  const urlText = normalizeText(input.url)
  const titleText = normalizeText(input.title)
  const metaText = normalizeText(input.metaDescription)
  const headingText = normalizeText(input.headings.join(' '))
  const bodyText = normalizeText(input.bodyText)
  const firstHundredWords = bodyText.split(/\s+/).slice(0, 100).join(' ')

  const urlMatches = countMatchingTerms(keywordTerms, urlText)
  const titleMatches = countMatchingTerms(keywordTerms, titleText)
  const headingMatches = countMatchingTerms(keywordTerms, headingText)
  const metaMatches = countMatchingTerms(keywordTerms, metaText)
  const bodyMatches = countMatchingTerms(keywordTerms, bodyText)
  const titleExactMatch = normalizedKeyword.length > 0 && titleText.includes(normalizedKeyword)
  const titlePartialMatch = !titleExactMatch && titleMatches > 0
  const exactPhraseInBody = normalizedKeyword.length > 0 && bodyText.includes(normalizedKeyword)
  const repeatedTermPresence = bodyMatches >= Math.max(2, Math.ceil(keywordTerms.length / 2))
  const topicClueCoverage = keywordTerms.length > 0 && bodyMatches / keywordTerms.length >= 0.75
  const mixedPhraseAndTerms = exactPhraseInBody && bodyMatches >= Math.max(2, keywordTerms.length)
  const keywordInFirstHundredWords = normalizedKeyword.length > 0 && firstHundredWords.includes(normalizedKeyword)
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length
  const inferredIntent = inferIntent(input.keyword)
  const pageType = inferPageType(input.url, titleText, headingText, bodyText)
  const pageTypeAlignment = scorePageTypeAlignment(inferredIntent, pageType)
  const titleLength = input.title.trim().length
  const metaLength = input.metaDescription.trim().length
  const h1Text = input.headings[0] ? normalizeText(input.headings[0]) : ''
  const h1TitleAlignment = h1Text.length > 0 && titleText.length > 0 && haveMeaningfulOverlap(titleText, h1Text)

  let score = 0
  const reasons = []

  if (urlMatches > 0) {
    score += 20
    reasons.push('URL match: keyword terms appear in the URL. (+20)')
  }

  if (titleExactMatch) {
    score += 30
    reasons.push('Title exact match: the full keyword appears in the title tag. (+30)')
  } else if (titlePartialMatch) {
    score += 15
    reasons.push('Title partial match: some keyword terms appear in the title tag. (+15)')
  }

  if (headingMatches > 0) {
    score += 20
    reasons.push('Heading match: keyword terms appear in H1 or H2 coverage. (+20)')
  }

  if (h1TitleAlignment) {
    score += 8
    reasons.push('Message alignment: title tag and primary heading support the same topic. (+8)')
  }

  if (
    exactPhraseInBody ||
    repeatedTermPresence ||
    topicClueCoverage ||
    mixedPhraseAndTerms
  ) {
    score += 10
    reasons.push('Body content match: the page copy reinforces the topic using phrase, repeated-term, or topic-clue signals. (+10)')
  }

  if (keywordInFirstHundredWords) {
    score += 10
    reasons.push('Early-page signal: the keyword appears in the first 100 words. (+10)')
  }

  if (pageTypeAlignment.score !== 0) {
    score += pageTypeAlignment.score
    reasons.push(pageTypeAlignment.reason)
  }

  if (wordCount >= 350) {
    score += 6
    reasons.push('Content depth: the page has enough visible copy to support the topic. (+6)')
  } else if (wordCount > 0 && wordCount < 150) {
    score -= 6
    reasons.push('Content depth concern: the page may be thin for this keyword target. (-6)')
  }

  if (titleLength >= 30 && titleLength <= 60) {
    score += 4
    reasons.push('Title quality: title length is in a healthy optimization range. (+4)')
  }

  if (metaLength >= 70 && metaLength <= 160) {
    score += 3
    reasons.push('Meta support: meta description length is in a healthy range. (+3)')
  }

  if (titleMatches === 0 && urlMatches === 0 && (mixedPhraseAndTerms || (exactPhraseInBody && repeatedTermPresence) || (topicClueCoverage && bodyMatches >= 3))) {
    score += 20
    reasons.push('Content-only fallback: the topic is clear from page content even without title or URL alignment. (+20)')
  }

  const strategistVerdict =
    score >= 70
      ? 'Strong match: the page appears relevant and already aligned to the keyword topic.'
      : score >= 45
        ? 'Moderate match: the page likely covers the topic, but the keyword targeting could be clearer.'
        : 'Weak match: the page does not strongly signal this keyword yet.'

  return {
    score: Math.min(100, score),
    strategistVerdict,
    reasons,
    inferredIntent,
    pageType,
    matchBreakdown: {
      urlMatches,
      titleExactMatch,
      titleMatches,
      headingMatches,
      metaMatches,
      bodyMatches,
      exactPhraseInBody,
      repeatedTermPresence,
      topicClueCoverage,
      mixedPhraseAndTerms,
      keywordInFirstHundredWords,
      wordCount,
      titleLength,
      metaLength,
      h1TitleAlignment,
    },
  }
}

async function fetchAndParsePage(targetUrl) {
  const fetched = await fetch(targetUrl, {
    headers: {
      'user-agent': 'SEOAnalysisToolBot/0.1 (+https://github.com/mersadberberovic-cmd/seo-analysis-tool)',
      accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(20000),
  })

  if (!fetched.ok) {
    throw new Error(`Could not fetch page. Status ${fetched.status}.`)
  }

  const html = await fetched.text()
  const $ = cheerio.load(html)
  const jsonLd = $('script[type="application/ld+json"]')
    .map((_index, element) => $(element).html() ?? '')
    .get()
    .filter(Boolean)
  const microdataTypes = $('[itemtype]')
    .map((_index, element) => $(element).attr('itemtype') ?? '')
    .get()
    .filter(Boolean)
  const hasItemProps = $('[itemprop]').length > 0
  const hasRdfa = $('[typeof], [property], [vocab]').length > 0

  $('script, style, noscript').remove()

  const title = $('title').first().text().trim()
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() ?? ''
  const headings = $('h1, h2, h3').map((_index, element) => $(element).text().trim()).get().filter(Boolean)
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim()
  const bodyExcerpt = bodyText.slice(0, 8000)
  const links = $('a[href]')
    .map((_index, element) => ({
      href: $(element).attr('href') ?? '',
      text: $(element).text().trim(),
      rel: $(element).attr('rel') ?? '',
    }))
    .get()
  const images = $('img')
    .map((_index, element) => ({
      src: $(element).attr('src') ?? '',
      alt: $(element).attr('alt') ?? '',
      width: $(element).attr('width') ?? '',
      height: $(element).attr('height') ?? '',
    }))
    .get()
  const videos = $('video, iframe[src*="youtube"], iframe[src*="vimeo"]').length

  return {
    url: targetUrl.toString(),
    hostname: targetUrl.hostname,
    title,
    metaDescription,
    headings,
    bodyText: bodyExcerpt,
    links,
    images,
    videos,
    jsonLd,
    microdataTypes,
    hasItemProps,
    hasRdfa,
    html,
  }
}

function analyzeEeat(input) {
  const { page, visualCapture } = input
  const firstWords = page.bodyText.split(/\s+/).slice(0, 85).join(' ').trim()
  const wordCount = page.bodyText.split(/\s+/).filter(Boolean).length
  const resolvedLinks = page.links
    .map((link) => {
      try {
        const resolved = new URL(link.href, page.url)
        return { ...link, resolved }
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const uniqueLinks = dedupeResolvedLinks(resolvedLinks)
  const outboundLinks = uniqueLinks.filter((link) => link.resolved.hostname !== page.hostname)
  const internalLinks = uniqueLinks.filter((link) => link.resolved.hostname === page.hostname)
  const contactTrustLinks = internalLinks.filter((link) => /(about|contact|team|location|locations|get in touch|call)/i.test(`${link.text} ${link.resolved.pathname}`))
  const policyLegalLinks = internalLinks.filter((link) => /(privacy|policy|terms|conditions|editorial|warranty|guarantee)/i.test(`${link.text} ${link.resolved.pathname}`))
  const contactTrustGroups = groupLinksByIntent(contactTrustLinks, {
    about: /(about)/i,
    contact: /(contact|get in touch|call)/i,
    team: /(team)/i,
    location: /(location|locations)/i,
  })
  const policyLegalGroups = groupLinksByIntent(policyLegalLinks, {
    privacy: /(privacy)/i,
    terms: /(terms|conditions)/i,
    editorial: /(editorial|policy)/i,
    warranty: /(warranty|guarantee)/i,
  })
  const visibleContactSignals = extractVisibleContactSignals(page.bodyText)
  const visualSummary = summarizePageVisuals(page.images, page.videos)

  const categories = [
    detectAuthorSignals(page),
    detectExperienceSignals(page, visualSummary),
    detectAuthoritySignals(page, internalLinks),
    detectCitationQuality(page, outboundLinks),
    detectContentEffort(page, visualSummary),
    detectOriginality(page, visualSummary),
    detectPageIntent(page, firstWords),
    detectWritingQuality(page),
    detectReviewSignals(page),
    detectContactVisibility(page, contactTrustLinks, contactTrustGroups, visibleContactSignals),
    detectPolicyVisibility(page, policyLegalLinks, policyLegalGroups),
    detectSchemaSignals({
      jsonLdBlocks: page.jsonLd,
      microdataTypes: page.microdataTypes,
      hasItemProps: page.hasItemProps,
      hasRdfa: page.hasRdfa,
    }),
    detectAnswerSignals(firstWords, page.headings),
    detectDataSignals(page.bodyText),
  ]

  const totalPoints = categories.reduce((sum, category) => sum + category.max, 0)
  const earnedPoints = categories.reduce((sum, category) => sum + category.earned, 0)
  const score = Math.round((earnedPoints / totalPoints) * 100)
  const strengths = categories.filter((category) => category.earned >= category.max * 0.7).map((category) => `${category.label}: ${category.summary}`)
  const priorities = categories.filter((category) => category.earned < category.max * 0.55).map((category) => `${category.label}: ${category.recommendation}`)
  const actionPlan = categories
    .filter((category) => category.earned < category.max)
    .sort((left, right) => (left.earned / left.max) - (right.earned / right.max))
    .slice(0, 5)
    .map((category, index) => ({
      priority: index + 1,
      label: category.label,
      reason: category.gaps[0] ?? category.summary,
      recommendation: category.recommendation,
    }))
  const evidenceBlocks = visualCapture?.evidenceBlocks ?? []

  return {
    score: Math.max(0, Math.min(100, score)),
    summary:
      score >= 75
        ? 'Strong page-level EEAT coverage based on visible on-page signals.'
        : score >= 55
          ? 'Moderate page-level EEAT coverage, but several trust signals still need strengthening.'
          : 'Weak page-level EEAT coverage based on the visible signals on this page.',
    formula: {
      earnedPoints,
      totalPoints,
      explanation: 'The EEAT score is the sum of weighted page-level categories. Each category has a fixed maximum point value and only visible signals on the scanned page count.',
      categories: categories.map((category) => ({
        id: category.id,
        label: category.label,
        earned: category.earned,
        max: category.max,
        confidence: category.confidence,
      })),
    },
    strengths,
    priorities,
    actionPlan,
    visualSummary,
    visualCapture,
    evidenceCoverage: `${categories.filter((category) => category.evidenceIds.length > 0).length} of ${categories.length} criteria include direct visual evidence blocks.`,
    evidenceBlocks,
    categories,
    firstWords,
    title: page.title,
    metaDescription: page.metaDescription,
    pageSignals: {
      wordCount,
      headingCount: page.headings.length,
      contactLinkCount: contactTrustGroups.length,
      policyLinkCount: policyLegalGroups.length,
      visibleContactDetailCount: visibleContactSignals.length,
      outboundLinkCount: outboundLinks.length,
      authoritativeOutboundLinkCount: outboundLinks.filter((link) => isAuthorityLink(link.resolved.hostname)).length,
    },
  }
}

async function runGeminiEnhancement({ page, analysis, apiKey, apiKeySource }) {
  if (!apiKey) {
    return {
      provider: 'gemini',
      enabled: true,
      status: 'missing_key',
      keySource: 'none',
      model: 'gemini-2.5-flash',
      message: 'Gemini AI enhancement was requested, but no Gemini API key is connected. Add a key in the app or configure GEMINI_API_KEY on the server.',
    }
  }

  const prompt = [
    'You are a strict SEO strategist reviewing page-level EEAT signals.',
    'Use only the provided page data. Do not invent facts. If evidence is weak, say so clearly.',
    'Treat the supplied rule-based audit as a baseline. Agree where it is fair, call out where it may be too generous or too harsh.',
    '',
    `URL: ${page.url}`,
    `Title: ${page.title || 'None'}`,
    `Meta description: ${page.metaDescription || 'None'}`,
    `Headings: ${page.headings.slice(0, 12).join(' | ') || 'None'}`,
    `Visible word count: ${analysis.pageSignals.wordCount}`,
    `Visible contact detail count: ${analysis.pageSignals.visibleContactDetailCount}`,
    `Policy link count: ${analysis.pageSignals.policyLinkCount}`,
    `Authoritative outbound link count: ${analysis.pageSignals.authoritativeOutboundLinkCount}`,
    `Rule-based EEAT score: ${analysis.score}/100`,
    `Rule-based summary: ${analysis.summary}`,
    '',
    'Rule-based weakest categories:',
    ...analysis.categories
      .slice()
      .sort((left, right) => (left.earned / left.max) - (right.earned / right.max))
      .slice(0, 5)
      .map((category) => `- ${category.label}: ${category.earned}/${category.max}. Findings: ${category.findings.join(' || ') || 'none'}. Gaps: ${category.gaps.join(' || ') || 'none'}. Recommendation: ${category.recommendation}`),
    '',
    'Opening content preview:',
    analysis.firstWords || 'None',
    '',
    'Visible body excerpt:',
    page.bodyText.slice(0, 5000),
  ].join('\n')

  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: {
            type: 'object',
            properties: {
              summary: { type: 'string', description: 'A short strategist-style summary of the page-level EEAT situation.' },
              trustVerdict: { type: 'string', enum: ['supports', 'mixed', 'weak'], description: 'Whether the page visibly supports strong EEAT.' },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How confident the model is in its assessment based only on supplied page evidence.' },
              agreementWithRules: { type: 'string', description: 'Where the AI agrees with the rule-based audit.' },
              overstatementRisk: {
                type: 'array',
                items: { type: 'string' },
                description: 'Cases where the current rule-based audit may be overstating trust or quality signals.',
                maxItems: 4,
              },
              blindSpots: {
                type: 'array',
                items: { type: 'string' },
                description: 'Important concerns or nuances the rule-based audit may not fully capture.',
                maxItems: 4,
              },
              refinedQuickWins: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    reason: { type: 'string' },
                    action: { type: 'string' },
                  },
                  required: ['label', 'reason', 'action'],
                },
                minItems: 1,
                maxItems: 5,
              },
            },
            required: ['summary', 'trustVerdict', 'confidence', 'agreementWithRules', 'overstatementRisk', 'blindSpots', 'refinedQuickWins'],
          },
        },
      }),
      signal: AbortSignal.timeout(25000),
    })

    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      const lowered = raw.toLowerCase()

      if (response.status === 429 || lowered.includes('resource_exhausted') || lowered.includes('quota')) {
        return {
          provider: 'gemini',
          enabled: true,
          status: 'rate_limited',
          keySource: apiKeySource,
          model: 'gemini-2.5-flash',
          message: 'Gemini enhancement hit a rate limit or free-tier quota wall. Connect your own Gemini API key to keep using the AI-enhanced review.',
        }
      }

      return {
        provider: 'gemini',
        enabled: true,
        status: 'error',
        keySource: apiKeySource,
        model: 'gemini-2.5-flash',
        message: `Gemini enhancement could not complete. ${extractGeminiErrorMessage(raw)}`,
      }
    }

    const payload = await response.json()
    const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim() ?? ''
    const parsed = JSON.parse(text)

    return {
      provider: 'gemini',
      enabled: true,
      status: 'applied',
      keySource: apiKeySource,
      model: 'gemini-2.5-flash',
      message: apiKeySource === 'server'
        ? 'Gemini AI enhancement used the server-configured API key.'
        : 'Gemini AI enhancement used the session API key you provided.',
      ...parsed,
    }
  } catch (error) {
    return {
      provider: 'gemini',
      enabled: true,
      status: 'error',
      keySource: apiKeySource,
      model: 'gemini-2.5-flash',
      message: error instanceof Error
        ? `Gemini enhancement could not complete. ${error.message}`
        : 'Gemini enhancement could not complete.',
    }
  }
}

function extractGeminiErrorMessage(rawBody) {
  try {
    const parsed = JSON.parse(rawBody)
    return parsed?.error?.message || 'Unexpected Gemini API error.'
  } catch {
    return rawBody || 'Unexpected Gemini API error.'
  }
}

function detectAuthorSignals(page) {
  const keywordSnippet = findSnippet(page.bodyText, /(written by|about the author|author bio|author profile|meet the author|reviewed by|reviewed and approved by|expert contributor)/i)
  const namedAuthorSnippet = findSnippet(page.bodyText, /(written by|reviewed by|about the author|author bio|author profile|expert contributor)[^.!?\n]{0,120}([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/i)
  const credentialSnippet = findSnippet(page.bodyText, /(phd|md|esq|attorney|lawyer|licensed|certified|specialist|editor|founder|director)[^.!?\n]{0,120}/i)
  const socialLinks = page.links.filter((link) => /linkedin|x\.com|twitter|github|instagram|facebook/.test(link.href))
  let earned = 0
  const findings = []
  const gaps = []

  if (keywordSnippet) {
    earned += 4
    findings.push(`Found visible author/reviewer wording on the page: "${keywordSnippet}"`)
  } else {
    gaps.push('No explicit author, reviewer, or contributor block was found in the visible page copy.')
  }

  if (namedAuthorSnippet) {
    earned += 4
    findings.push(`Found a likely named person in that author/reviewer context: "${namedAuthorSnippet}"`)
  } else {
    gaps.push('No clearly named person was detected inside an author or reviewer context.')
  }

  if (credentialSnippet && namedAuthorSnippet) {
    earned += 2
    findings.push(`Found role or credential wording near the author context: "${credentialSnippet}"`)
  } else {
    gaps.push('No visible role, qualification, or expertise label was detected near a named author or reviewer.')
  }

  if (keywordSnippet && socialLinks.length > 0) {
    earned += Math.min(2, socialLinks.length)
    findings.push(`Found ${socialLinks.length} visible profile/social link(s) on the page.`)
  } else if (socialLinks.length === 0) {
    gaps.push('No visible social or profile links were detected on the page.')
  }

  return buildEeatCategory({
    id: 'author-credibility',
    label: 'Visible author credibility',
    max: 12,
    earned,
    summary: namedAuthorSnippet
      ? 'The page shows some visible author or reviewer context, but the quality depends on whether credentials and accountability are explicit enough.'
      : 'Author credibility is not clearly established on the page itself.',
    findings,
    gaps,
    recommendation: namedAuthorSnippet
      ? 'Make the author block more explicit with role, credentials, and why this author is qualified to write this page.'
      : 'Add a visible author section with name, credentials, role, and a short expertise summary directly on the page.',
    evidenceIds: keywordSnippet ? ['author-credibility'] : [],
    confidenceHint: namedAuthorSnippet ? 'direct' : 'heuristic',
  })
}

function detectExperienceSignals(page, visualSummary) {
  const firstHandSnippet = findSnippet(page.bodyText, /(case study|we tested|we found|from our work|we installed|we implemented|our team completed|project example|client results|before and after|real example|example from)/i)
  const quantifiedProofSnippet = findSnippet(page.bodyText, /(\d+\+?\s+(years|systems|projects|installations|clients|cases)|guarantee|licensed)/i)
  const proofMediaCount = visualSummary.screenshotLikeImages + visualSummary.videoCount
  let earned = 0
  const findings = []
  const gaps = []

  if (firstHandSnippet) {
    earned += 6
    findings.push(`Found first-hand or case-study style wording: "${firstHandSnippet}"`)
  } else {
    gaps.push('No clear first-hand, case-study, or tested-in-practice language was detected in the page copy.')
  }

  if (quantifiedProofSnippet) {
    earned += 3
    findings.push(`Found quantified credibility or proof wording on the page: "${quantifiedProofSnippet}"`)
  } else {
    gaps.push('No quantified proof such as years, projects, systems, cases, or guarantees was detected in the visible copy.')
  }

  if (proofMediaCount > 0) {
    earned += Math.min(3, proofMediaCount)
    findings.push(`Detected ${visualSummary.videoCount} video/embed(s) and ${visualSummary.screenshotLikeImages} screenshot-like proof asset(s).`)
  } else {
    gaps.push('No screenshot-like proof assets or videos were detected on the page.')
  }

  return buildEeatCategory({
    id: 'first-hand-experience',
    label: 'Demonstrated first-hand experience',
    max: 12,
    earned,
    summary: firstHandSnippet || quantifiedProofSnippet || proofMediaCount > 0
      ? 'The page shows some signals of hands-on experience, but the proof is only strong when the examples are explicit and verifiable.'
      : 'The page reads more like general advice than demonstrated first-hand experience.',
    findings,
    gaps,
    recommendation: 'Add concrete proof of experience on the page such as original screenshots, before/after examples, case-study blocks, or clearly stated outcomes from real work.',
    evidenceIds: firstHandSnippet ? ['first-hand-experience'] : [],
    confidenceHint: firstHandSnippet && proofMediaCount > 0 ? 'direct' : 'heuristic',
  })
}

function detectAuthoritySignals(page, internalLinks) {
  const relatedInternalLinks = internalLinks.filter((link) => /(guide|blog|service|category|product|solution|learn|resource|case-study)/i.test(`${link.text} ${link.resolved.pathname}`))
  const wordCount = page.bodyText.split(/\s+/).filter(Boolean).length
  const headingCount = page.headings.length
  let earned = 0
  const findings = []
  const gaps = []

  if (wordCount >= 1200) {
    earned += 6
    findings.push(`Visible body copy is approximately ${wordCount} words, which suggests meaningful topical depth.`)
  } else if (wordCount >= 700) {
    earned += 4
    findings.push(`Visible body copy is approximately ${wordCount} words, which gives the page moderate depth.`)
  } else {
    gaps.push(`Visible body copy is approximately ${wordCount} words, which may be too thin for strong topical authority.`)
  }

  if (headingCount >= 6) {
    earned += 3
    findings.push(`The page has ${headingCount} headings, which suggests the topic is structured into multiple subtopics.`)
  } else {
    gaps.push(`The page only has ${headingCount} headings, so topic coverage may not be broken down deeply enough.`)
  }

  if (relatedInternalLinks.length >= 3) {
    earned += 3
    findings.push(`Found ${relatedInternalLinks.length} related internal links on the page, which supports topical clustering.`)
  } else {
    gaps.push(`Only ${relatedInternalLinks.length} related internal links were found on the page.`)
  }

  return buildEeatCategory({
    id: 'topical-authority',
    label: 'Topical authority and depth',
    max: 12,
    earned,
    summary: earned >= 8
      ? 'The page has reasonable depth, but the authority signal depends on how complete and interconnected the topic coverage really is.'
      : 'The page does not yet show strong enough depth or internal topic support to signal authority confidently.',
    findings,
    gaps,
    recommendation: 'Strengthen the page with more complete subtopic coverage, richer supporting sections, and contextual links to closely related supporting pages.',
    confidenceHint: 'heuristic',
  })
}

function detectCitationQuality(page, outboundLinks) {
  const authorityLinks = outboundLinks.filter((link) => isAuthorityLink(link.resolved.hostname))
  const citationLikeSnippet = findSnippet(page.bodyText, /(according to|study|research|report|data from|source:|sources:)/i)
  const citedAuthorityLinks = authorityLinks.filter((link) => link.text.trim().length > 0)
  let earned = 0
  const findings = []
  const gaps = []

  if (citationLikeSnippet) {
    earned += 4
    findings.push(`Found citation-like wording in the copy: "${citationLikeSnippet}"`)
  } else {
    gaps.push('No obvious in-body citation wording such as "according to", "research", or "source" was found.')
  }

  if (citationLikeSnippet && citedAuthorityLinks.length > 0) {
    earned += Math.min(4, citedAuthorityLinks.length * 2)
    findings.push(`Found ${citedAuthorityLinks.length} authoritative outbound link(s) that could support those in-body claims.`)
  } else if (authorityLinks.length > 0) {
    earned += 1
    findings.push(`Found ${authorityLinks.length} authoritative outbound link(s), but they are not clearly tied to in-body citations.`)
  } else {
    gaps.push('No outbound links to clearly authoritative or primary-source domains were detected.')
  }

  if (outboundLinks.length === 0) {
    gaps.push('No outbound links were detected on the page.')
  }

  return buildEeatCategory({
    id: 'citation-quality',
    label: 'Citation quality',
    max: 10,
    earned,
    summary: earned >= 6
      ? 'The page includes some visible citation or source-quality signals.'
      : 'The page makes weak visible use of sources or supporting citations.',
    findings,
    gaps,
    recommendation: 'Support important claims with authoritative outbound sources and make those citations obvious in the body copy.',
    confidenceHint: citationLikeSnippet && citedAuthorityLinks.length > 0 ? 'mixed' : 'heuristic',
  })
}

function detectContentEffort(page, visualSummary) {
  const wordCount = page.bodyText.split(/\s+/).filter(Boolean).length
  const hasMethodSnippet = findSnippet(page.bodyText, /(process|framework|step-by-step|how we|methodology|tested|audit|checklist|template)/i)
  let earned = 0
  const findings = []
  const gaps = []

  if (wordCount >= 1400) {
    earned += 4
    findings.push(`Visible body copy is approximately ${wordCount} words, indicating substantial effort.`)
  } else if (wordCount >= 800) {
    earned += 2
    findings.push(`Visible body copy is approximately ${wordCount} words, suggesting moderate effort.`)
  } else {
    gaps.push(`Visible body copy is approximately ${wordCount} words, which is modest for a high-effort page.`)
  }

  if (hasMethodSnippet) {
    earned += 3
    findings.push(`Found process or methodology wording: "${hasMethodSnippet}"`)
  } else {
    gaps.push('No strong “show your work” or methodology language was detected in the page copy.')
  }

  if (visualSummary.meaningfulImageCount > 0 || visualSummary.videoCount > 0) {
    earned += 3
    findings.push(`Found ${visualSummary.meaningfulImageCount} meaningful image(s) and ${visualSummary.videoCount} video/embed(s), which suggests some production effort.`)
  } else {
    gaps.push('No meaningful visuals or video proof were detected to support a high-effort impression.')
  }

  return buildEeatCategory({
    id: 'content-effort',
    label: 'Content effort',
    max: 10,
    earned,
    summary: earned >= 6
      ? 'The page shows moderate to strong visible effort signals.'
      : 'The page does not yet strongly demonstrate visible effort or proof-of-work signals.',
    findings,
    gaps,
    recommendation: 'Add clearer methodology, richer examples, and more proof assets so the page visibly shows the work behind the content.',
    evidenceIds: hasMethodSnippet ? ['first-hand-experience'] : [],
    confidenceHint: hasMethodSnippet ? 'mixed' : 'heuristic',
  })
}

function detectOriginality(page, visualSummary) {
  const uniqueAngleSnippet = findSnippet(page.bodyText, /(our framework|our process|our audit|we found|we tested|our experience|case study|example from)/i)
  const screenshotEvidence = visualSummary.screenshotLikeImages
  let earned = 0
  const findings = []
  const gaps = []

  if (uniqueAngleSnippet) {
    earned += 5
    findings.push(`Found originality or unique-angle wording: "${uniqueAngleSnippet}"`)
  } else {
    gaps.push('No clear language was detected that signals a unique framework, original finding, or proprietary angle.')
  }

  if (screenshotEvidence > 0) {
    earned += 3
    findings.push(`Found ${screenshotEvidence} screenshot-like visual(s), which may support originality or proprietary examples.`)
  } else {
    gaps.push('No screenshot-like evidence was detected to support a proprietary or original angle.')
  }

  if (page.headings.length >= 6) {
    earned += 2
    findings.push(`The page contains ${page.headings.length} headings, which suggests the page may add a fuller angle rather than a very thin summary.`)
  } else {
    gaps.push('The heading structure is limited, which can make the page feel more generic or summarised.')
  }

  return buildEeatCategory({
    id: 'original-content',
    label: 'Original content',
    max: 10,
    earned,
    summary: earned >= 6
      ? 'The page shows some visible signs of originality or a non-generic angle.'
      : 'The page does not yet clearly prove that it adds something original or hard to replicate.',
    findings,
    gaps,
    recommendation: 'Add proprietary examples, screenshots, original frameworks, or clearly stated unique insights that competitors cannot easily copy.',
    evidenceIds: uniqueAngleSnippet ? ['first-hand-experience'] : [],
    confidenceHint: uniqueAngleSnippet ? 'mixed' : 'heuristic',
  })
}

function detectPageIntent(page, firstWords) {
  const ctaLinks = page.links.filter((link) => /(contact|book|demo|get started|buy|pricing|call|schedule|quote)/i.test(`${link.text} ${link.href}`))
  const helpfulSnippet = findSnippet(`${page.title} ${firstWords} ${page.headings.join(' ')}`, /(how to|guide|learn|what is|tips|best practices|steps|strategy)/i)
  let earned = 0
  const findings = []
  const gaps = []

  if (helpfulSnippet) {
    earned += 6
    findings.push(`Found helpful-first phrasing that suggests the page is solving a user problem: "${helpfulSnippet}"`)
  } else {
    gaps.push('The opening content does not clearly signal a helpful-first purpose or user problem being solved.')
  }

  if (ctaLinks.length > 0) {
    earned += 2
    findings.push(`Found ${ctaLinks.length} commercial CTA link(s). That is acceptable if the page still clearly helps the user.`)
  }

  if (page.bodyText.split(/\s+/).filter(Boolean).length >= 700) {
    earned += 2
    findings.push('The page has enough visible copy to suggest it is trying to explain or help, not just capture traffic.')
  } else {
    gaps.push('The page may be too light to fully prove a helpful-first purpose.')
  }

  return buildEeatCategory({
    id: 'page-intent',
    label: 'Page intent',
    max: 10,
    earned,
    summary: earned >= 6
      ? 'The page appears to have a reasonably clear helpful-first purpose.'
      : 'The page intent is not yet clearly expressed as helpful-first from the visible content alone.',
    findings,
    gaps,
    recommendation: 'Clarify the user problem early, state what the page will help the reader achieve, and make the value of the page obvious in the opening section.',
    evidenceIds: ['opening-section'],
    confidenceHint: helpfulSnippet ? 'mixed' : 'heuristic',
  })
}

function detectWritingQuality(page) {
  const sentences = page.bodyText.split(/[.!?]+/).map((sentence) => sentence.trim()).filter(Boolean)
  const words = page.bodyText.split(/\s+/).filter(Boolean)
  const averageSentenceLength = sentences.length > 0 ? Math.round(words.length / sentences.length) : 0
  const passiveMatches = page.bodyText.match(/\b(is|are|was|were|be|been|being)\s+\w+ed\b/gi) ?? []
  const heavyAdverbs = page.bodyText.match(/\b(clearly|obviously|absolutely|very|really|extremely|always|never)\b/gi) ?? []
  const uniqueWordRatio = words.length > 0 ? new Set(words.map((word) => word.toLowerCase())).size / words.length : 0
  let earned = 0
  const findings = []
  const gaps = []

  if (averageSentenceLength >= 12 && averageSentenceLength <= 22) {
    earned += 4
    findings.push(`Average sentence length is about ${averageSentenceLength} words, which is within a readable range.`)
  } else {
    gaps.push(`Average sentence length is about ${averageSentenceLength} words, which may be too short/choppy or too long/dense.`)
  }

  if (uniqueWordRatio >= 0.45) {
    earned += 3
    findings.push(`Vocabulary diversity is reasonable with an approximate unique-word ratio of ${(uniqueWordRatio * 100).toFixed(0)}%.`)
  } else {
    gaps.push(`Vocabulary diversity looks limited with an approximate unique-word ratio of ${(uniqueWordRatio * 100).toFixed(0)}%.`)
  }

  if (passiveMatches.length <= 6 && heavyAdverbs.length <= 10) {
    earned += 3
    findings.push(`Passive-voice style matches: ${passiveMatches.length}; heavy adverb matches: ${heavyAdverbs.length}.`)
  } else {
    gaps.push(`Passive-voice style matches: ${passiveMatches.length}; heavy adverb matches: ${heavyAdverbs.length}, which may reduce clarity or directness.`)
  }

  return buildEeatCategory({
    id: 'writing-quality',
    label: 'Writing quality',
    max: 10,
    earned,
    summary: earned >= 6
      ? 'The writing looks reasonably readable based on sentence length, vocabulary mix, and clarity cues.'
      : 'The writing quality metrics suggest the page may need tightening for clarity and readability.',
    findings,
    gaps,
    recommendation: 'Improve readability by tightening sentence length, reducing filler adverbs, and making the language more direct and varied.',
    confidenceHint: 'heuristic',
  })
}

function detectReviewSignals(page) {
  const reviewedSnippet = findSnippet(page.html, /(reviewed by|medically reviewed by|fact checked by|approved by|editorial review)/i)
  const earned = reviewedSnippet ? 8 : 0

  return buildEeatCategory({
    id: 'reviewed-by',
    label: 'Trustworthy and validated information',
    max: 8,
    earned,
    summary: reviewedSnippet
      ? 'A review or validation marker is visible on the page.'
      : 'No clear reviewed-by, fact-check, or SME validation marker was found on this page.',
    findings: reviewedSnippet ? [`Found review/validation wording: "${reviewedSnippet}"`] : [],
    gaps: reviewedSnippet ? [] : ['No visible reviewed-by, fact-checked, or expert-approved section was detected on the page.'],
    recommendation: 'If this topic needs extra trust, add an explicit reviewed-by or expert validation section on the page itself.',
    evidenceIds: reviewedSnippet ? ['reviewed-by'] : [],
    confidenceHint: reviewedSnippet ? 'direct' : 'mixed',
  })
}

function detectContactVisibility(page, contactLinks, contactGroups, visibleContactSignals) {
  let earned = 0
  const findings = []
  const gaps = []

  if (contactGroups.length > 0) {
    earned += Math.min(4, 1 + contactGroups.length)
    findings.push(`Found ${contactGroups.length} distinct contact-trust signal type(s): ${contactGroups.join(', ')}.`)
  } else {
    gaps.push('No clear About, Contact, Team, or location links were detected on the page.')
  }

  if (visibleContactSignals.length > 0) {
    earned += 4
    findings.push(`Visible contact details detected on the page: ${visibleContactSignals.join(', ')}.`)
  } else {
    gaps.push('No visible email address, phone number, or physical address was detected in the page copy.')
  }

  return buildEeatCategory({
    id: 'contact-visibility',
    label: 'Contact visibility',
    max: 8,
    earned,
    summary: earned >= 5
      ? 'The page exposes clear contact and business-presence signals.'
      : 'The page does not make contact and business-presence signals visible enough on-page.',
    findings,
    gaps,
      recommendation: 'Expose trust signals more clearly on the page with visible contact details and clearer About, Contact, Team, or location links near key conversion points.',
      evidenceIds: contactGroups.length > 0 || visibleContactSignals.length > 0 ? ['contact-details'] : [],
      confidenceHint: contactGroups.length > 0 || visibleContactSignals.length > 0 ? 'direct' : 'mixed',
  })
}

function detectPolicyVisibility(page, policyLinks, policyGroups) {
  const visiblePolicySnippet = findSnippet(page.bodyText, /(privacy policy|terms and conditions|editorial policy|returns policy|warranty|guarantee)/i)
  let earned = 0
  const findings = []
  const gaps = []

  if (policyGroups.length > 0) {
    earned += Math.min(6, 2 + policyGroups.length * 2)
    findings.push(`Found ${policyGroups.length} distinct policy/legal signal type(s): ${policyGroups.join(', ')}.`)
  } else {
    gaps.push('No clear Privacy, Terms, Policy, warranty, guarantee, or Editorial links were detected on the page.')
  }

  if (visiblePolicySnippet) {
    earned += 1
    findings.push(`Found visible policy or warranty wording on the page: "${visiblePolicySnippet}"`)
  }

  return buildEeatCategory({
    id: 'policy-legal-visibility',
    label: 'Policy and legal visibility',
    max: 6,
    earned,
      summary: earned >= 4
        ? 'The page exposes at least some policy, legal, or warranty signals.'
        : 'The page does not make policy, legal, or warranty signals visible enough on-page.',
      findings,
      gaps,
      recommendation: 'Add clearly labeled Privacy, Terms, warranty, guarantee, or editorial-policy links where they can be discovered from this page without hunting through repeated navigation.',
      evidenceIds: visiblePolicySnippet ? ['policy-legal'] : [],
      confidenceHint: policyGroups.length > 0 || visiblePolicySnippet ? 'direct' : 'heuristic',
  })
}

function detectSchemaSignals({ jsonLdBlocks, microdataTypes, hasItemProps, hasRdfa }) {
  const normalizedSchema = jsonLdBlocks.join(' ').toLowerCase()
  const normalizedMicrodata = microdataTypes.join(' ').toLowerCase()
  const findings = []
  let earned = 0

  if (jsonLdBlocks.length > 0) {
    earned += 2
    findings.push(`Detected ${jsonLdBlocks.length} JSON-LD block(s).`)
  }
  if (microdataTypes.length > 0) {
    earned += 2
    findings.push(`Detected ${microdataTypes.length} microdata itemtype declaration(s), including ${microdataTypes.slice(0, 3).join(', ')}.`)
  }
  if (hasItemProps) {
    earned += 1
    findings.push('Detected itemprop attributes, which indicates embedded microdata markup.')
  }
  if (hasRdfa) {
    earned += 1
    findings.push('Detected RDFa-style attributes such as typeof, property, or vocab.')
  }
  if (normalizedSchema.includes('"sameas"')) {
    earned += 3
    findings.push('Detected sameAs schema property.')
  }
  if (normalizedSchema.includes('faqpage')) {
    earned += 2
    findings.push('Detected FAQPage schema.')
  }
  if (/(article|blogposting|newsarticle)/.test(normalizedSchema)) {
    earned += 2
    findings.push('Detected Article-style schema.')
  }
  if (/(organization|localbusiness|review|aggregateRating|reviewsnippet|legalservice|attorney)/i.test(normalizedSchema + ' ' + normalizedMicrodata)) {
    earned += 2
    findings.push('Detected entity/schema types relevant to trust or business validation, such as Organization, LocalBusiness, Review, or similar.')
  }
  if (normalizedSchema.includes('speakable')) {
    earned += 1
    findings.push('Detected Speakable schema.')
  }

  return buildEeatCategory({
    id: 'schema-markup',
    label: 'Structured data and machine readability',
    max: 10,
    earned,
    summary: earned > 0 ? 'Some machine-readable schema is present on the page.' : 'No clear schema markup was detected on the page.',
    findings,
    gaps: earned > 0 ? [] : ['No JSON-LD or other obvious machine-readable EEAT-supporting schema was detected.'],
    recommendation: 'Add or strengthen schema such as Article, FAQPage, Organization/Person with sameAs, and other markup that helps search engines and AI systems understand the page.',
    confidenceHint: 'mixed',
  })
}

function detectAnswerSignals(firstWords, headings) {
  const wordCount = firstWords.split(/\s+/).filter(Boolean).length
  const questionHeading = headings.some((heading) => /\?|^how |^what |^why |^when |^where |^which /i.test(heading))
  let earned = 0
  const findings = []
  const gaps = []

  if (wordCount >= 50 && wordCount <= 80) {
    earned += 6
    findings.push(`The opening extracted answer block is about ${wordCount} words, which fits an answer-first format well.`)
  } else {
    gaps.push(`The opening extracted answer block is about ${wordCount} words, which is outside the ideal 50-80 word answer-first range.`)
  }

  if (questionHeading) {
    earned += 2
    findings.push('Question-style headings were detected on the page.')
  } else {
    gaps.push('No question-style headings were detected.')
  }

  return buildEeatCategory({
    id: 'answer-first-format',
    label: 'Answer-first formatting',
    max: 8,
    earned,
    summary: earned >= 6 ? 'The page opens in a way that could work well for answer engines.' : 'The page does not clearly start with a concise answer-first block.',
    findings,
    gaps,
    recommendation: 'Rewrite the opening section so the page begins with a concise direct answer before expanding into detail.',
    evidenceIds: ['opening-section'],
    confidenceHint: 'mixed',
  })
}

function detectDataSignals(bodyText) {
  const percentages = bodyText.match(/\b\d+(?:\.\d+)?%/g) ?? []
  const largeNumbers = bodyText.match(/\b\d{2,}(?:,\d{3})*(?:\.\d+)?\b/g) ?? []
  let earned = 0
  const findings = []
  const gaps = []

  if (percentages.length > 0) {
    earned += Math.min(4, percentages.length * 2)
    findings.push(`Found percentage-based claims such as ${percentages.slice(0, 3).join(', ')}.`)
  } else {
    gaps.push('No visible percentage-based data points were detected.')
  }

  if (largeNumbers.length >= 3) {
    earned += 4
    findings.push(`Found multiple numeric data points such as ${largeNumbers.slice(0, 4).join(', ')}.`)
  } else {
    gaps.push('Only a limited number of concrete numeric data points were detected.')
  }

  return buildEeatCategory({
    id: 'citation-worthy-data',
    label: 'Citation-worthy data',
    max: 8,
    earned,
    summary: earned >= 4 ? 'The page contains some concrete data that could support citations.' : 'The page does not contain enough concrete data points to be strongly citation-worthy.',
    findings,
    gaps,
    recommendation: 'Add precise metrics, percentages, counts, and sourced data points that can be quoted or cited directly.',
    confidenceHint: 'mixed',
  })
}

function detectConversationalSignals(page, firstWords) {
  const naturalLanguageSnippet = findSnippet(`${page.headings.join(' ')} ${firstWords}`, /(how to|what is|why does|can you|best way|when should|which is)/i)
  const earned = naturalLanguageSnippet ? 6 : 1

  return buildEeatCategory({
    id: 'conversational-queries',
    label: 'Conversational and specific queries',
    max: 6,
    earned,
    summary: naturalLanguageSnippet ? 'The page includes some natural-language or question-style phrasing.' : 'The page does not strongly show conversational or question-led query targeting.',
    findings: naturalLanguageSnippet ? [`Found conversational/query-led phrasing: "${naturalLanguageSnippet}"`] : [],
    gaps: naturalLanguageSnippet ? [] : ['No strong conversational or question-led phrasing was detected in headings or opening content.'],
    recommendation: 'Use more question-led headings and natural-language phrasing that mirrors how users ask for this information.',
  })
}

function detectOutboundLinkSignals(outboundLinks) {
  const authorityLinks = outboundLinks.filter((link) => isAuthorityLink(link.resolved.hostname))
  let earned = 0
  const findings = []
  const gaps = []

  if (outboundLinks.length > 0) {
    earned += Math.min(3, outboundLinks.length)
    findings.push(`Found ${outboundLinks.length} outbound link(s) on the page.`)
  } else {
    gaps.push('No outbound references were detected on the page.')
  }

  if (authorityLinks.length > 0) {
    earned += 4
    findings.push(`Found ${authorityLinks.length} link(s) to authoritative domains.`)
  } else {
    gaps.push('No outbound links to clearly authoritative sources were detected.')
  }

  return buildEeatCategory({
    id: 'outbound-links',
    label: 'High-quality outbound links',
    max: 7,
    earned,
    summary: authorityLinks.length > 0 ? 'The page references at least some authoritative sources.' : 'The page does not visibly support claims with authoritative outbound references.',
    findings,
    gaps,
    recommendation: 'Where the page makes claims or gives advice, cite reputable external sources directly from the page.',
  })
}

function detectThirdPartyReviewSignals(outboundLinks) {
  const reviewLinks = outboundLinks.filter((link) => /g2\.com|capterra\.com|trustpilot\.com|google\.[^/]+\/search|clutch\.co|glassdoor\.com/.test(link.resolved.hostname + link.resolved.pathname))
  const earned = reviewLinks.length > 0 ? 7 : 0

  return buildEeatCategory({
    id: 'third-party-reviews',
    label: 'Third-party review presence',
    max: 7,
    earned,
    summary: reviewLinks.length > 0 ? 'The page visibly links to third-party review or reputation platforms.' : 'No third-party review-platform signal is visible on the page itself.',
    findings: reviewLinks.length > 0 ? [`Found ${reviewLinks.length} visible third-party review-platform link(s).`] : [],
    gaps: reviewLinks.length > 0 ? [] : ['No G2, Capterra, Trustpilot, Google Business Profile, or similar review-platform links were detected on the page.'],
    recommendation: 'If relevant, surface trusted third-party review or reputation signals directly on the page.',
  })
}

function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9\s-]+/g, ' ')
}

function buildEeatCategory({
  id,
  label,
  max,
  earned,
  summary,
  findings,
  gaps,
  recommendation,
  evidenceIds = [],
  confidenceHint = 'mixed',
}) {
  return {
    id,
    label,
    max,
    earned: Math.max(0, Math.min(max, earned)),
    summary,
    findings,
    gaps,
    recommendation,
    evidenceIds,
    confidence: inferCategoryConfidence({
      earned,
      max,
      findings,
      evidenceIds,
      confidenceHint,
    }),
  }
}

function inferCategoryConfidence({ earned, max, findings, evidenceIds, confidenceHint }) {
  const normalizedEarned = Math.max(0, Math.min(max, earned))
  const ratio = max > 0 ? normalizedEarned / max : 0
  const hasDirectEvidence = evidenceIds.length > 0
  const hasFindings = findings.length > 0

  if (confidenceHint === 'heuristic') {
    return ratio >= 0.7 && hasFindings ? 'medium' : 'low'
  }

  if (confidenceHint === 'direct') {
    if (hasDirectEvidence && hasFindings) return 'high'
    if (hasFindings) return 'medium'
    return 'low'
  }

  if (hasDirectEvidence && hasFindings) return 'high'
  if (hasFindings || ratio >= 0.55) return 'medium'
  return 'low'
}

function summarizePageVisuals(images, videoCount) {
  const meaningfulImages = images.filter((image) => {
    const combined = `${image.alt} ${image.src}`.toLowerCase()
    const width = Number(image.width) || 0
    const height = Number(image.height) || 0
    const isTiny = (width > 0 && width < 80) || (height > 0 && height < 80)
    return !/logo|icon|avatar|favicon|sprite|badge/.test(combined) && !isTiny
  })
  const screenshotLikeImages = meaningfulImages.filter((image) => /screenshot|dashboard|result|graph|chart|example|case|report/.test(`${image.alt} ${image.src}`.toLowerCase()))

  return {
    meaningfulImageCount: meaningfulImages.length,
    decorativeImageCount: Math.max(0, images.length - meaningfulImages.length),
    screenshotLikeImages: screenshotLikeImages.length,
    videoCount,
  }
}

function isAuthorityLink(hostname) {
  return (
    /\.(gov|edu)$/.test(hostname) ||
    /wikipedia|nih\.gov|who\.int|forbes|bbc|nytimes|hubspot|google\.com|searchenginejournal|searchengineland/.test(hostname)
  )
}

function findSnippet(text, regex) {
  const match = String(text ?? '').match(regex)
  if (!match || typeof match.index !== 'number') return ''
  const source = String(text ?? '').replace(/\s+/g, ' ').trim()
  const start = Math.max(0, match.index - 60)
  const end = Math.min(source.length, match.index + match[0].length + 80)
  return source.slice(start, end).trim()
}

function extractVisibleContactSignals(text) {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim()
  const signals = []

  const emailMatch = source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  if (emailMatch) {
    signals.push(`email (${emailMatch[0]})`)
  }

  const phoneMatch = source.match(/(?:\+\d{1,2}\s?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]?\d{3,4}/i)
  if (phoneMatch) {
    signals.push(`phone (${phoneMatch[0]})`)
  }

  const addressMatch = source.match(/\b\d{1,4}\s+[A-Za-z0-9.'-]+\s+(street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd)\b/i)
  if (addressMatch) {
    signals.push(`address (${addressMatch[0]})`)
  }

  return signals
}

function dedupeResolvedLinks(links) {
  const seen = new Set()

  return links.filter((link) => {
    const key = `${link.resolved.hostname}${link.resolved.pathname}${link.resolved.search}|${normalizeText(link.text)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function groupLinksByIntent(links, patterns) {
  const found = new Set()

  links.forEach((link) => {
    const value = `${link.text} ${link.resolved.pathname}`
    for (const [label, pattern] of Object.entries(patterns)) {
      if (pattern.test(value)) {
        found.add(label)
      }
    }
  })

  return [...found]
}

async function capturePageVisual(targetUrl) {
  const executablePath = getBrowserExecutablePath()
  if (!executablePath) {
    return {
      available: false,
      note: 'No supported browser executable was found for screenshot capture on this machine.',
    }
  }

  let browser
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
    })
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1800 },
      deviceScaleFactor: 1,
    })
    page.setDefaultNavigationTimeout(15000)
    page.setDefaultTimeout(12000)
    await page.goto(targetUrl.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    })
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(1200).catch(() => {})
    const screenshotBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 72,
      fullPage: false,
    })

    const screenshotBase64 = screenshotBuffer.toString('base64')
    const pageTitle = await page.title()
    const visibleText = await page.locator('body').innerText().catch(() => '')
    const evidenceBlocks = await captureEvidenceBlocks(page)

    return {
      available: true,
      screenshotDataUrl: `data:image/jpeg;base64,${screenshotBase64}`,
      title: pageTitle,
      visibleTextPreview: String(visibleText || '').replace(/\s+/g, ' ').trim().slice(0, 600),
      note: `Screenshot captured from the live rendered page above the fold. ${evidenceBlocks.length} focused evidence block(s) were also captured from the same page.`,
      evidenceBlocks,
    }
  } catch (error) {
    return {
      available: false,
      note: error instanceof Error ? error.message : 'Visual capture failed.',
      evidenceBlocks: [],
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {})
    }
  }
}

async function withTimeout(taskPromise, timeoutMs, onTimeout) {
  let timeoutId

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      resolve(onTimeout())
    }, timeoutMs)
  })

  try {
    return await Promise.race([taskPromise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId)
  }
}

async function captureEvidenceBlocks(page) {
  const blocks = []

  const targetedBlocks = [
    {
      id: 'author-credibility',
      label: 'Author or reviewer evidence',
      selectors: [
        'text=/written by|about the author|author bio|author profile|meet the author|reviewed by|by [A-Z][a-z]+ [A-Z][a-z]+/i',
      ],
      note: 'Focused crop used to verify a visible author, reviewer, or named expert block.',
    },
    {
      id: 'first-hand-experience',
      label: 'Experience proof block',
      selectors: [
        'text=/case study|client results|our experience|we tested|we found|real example|from our work|our process/i',
      ],
      note: 'Focused crop used to verify first-hand experience or proof-of-work language.',
    },
    {
      id: 'reviewed-by',
      label: 'Reviewed-by or validation block',
      selectors: [
        'text=/reviewed by|fact checked|approved by|editorial review|medically reviewed/i',
      ],
      note: 'Focused crop used to verify review or validation language directly on the page.',
    },
      {
        id: 'contact-details',
        label: 'Contact details block',
        selectors: [
          'text=/contact|about us|about|team|@|street|road|avenue|phone|call/i',
        ],
        note: 'Focused crop used to verify visible contact details, location details, or direct trust-contact signals on the page.',
      },
      {
        id: 'policy-legal',
        label: 'Policy or warranty block',
        selectors: [
          'text=/privacy|terms|conditions|editorial|warranty|guarantee/i',
        ],
        note: 'Focused crop used to verify visible policy, legal, warranty, or guarantee wording directly on the page.',
      },
    ]

  for (const block of targetedBlocks) {
    const captured = await captureEvidenceBlock(page, block)
    if (captured) {
      blocks.push(captured)
    }
  }

  const openingBlock = await captureOpeningEvidenceBlock(page)
  if (openingBlock) {
    blocks.push(openingBlock)
  }

  return blocks
}

async function captureEvidenceBlock(page, config) {
  for (const selector of config.selectors) {
    const locator = page.locator(selector).first()
    const count = await locator.count().catch(() => 0)
    if (count < 1) continue

    const elementHandle = await locator.elementHandle().catch(() => null)
    if (!elementHandle) continue

    const containerHandle = await elementHandle.evaluateHandle((node) => {
      let current = node
      while (current && current !== document.body) {
        const rect = current.getBoundingClientRect()
        const text = (current.innerText || current.textContent || '').replace(/\s+/g, ' ').trim()
        if (rect.width >= 220 && rect.height >= 70 && text.length >= 24) {
          return current
        }
        current = current.parentElement
      }
      return node
    }).catch(() => null)

    const targetHandle = containerHandle?.asElement() ?? elementHandle
    if (!targetHandle) continue

    try {
      await targetHandle.scrollIntoViewIfNeeded().catch(() => {})
      const screenshotBuffer = await targetHandle.screenshot({
        type: 'jpeg',
        quality: 74,
        animations: 'disabled',
      })
      const evidenceText = await targetHandle.evaluate((node) => {
        const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim()
        return text.slice(0, 220)
      }).catch(() => '')

      return {
        id: config.id,
        label: config.label,
        screenshotDataUrl: `data:image/jpeg;base64,${screenshotBuffer.toString('base64')}`,
        note: config.note,
        matchedText: evidenceText,
      }
    } catch {
      continue
    }
  }

  return null
}

async function captureOpeningEvidenceBlock(page) {
  try {
    const viewport = page.viewportSize() ?? { width: 1440, height: 1800 }
    const screenshotBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 72,
      clip: {
        x: 0,
        y: 0,
        width: Math.min(viewport.width, 1280),
        height: Math.min(viewport.height, 760),
      },
    })
    const openingText = await page.locator('body').innerText().catch(() => '')

    return {
      id: 'opening-section',
      label: 'Opening section',
      screenshotDataUrl: `data:image/jpeg;base64,${screenshotBuffer.toString('base64')}`,
      note: 'Top-of-page crop used to judge answer-first structure and how quickly the page explains itself.',
      matchedText: String(openingText || '').replace(/\s+/g, ' ').trim().slice(0, 220),
    }
  } catch {
    return null
  }
}

function getBrowserExecutablePath() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ]

  return candidates.find((candidate) => {
    return fs.existsSync(candidate)
  }) ?? ''
}

function normalizeTokens(value) {
  return normalizeText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
}

function countMatchingTerms(tokens, haystack) {
  return tokens.reduce((count, token) => (haystack.includes(token) ? count + 1 : count), 0)
}

function inferIntent(keyword) {
  const normalized = normalizeText(keyword)

  if (/(buy|price|pricing|cost|quote|service|services|company|agency|near me|hire|book|best)/.test(normalized)) {
    return 'commercial'
  }
  if (/(how to|guide|tips|examples|what is|why|learn|tutorial)/.test(normalized)) {
    return 'informational'
  }
  if (/(login|sign in|dashboard|account|portal)/.test(normalized)) {
    return 'navigational'
  }

  return 'mixed'
}

function inferPageType(url, titleText, headingText, bodyText) {
  const combined = `${normalizeText(url)} ${titleText} ${headingText} ${bodyText.slice(0, 1200)}`

  if (/(\/blog\/|\/news\/|article|guide|learn|insights|tips)/.test(combined)) {
    return 'blog'
  }
  if (/(\/services\/|service|solutions|agency|consulting|company)/.test(combined)) {
    return 'service'
  }
  if (/(\/category\/|\/collections\/|category|shop|products)/.test(combined)) {
    return 'category'
  }
  if (/(^https?:\/\/[^/]+\/?$|home)/.test(url)) {
    return 'homepage'
  }

  return 'general'
}

function scorePageTypeAlignment(intent, pageType) {
  if (intent === 'commercial' && pageType === 'service') {
    return { score: 10, reason: 'Intent fit: commercial keyword aligns well with a service-style page. (+10)' }
  }
  if (intent === 'commercial' && pageType === 'category') {
    return { score: 8, reason: 'Intent fit: commercial keyword aligns reasonably well with a category-style page. (+8)' }
  }
  if (intent === 'commercial' && pageType === 'blog') {
    return { score: -10, reason: 'Intent mismatch: a blog-style page may be weaker for a commercial keyword. (-10)' }
  }
  if (intent === 'informational' && pageType === 'blog') {
    return { score: 10, reason: 'Intent fit: informational keyword aligns well with a blog or guide-style page. (+10)' }
  }
  if (intent === 'informational' && pageType === 'service') {
    return { score: -6, reason: 'Intent mismatch: a service page may be less ideal for an informational keyword. (-6)' }
  }

  return { score: 0, reason: 'Intent fit: neutral page-type alignment.' }
}

function haveMeaningfulOverlap(left, right) {
  const leftTokens = new Set(normalizeTokens(left))
  const rightTokens = normalizeTokens(right)
  const overlapCount = rightTokens.filter((token) => leftTokens.has(token)).length
  return overlapCount >= Math.max(2, Math.min(leftTokens.size, rightTokens.length) / 2)
}
