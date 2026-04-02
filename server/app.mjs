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

app.get('/api/eeat-scan', async (request, response) => {
  const targetUrl = String(request.query.url ?? '').trim()

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
    const analysis = analyzeEeat({ page })

    response.json({
      url: parsedUrl.toString(),
      title: page.title,
      analysis,
    })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unexpected EEAT scan failure.',
    })
  }
})

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
  })

  if (!fetched.ok) {
    throw new Error(`Could not fetch page. Status ${fetched.status}.`)
  }

  const html = await fetched.text()
  const $ = cheerio.load(html)
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
  const jsonLd = $('script[type="application/ld+json"]')
    .map((_index, element) => $(element).html() ?? '')
    .get()
    .filter(Boolean)

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
    html,
  }
}

function analyzeEeat(input) {
  const { page } = input
  const firstWords = page.bodyText.split(/\s+/).slice(0, 85).join(' ').trim()
  const wordCount = page.bodyText.split(/\s+/).filter(Boolean).length
  const internalLinks = page.links
    .map((link) => {
      try {
        const resolved = new URL(link.href, page.url)
        return { ...link, resolved }
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const outboundLinks = internalLinks.filter((link) => link.resolved.hostname !== page.hostname)
  const onPageTrustLinks = internalLinks.filter((link) => link.resolved.hostname === page.hostname)
  const visualSummary = summarizePageVisuals(page.images, page.videos)

  const categories = [
    detectAuthorSignals(page),
    detectExperienceSignals(page, visualSummary),
    detectAuthoritySignals(page, onPageTrustLinks),
    detectReviewSignals(page),
    detectTransparencySignals(page, onPageTrustLinks),
    detectSchemaSignals(page.jsonLd),
    detectAnswerSignals(firstWords, page.headings),
    detectDataSignals(page.bodyText),
    detectConversationalSignals(page, firstWords),
    detectOutboundLinkSignals(outboundLinks),
    detectThirdPartyReviewSignals(outboundLinks),
  ]

  const earnedPoints = categories.reduce((sum, category) => sum + category.earned, 0)
  const score = Math.round((earnedPoints / 100) * 100)
  const strengths = categories.filter((category) => category.earned >= category.max * 0.7).map((category) => `${category.label}: ${category.summary}`)
  const priorities = categories.filter((category) => category.earned < category.max * 0.55).map((category) => `${category.label}: ${category.recommendation}`)

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
      totalPoints: 100,
      explanation: 'The EEAT score is the sum of weighted page-level categories. Each category has a fixed maximum point value and only visible signals on the scanned page count.',
      categories: categories.map((category) => ({
        id: category.id,
        label: category.label,
        earned: category.earned,
        max: category.max,
      })),
    },
    strengths,
    priorities,
    visualSummary,
    categories,
    firstWords,
    title: page.title,
    metaDescription: page.metaDescription,
    pageSignals: {
      wordCount,
      headingCount: page.headings.length,
      trustLinkCount: onPageTrustLinks.filter((link) => /(about|contact|privacy|policy|terms|editorial|team)/i.test(`${link.text} ${link.resolved.pathname}`)).length,
      outboundLinkCount: outboundLinks.length,
      authoritativeOutboundLinkCount: outboundLinks.filter((link) => isAuthorityLink(link.resolved.hostname)).length,
    },
  }
}

function detectAuthorSignals(page) {
  const snippet = findSnippet(page.bodyText, /(written by|author|about the author|bio|credentials|esq|phd|md|dr\.)/i)
  const socialLinks = page.links.filter((link) => /linkedin|x\.com|twitter|github|instagram|facebook/.test(link.href))
  let earned = 0
  const findings = []
  const gaps = []

  if (snippet) {
    earned += 8
    findings.push(`Found author or credential language on the page: "${snippet}"`)
  } else {
    gaps.push('No clear author name, bio, or credential block was found in the visible page copy.')
  }

  if (socialLinks.length > 0) {
    earned += Math.min(4, socialLinks.length * 2)
    findings.push(`Found ${socialLinks.length} visible profile/social link(s) on the page.`)
  } else {
    gaps.push('No visible social or profile links were detected on the page.')
  }

  return buildEeatCategory({
    id: 'author-credibility',
    label: 'Visible author credibility',
    max: 12,
    earned,
    summary: snippet ? 'The page includes at least one visible author or credential signal.' : 'Author credibility is not clearly established on the page itself.',
    findings,
    gaps,
    recommendation: snippet
      ? 'Make the author block more explicit with role, credentials, and why this author is qualified to write this page.'
      : 'Add a visible author section with name, credentials, role, and a short expertise summary directly on the page.',
  })
}

function detectExperienceSignals(page, visualSummary) {
  const firstHandSnippet = findSnippet(page.bodyText, /(case study|we tested|we found|our experience|from our work|we implemented|client results|real example|example from)/i)
  let earned = 0
  const findings = []
  const gaps = []

  if (firstHandSnippet) {
    earned += 6
    findings.push(`Found first-hand or case-study style wording: "${firstHandSnippet}"`)
  } else {
    gaps.push('No clear first-hand, case-study, or tested-in-practice language was detected in the page copy.')
  }

  if (visualSummary.meaningfulImageCount > 0) {
    earned += Math.min(4, visualSummary.meaningfulImageCount * 2)
    findings.push(`Detected ${visualSummary.meaningfulImageCount} meaningful image(s) that look more substantial than logos/icons.`)
  } else {
    gaps.push('No meaningful on-page images were detected beyond likely decorative assets.')
  }

  if (visualSummary.videoCount > 0 || visualSummary.screenshotLikeImages > 0) {
    earned += 2
    findings.push(`Detected ${visualSummary.videoCount} video/embed(s) and ${visualSummary.screenshotLikeImages} screenshot-like image(s).`)
  } else {
    gaps.push('No video embeds or screenshot-like proof assets were detected on the page.')
  }

  return buildEeatCategory({
    id: 'first-hand-experience',
    label: 'Demonstrated first-hand experience',
    max: 12,
    earned,
    summary: firstHandSnippet || visualSummary.meaningfulImageCount > 0
      ? 'The page shows some evidence of experience, but the proof strength depends on how explicit those examples are.'
      : 'The page reads more like general advice than demonstrated first-hand experience.',
    findings,
    gaps,
    recommendation: 'Add concrete proof of experience on the page such as original screenshots, before/after examples, case-study blocks, or clearly stated outcomes from real work.',
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
  })
}

function detectTransparencySignals(page, internalLinks) {
  const helperLinks = internalLinks.filter((link) => /(about|contact|privacy|policy|terms|editorial|team)/i.test(`${link.text} ${link.resolved.pathname}`))
  const emailSnippet = findSnippet(page.bodyText, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  const phoneSnippet = findSnippet(page.bodyText, /(?:\+\d{1,2}\s?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]?\d{3,4}/i)
  let earned = 0
  const findings = []
  const gaps = []

  if (helperLinks.length > 0) {
    earned += Math.min(6, helperLinks.length * 2)
    findings.push(`Found ${helperLinks.length} visible trust-oriented link(s) on the page, such as About, Contact, Privacy, or Terms.`)
  } else {
    gaps.push('No visible About, Contact, Privacy, Terms, or Editorial links were detected on the page.')
  }

  if (emailSnippet || phoneSnippet) {
    earned += 4
    findings.push(`Contact detail detected on the page: "${emailSnippet ?? phoneSnippet}"`)
  } else {
    gaps.push('No visible email address or phone number was detected in the page copy.')
  }

  return buildEeatCategory({
    id: 'transparency-safety',
    label: 'Transparency and safety',
    max: 10,
    earned,
    summary: earned >= 6
      ? 'The page exposes some visible trust and transparency signals.'
      : 'The page does not make trust and transparency signals visible enough on-page.',
    findings,
    gaps,
    recommendation: 'Expose trust signals more clearly on the page with visible contact details, trust-policy links, and editorial/update information where relevant.',
  })
}

function detectSchemaSignals(jsonLdBlocks) {
  const normalizedSchema = jsonLdBlocks.join(' ').toLowerCase()
  const findings = []
  let earned = 0

  if (jsonLdBlocks.length > 0) {
    earned += 2
    findings.push(`Detected ${jsonLdBlocks.length} JSON-LD block(s).`)
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

function buildEeatCategory({ id, label, max, earned, summary, findings, gaps, recommendation }) {
  return {
    id,
    label,
    max,
    earned: Math.max(0, Math.min(max, earned)),
    summary,
    findings,
    gaps,
    recommendation,
  }
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
