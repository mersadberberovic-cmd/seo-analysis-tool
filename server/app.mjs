import express from 'express'
import * as cheerio from 'cheerio'

const app = express()
const port = 4174

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

app.listen(port, () => {
  console.log(`SEO analysis server listening on http://localhost:${port}`)
})

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

function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9\s-]+/g, ' ')
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
