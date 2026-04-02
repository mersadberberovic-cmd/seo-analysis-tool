# SEO Analysis Tool

A browser-based SEO analysis workspace built around your custom rules, findings, and audit ideas.

## Current features

- Spreadsheet opportunity analysis for CSV, TSV, XLSX, and XLS exports
- Flexible column detection for URL, keyword, search volume, ranking, difficulty, traffic, and relevance
- Opportunity scoring that blends ranking upside, search demand, relevance, page type, and intent fit
- Cannibalization detection when multiple URLs compete for the same keyword
- Live page scan that fetches a real page and evaluates keyword fit across URL, title, headings, and body copy
- Bulk live scans for the top dashboard shortlist
- Manual override controls so you can promote, demote, or mark rows for review
- An in-app opportunity dashboard with reasoning, instead of treating export as the default destination

## Getting started

```bash
npm install
npm run dev
```

## Current workflow

1. Upload a keyword or page export.
2. Review the surfaced dashboard shortlist and cannibalization warnings.
3. Run a live page scan on one row or bulk scan the shortlist.
4. Apply manual overrides when your strategist judgment should win.

## Next product direction

- saved projects and analyst notes
- bulk live scans for shortlisted rows
- exports for approved opportunities
- your next custom business rules and prioritization logic
