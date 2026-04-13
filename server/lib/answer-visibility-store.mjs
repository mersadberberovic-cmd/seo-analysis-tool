import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

const DATA_DIR = path.join(process.cwd(), 'server', 'data')
const DATABASE_PATH = path.join(DATA_DIR, 'answer-visibility.db')
const LEGACY_STORE_PATH = path.join(DATA_DIR, 'answer-visibility-store.json')

let database

function ensureDataDirectory() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

function ensureDatabase() {
  if (database) return database

  ensureDataDirectory()
  database = new Database(DATABASE_PATH)
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  initializeSchema(database)
  migrateLegacyJsonStore(database)
  return database
}

function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS brands (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      variations_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      intent TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      project_tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS run_jobs (
      id TEXT PRIMARY KEY,
      campaign_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_preference TEXT NOT NULL,
      request_payload_json TEXT NOT NULL,
      prompt_count INTEGER NOT NULL DEFAULT 0,
      completed_runs INTEGER NOT NULL DEFAULT 0,
      result_summary_json TEXT,
      error_message TEXT,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS run_configs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      provider_preference TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES run_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      job_id TEXT,
      checked_at TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      configuration_json TEXT NOT NULL,
      raw_answer_text TEXT NOT NULL,
      answer_snapshot TEXT NOT NULL,
      surfaced_domains_json TEXT NOT NULL,
      source_count INTEGER NOT NULL DEFAULT 0,
      previous_run_id TEXT,
      project_tag TEXT NOT NULL,
      intent TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      delta_primary_presence INTEGER,
      delta_primary_count INTEGER,
      delta_primary_first_position INTEGER,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY (prompt_id) REFERENCES prompts(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES run_jobs(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS citations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      url TEXT NOT NULL,
      domain TEXT NOT NULL,
      title TEXT NOT NULL,
      source_type TEXT,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS brand_mentions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      brand_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      answer_count INTEGER NOT NULL,
      citation_count INTEGER NOT NULL,
      total_count INTEGER NOT NULL,
      first_position INTEGER,
      appears_in TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS summary_snapshots (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      brand_ids_json TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS provider_health (
      provider TEXT PRIMARY KEY,
      configured INTEGER NOT NULL,
      reachable INTEGER NOT NULL,
      checked_at TEXT NOT NULL,
      latency_ms INTEGER,
      message TEXT NOT NULL,
      model TEXT,
      details_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS google_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL UNIQUE,
      google_account_id TEXT,
      email TEXT,
      display_name TEXT,
      picture_url TEXT,
      scope_json TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      token_expiry_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS google_oauth_states (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL UNIQUE,
      redirect_to TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS google_property_selections (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL UNIQUE,
      ga4_property_id TEXT,
      ga4_property_name TEXT,
      gsc_site_url TEXT,
      gsc_site_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (connection_id) REFERENCES google_connections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS clarity_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL UNIQUE,
      project_label TEXT,
      api_token TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_validated_at TEXT,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runs_campaign_checked ON runs(campaign_id, checked_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_prompt_checked ON runs(prompt_id, checked_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_status_requested ON run_jobs(status, requested_at ASC);
    CREATE INDEX IF NOT EXISTS idx_mentions_run_brand ON brand_mentions(run_id, brand_id);
    CREATE INDEX IF NOT EXISTS idx_google_oauth_states_state ON google_oauth_states(state);
  `)
}

function migrateLegacyJsonStore(db) {
  const runCount = db.prepare('SELECT COUNT(*) AS count FROM runs').get().count
  if (runCount > 0 || !fs.existsSync(LEGACY_STORE_PATH)) {
    return
  }

  try {
    const raw = fs.readFileSync(LEGACY_STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw)

    const insertCampaign = db.prepare('INSERT OR IGNORE INTO campaigns (id, name, project_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    const insertBrand = db.prepare('INSERT OR IGNORE INTO brands (id, campaign_id, type, name, variations_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const insertPrompt = db.prepare('INSERT OR IGNORE INTO prompts (id, campaign_id, prompt, intent, tags_json, project_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const insertRun = db.prepare(`
      INSERT OR IGNORE INTO runs (
        id, campaign_id, prompt_id, job_id, checked_at, provider, model, configuration_json,
        raw_answer_text, answer_snapshot, surfaced_domains_json, source_count, previous_run_id,
        project_tag, intent, tags_json, delta_primary_presence, delta_primary_count, delta_primary_first_position
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertCitation = db.prepare('INSERT OR IGNORE INTO citations (id, run_id, url, domain, title, source_type) VALUES (?, ?, ?, ?, ?, ?)')
    const insertMention = db.prepare('INSERT OR IGNORE INTO brand_mentions (id, run_id, brand_id, name, type, answer_count, citation_count, total_count, first_position, appears_in) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const insertSnapshot = db.prepare('INSERT OR IGNORE INTO summary_snapshots (id, campaign_id, brand_ids_json, checked_at, metrics_json) VALUES (?, ?, ?, ?, ?)')

    const tx = db.transaction(() => {
      for (const campaign of parsed.campaigns ?? []) {
        insertCampaign.run(campaign.id, campaign.name, campaign.projectTag ?? campaign.name, campaign.createdAt ?? new Date().toISOString(), campaign.updatedAt ?? new Date().toISOString())
      }

      for (const brand of parsed.brands ?? []) {
        insertBrand.run(brand.id, brand.campaignId, brand.type, brand.name, JSON.stringify(brand.variations ?? []), brand.createdAt ?? new Date().toISOString(), brand.updatedAt ?? new Date().toISOString())
      }

      for (const prompt of parsed.prompts ?? []) {
        insertPrompt.run(prompt.id, prompt.campaignId, prompt.prompt, prompt.intent ?? 'informational', JSON.stringify(prompt.tags ?? []), prompt.projectTag ?? '', prompt.createdAt ?? new Date().toISOString(), prompt.updatedAt ?? new Date().toISOString())
      }

      for (const run of parsed.runs ?? []) {
        insertRun.run(
          run.id,
          run.campaignId,
          run.promptId,
          run.checkedAt,
          run.provider ?? 'unknown',
          run.model ?? 'unknown',
          JSON.stringify(run.configuration ?? {}),
          run.rawAnswerText ?? '',
          run.answerSnapshot ?? '',
          JSON.stringify(run.surfacedDomains ?? []),
          run.sourceCount ?? 0,
          run.previousRunId ?? null,
          run.projectTag ?? '',
          run.intent ?? 'informational',
          JSON.stringify(run.tags ?? []),
          run.deltas?.primaryPresenceDelta ?? null,
          run.deltas?.primaryMentionCountDelta ?? null,
          run.deltas?.primaryFirstPositionDelta ?? null,
        )

        for (const citation of run.citations ?? []) {
          insertCitation.run(citation.id, run.id, citation.url ?? '', citation.domain ?? '', citation.title ?? '', citation.sourceType ?? null)
        }

        for (const mention of run.mentionSummary?.brandMentions ?? []) {
          insertMention.run(
            createAnswerVisibilityId('mention'),
            run.id,
            mention.brandId,
            mention.name,
            mention.type,
            mention.answerCount ?? 0,
            mention.citationCount ?? 0,
            mention.totalCount ?? 0,
            mention.firstPosition ?? null,
            mention.appearsIn ?? 'none',
          )
        }
      }

      for (const snapshot of parsed.summarySnapshots ?? []) {
        insertSnapshot.run(snapshot.id, snapshot.campaignId, JSON.stringify(snapshot.brandIds ?? []), snapshot.checkedAt ?? new Date().toISOString(), JSON.stringify(snapshot.metrics ?? {}))
      }
    })

    tx()
  } catch (error) {
    console.warn('Could not migrate legacy answer visibility store.', error)
  }
}

export function createAnswerVisibilityId(prefix) {
  return `${prefix}_${randomUUID()}`
}

export function initializeAnswerVisibilityDb() {
  ensureDatabase()
  return DATABASE_PATH
}

export function getAnswerVisibilityDatabasePath() {
  ensureDatabase()
  return DATABASE_PATH
}

export function createAnswerVisibilityJobRecord({ campaignId = null, type, providerPreference, payload, promptCount, requestedAt }) {
  const db = ensureDatabase()
  const id = createAnswerVisibilityId('job')
  db.prepare(`
    INSERT INTO run_jobs (
      id, campaign_id, type, status, provider_preference, request_payload_json,
      prompt_count, completed_runs, result_summary_json, error_message,
      requested_at, started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, 'queued', ?, ?, ?, 0, NULL, NULL, ?, NULL, NULL, ?)
  `).run(id, campaignId, type, providerPreference, JSON.stringify(payload), promptCount, requestedAt, requestedAt)
  return getAnswerVisibilityJobRecord(id)
}

export function updateAnswerVisibilityJobStatus({ jobId, status, startedAt = null, completedAt = null, updatedAt, errorMessage = null, completedRuns = null, resultSummary = null, campaignId = undefined }) {
  const db = ensureDatabase()
  const current = getAnswerVisibilityJobRecord(jobId)
  if (!current) return null

  db.prepare(`
    UPDATE run_jobs
    SET campaign_id = ?, status = ?, started_at = ?, completed_at = ?, updated_at = ?, error_message = ?, completed_runs = ?, result_summary_json = ?
    WHERE id = ?
  `).run(
    campaignId === undefined ? current.campaignId : campaignId,
    status,
    startedAt ?? current.startedAt,
    completedAt ?? current.completedAt,
    updatedAt,
    errorMessage,
    completedRuns ?? current.completedRuns,
    resultSummary ? JSON.stringify(resultSummary) : (current.resultSummary ? JSON.stringify(current.resultSummary) : null),
    jobId,
  )

  return getAnswerVisibilityJobRecord(jobId)
}

export function listQueuedAnswerVisibilityJobs() {
  const db = ensureDatabase()
  return db.prepare(`
    SELECT * FROM run_jobs
    WHERE status IN ('queued', 'running')
    ORDER BY requested_at ASC
  `).all().map(mapJobRow)
}

export function getAnswerVisibilityJobRecord(jobId) {
  const db = ensureDatabase()
  const row = db.prepare('SELECT * FROM run_jobs WHERE id = ?').get(jobId)
  return row ? mapJobRow(row) : null
}

export function createRunConfigRecord({ jobId, providerPreference, promptVersion, config, createdAt }) {
  const db = ensureDatabase()
  const id = createAnswerVisibilityId('runconfig')
  db.prepare('INSERT INTO run_configs (id, job_id, provider_preference, prompt_version, config_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    jobId,
    providerPreference,
    promptVersion,
    JSON.stringify(config),
    createdAt,
  )
  return { id, jobId, providerPreference, promptVersion, config, createdAt }
}

export function upsertCampaignRecord({ name, projectTag, now }) {
  const db = ensureDatabase()
  const normalizedName = normalizeText(name)
  const existing = db.prepare('SELECT * FROM campaigns').all().find((item) => normalizeText(item.name) === normalizedName)

  if (existing) {
    db.prepare('UPDATE campaigns SET project_tag = ?, updated_at = ? WHERE id = ?').run(projectTag || existing.project_tag, now, existing.id)
    return mapCampaignRow(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(existing.id))
  }

  const id = createAnswerVisibilityId('campaign')
  db.prepare('INSERT INTO campaigns (id, name, project_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, name, projectTag || name, now, now)
  return mapCampaignRow(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id))
}

export function upsertBrandRecords({ campaignId, brands, now }) {
  const db = ensureDatabase()
  const all = db.prepare('SELECT * FROM brands WHERE campaign_id = ?').all(campaignId)

  return brands.map((brandInput) => {
    const existing = all.find((brand) => brand.type === brandInput.type && normalizeText(brand.name) === normalizeText(brandInput.name))
    if (existing) {
      const mergedVariations = unique([...parseJsonArray(existing.variations_json), ...(brandInput.variations ?? [])])
      db.prepare('UPDATE brands SET variations_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(mergedVariations), now, existing.id)
      return mapBrandRow(db.prepare('SELECT * FROM brands WHERE id = ?').get(existing.id))
    }

    const id = createAnswerVisibilityId('brand')
    db.prepare('INSERT INTO brands (id, campaign_id, type, name, variations_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      campaignId,
      brandInput.type,
      brandInput.name,
      JSON.stringify(unique(brandInput.variations ?? [])),
      now,
      now,
    )
    return mapBrandRow(db.prepare('SELECT * FROM brands WHERE id = ?').get(id))
  })
}

export function upsertPromptRecords({ campaignId, prompts, now }) {
  const db = ensureDatabase()
  const existingRows = db.prepare('SELECT * FROM prompts WHERE campaign_id = ?').all(campaignId)

  return prompts.map((promptInput) => {
    const existing = existingRows.find((prompt) => normalizeText(prompt.prompt) === normalizeText(promptInput.prompt))
    if (existing) {
      const mergedTags = unique([...parseJsonArray(existing.tags_json), ...(promptInput.tags ?? [])])
      db.prepare('UPDATE prompts SET intent = ?, tags_json = ?, project_tag = ?, updated_at = ? WHERE id = ?').run(
        promptInput.intent || existing.intent,
        JSON.stringify(mergedTags),
        promptInput.projectTag || existing.project_tag,
        now,
        existing.id,
      )
      return mapPromptRow(db.prepare('SELECT * FROM prompts WHERE id = ?').get(existing.id))
    }

    const id = createAnswerVisibilityId('prompt')
    db.prepare('INSERT INTO prompts (id, campaign_id, prompt, intent, tags_json, project_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      campaignId,
      promptInput.prompt,
      promptInput.intent,
      JSON.stringify(promptInput.tags ?? []),
      promptInput.projectTag ?? '',
      now,
      now,
    )
    return mapPromptRow(db.prepare('SELECT * FROM prompts WHERE id = ?').get(id))
  })
}

export function getPromptRecordsByIds(promptIds) {
  const db = ensureDatabase()
  const stmt = db.prepare(`SELECT * FROM prompts WHERE id IN (${promptIds.map(() => '?').join(',')})`)
  return stmt.all(...promptIds).map(mapPromptRow)
}

export function getBrandsForCampaign(campaignId) {
  const db = ensureDatabase()
  return db.prepare('SELECT * FROM brands WHERE campaign_id = ? ORDER BY type, name').all(campaignId).map(mapBrandRow)
}

export function findCampaignById(campaignId) {
  const db = ensureDatabase()
  const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId)
  return row ? mapCampaignRow(row) : null
}

export function findLatestRunForPrompt(promptId) {
  const db = ensureDatabase()
  const row = db.prepare('SELECT * FROM runs WHERE prompt_id = ? ORDER BY checked_at DESC LIMIT 1').get(promptId)
  return row ? assembleRunRecord(row) : null
}

export function insertRunRecord({
  campaignId,
  promptId,
  jobId,
  checkedAt,
  provider,
  model,
  configuration,
  rawAnswerText,
  answerSnapshot,
  surfacedDomains,
  sourceCount,
  previousRunId,
  projectTag,
  intent,
  tags,
  deltas,
  citations,
  brandMentions,
}) {
  const db = ensureDatabase()
  const runId = createAnswerVisibilityId('run')

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO runs (
        id, campaign_id, prompt_id, job_id, checked_at, provider, model, configuration_json,
        raw_answer_text, answer_snapshot, surfaced_domains_json, source_count, previous_run_id,
        project_tag, intent, tags_json, delta_primary_presence, delta_primary_count, delta_primary_first_position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      campaignId,
      promptId,
      jobId,
      checkedAt,
      provider,
      model,
      JSON.stringify(configuration),
      rawAnswerText,
      answerSnapshot,
      JSON.stringify(surfacedDomains),
      sourceCount,
      previousRunId,
      projectTag,
      intent,
      JSON.stringify(tags ?? []),
      deltas.primaryPresenceDelta,
      deltas.primaryMentionCountDelta,
      deltas.primaryFirstPositionDelta,
    )

    const insertCitation = db.prepare('INSERT INTO citations (id, run_id, url, domain, title, source_type) VALUES (?, ?, ?, ?, ?, ?)')
    for (const citation of citations) {
      insertCitation.run(createAnswerVisibilityId('citation'), runId, citation.url, citation.domain, citation.title || '', citation.sourceType || null)
    }

    const insertMention = db.prepare('INSERT INTO brand_mentions (id, run_id, brand_id, name, type, answer_count, citation_count, total_count, first_position, appears_in) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const mention of brandMentions) {
      insertMention.run(
        createAnswerVisibilityId('mention'),
        runId,
        mention.brandId,
        mention.name,
        mention.type,
        mention.answerCount,
        mention.citationCount,
        mention.totalCount,
        mention.firstPosition,
        mention.appearsIn,
      )
    }
  })

  tx()
  return assembleRunRecord(db.prepare('SELECT * FROM runs WHERE id = ?').get(runId))
}

export function replaceSummarySnapshot({ campaignId, brandIds, checkedAt, metrics }) {
  const db = ensureDatabase()
  db.prepare('DELETE FROM summary_snapshots WHERE campaign_id = ?').run(campaignId)
  const id = createAnswerVisibilityId('summary')
  db.prepare('INSERT INTO summary_snapshots (id, campaign_id, brand_ids_json, checked_at, metrics_json) VALUES (?, ?, ?, ?, ?)').run(
    id,
    campaignId,
    JSON.stringify(brandIds),
    checkedAt,
    JSON.stringify(metrics),
  )
  return { id, campaignId, brandIds, checkedAt, metrics }
}

export function saveProviderHealthRecord({ provider, configured, reachable, checkedAt, latencyMs, message, model, details }) {
  const db = ensureDatabase()
  db.prepare(`
    INSERT INTO provider_health (provider, configured, reachable, checked_at, latency_ms, message, model, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      configured=excluded.configured,
      reachable=excluded.reachable,
      checked_at=excluded.checked_at,
      latency_ms=excluded.latency_ms,
      message=excluded.message,
      model=excluded.model,
      details_json=excluded.details_json
  `).run(provider, Number(configured), Number(reachable), checkedAt, latencyMs, message, model, JSON.stringify(details ?? {}))
  return getProviderHealthRecords().find((item) => item.provider === provider) ?? null
}

export function getProviderHealthRecords() {
  const db = ensureDatabase()
  return db.prepare('SELECT * FROM provider_health ORDER BY provider ASC').all().map((row) => ({
    provider: row.provider,
    configured: Boolean(row.configured),
    reachable: Boolean(row.reachable),
    checkedAt: row.checked_at,
    latencyMs: row.latency_ms,
    message: row.message,
    model: row.model,
    details: parseJsonObject(row.details_json),
  }))
}

export function createGoogleOauthStateRecord({ redirectTo = '', createdAt, expiresAt }) {
  const db = ensureDatabase()
  const id = createAnswerVisibilityId('google_state')
  const state = randomUUID()
  db.prepare('INSERT INTO google_oauth_states (id, state, redirect_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    state,
    redirectTo,
    createdAt,
    expiresAt,
  )
  return { id, state, redirectTo, createdAt, expiresAt }
}

export function consumeGoogleOauthStateRecord(state) {
  const db = ensureDatabase()
  const row = db.prepare('SELECT * FROM google_oauth_states WHERE state = ?').get(state)
  if (!row) return null
  db.prepare('DELETE FROM google_oauth_states WHERE state = ?').run(state)
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return null
  }
  return {
    id: row.id,
    state: row.state,
    redirectTo: row.redirect_to,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

export function upsertGoogleConnectionRecord({
  provider = 'google',
  googleAccountId = null,
  email = null,
  displayName = null,
  pictureUrl = null,
  scope = [],
  accessToken = null,
  refreshToken = null,
  tokenExpiryAt = null,
  now,
}) {
  const db = ensureDatabase()
  const existing = db.prepare('SELECT * FROM google_connections WHERE provider = ?').get(provider)

  if (existing) {
    db.prepare(`
      UPDATE google_connections
      SET google_account_id = ?, email = ?, display_name = ?, picture_url = ?, scope_json = ?, access_token = ?, refresh_token = ?, token_expiry_at = ?, updated_at = ?
      WHERE provider = ?
    `).run(
      googleAccountId ?? existing.google_account_id,
      email ?? existing.email,
      displayName ?? existing.display_name,
      pictureUrl ?? existing.picture_url,
      JSON.stringify(scope ?? parseJsonArray(existing.scope_json)),
      accessToken ?? existing.access_token,
      refreshToken ?? existing.refresh_token,
      tokenExpiryAt ?? existing.token_expiry_at,
      now,
      provider,
    )
    return getGoogleConnectionRecord(provider)
  }

  const id = createAnswerVisibilityId('google_connection')
  db.prepare(`
    INSERT INTO google_connections (
      id, provider, google_account_id, email, display_name, picture_url, scope_json,
      access_token, refresh_token, token_expiry_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    provider,
    googleAccountId,
    email,
    displayName,
    pictureUrl,
    JSON.stringify(scope ?? []),
    accessToken,
    refreshToken,
    tokenExpiryAt,
    now,
    now,
  )
  return getGoogleConnectionRecord(provider)
}

export function getGoogleConnectionRecord(provider = 'google') {
  const db = ensureDatabase()
  const row = db.prepare('SELECT * FROM google_connections WHERE provider = ?').get(provider)
  if (!row) return null
  return {
    id: row.id,
    provider: row.provider,
    googleAccountId: row.google_account_id,
    email: row.email,
    displayName: row.display_name,
    pictureUrl: row.picture_url,
    scope: parseJsonArray(row.scope_json),
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    tokenExpiryAt: row.token_expiry_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function saveGooglePropertySelectionRecord({
  connectionId,
  ga4PropertyId = null,
  ga4PropertyName = null,
  gscSiteUrl = null,
  gscSiteName = null,
  now,
}) {
  const db = ensureDatabase()
  const existing = db.prepare('SELECT * FROM google_property_selections WHERE connection_id = ?').get(connectionId)

  if (existing) {
    db.prepare(`
      UPDATE google_property_selections
      SET ga4_property_id = ?, ga4_property_name = ?, gsc_site_url = ?, gsc_site_name = ?, updated_at = ?
      WHERE connection_id = ?
    `).run(
      ga4PropertyId,
      ga4PropertyName,
      gscSiteUrl,
      gscSiteName,
      now,
      connectionId,
    )
  } else {
    db.prepare(`
      INSERT INTO google_property_selections (
        id, connection_id, ga4_property_id, ga4_property_name, gsc_site_url, gsc_site_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      createAnswerVisibilityId('google_selection'),
      connectionId,
      ga4PropertyId,
      ga4PropertyName,
      gscSiteUrl,
      gscSiteName,
      now,
      now,
    )
  }

  return getGooglePropertySelectionRecord(connectionId)
}

export function getGooglePropertySelectionRecord(connectionId) {
  const db = ensureDatabase()
  const row = db.prepare('SELECT * FROM google_property_selections WHERE connection_id = ?').get(connectionId)
  if (!row) return null
  return {
    id: row.id,
    connectionId: row.connection_id,
    ga4PropertyId: row.ga4_property_id,
    ga4PropertyName: row.ga4_property_name,
    gscSiteUrl: row.gsc_site_url,
    gscSiteName: row.gsc_site_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function upsertClarityConnectionRecord({
  provider = 'clarity',
  projectLabel = null,
  apiToken = null,
  source = 'saved',
  lastValidatedAt = null,
  lastError = null,
  now,
}) {
  const db = ensureDatabase()
  const existing = db.prepare('SELECT * FROM clarity_connections WHERE provider = ?').get(provider)

  if (existing) {
    db.prepare(`
      UPDATE clarity_connections
      SET project_label = ?, api_token = ?, source = ?, updated_at = ?, last_validated_at = ?, last_error = ?
      WHERE provider = ?
    `).run(
      projectLabel ?? existing.project_label,
      apiToken ?? existing.api_token,
      source ?? existing.source,
      now,
      lastValidatedAt ?? existing.last_validated_at,
      lastError,
      provider,
    )
  } else {
    db.prepare(`
      INSERT INTO clarity_connections (
        id, provider, project_label, api_token, source, created_at, updated_at, last_validated_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      createAnswerVisibilityId('clarity_connection'),
      provider,
      projectLabel,
      apiToken,
      source,
      now,
      now,
      lastValidatedAt,
      lastError,
    )
  }

  return getClarityConnectionRecord(provider)
}

export function getClarityConnectionRecord(provider = 'clarity') {
  const db = ensureDatabase()
  const row = db.prepare('SELECT * FROM clarity_connections WHERE provider = ?').get(provider)
  if (!row) return null
  return {
    id: row.id,
    provider: row.provider,
    projectLabel: row.project_label,
    apiToken: row.api_token,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastValidatedAt: row.last_validated_at,
    lastError: row.last_error,
  }
}

export function deleteClarityConnectionRecord(provider = 'clarity') {
  const db = ensureDatabase()
  db.prepare('DELETE FROM clarity_connections WHERE provider = ?').run(provider)
}

export function getAnswerVisibilityStoreSnapshot() {
  const db = ensureDatabase()
  const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY updated_at DESC').all().map(mapCampaignRow)
  const brands = db.prepare('SELECT * FROM brands ORDER BY updated_at DESC').all().map(mapBrandRow)
  const prompts = db.prepare('SELECT * FROM prompts ORDER BY updated_at DESC').all().map(mapPromptRow)
  const runs = db.prepare('SELECT * FROM runs ORDER BY checked_at DESC').all().map(assembleRunRecord)
  const summarySnapshots = db.prepare('SELECT * FROM summary_snapshots ORDER BY checked_at DESC').all().map((row) => ({
    id: row.id,
    campaignId: row.campaign_id,
    brandIds: parseJsonArray(row.brand_ids_json),
    checkedAt: row.checked_at,
    metrics: parseJsonObject(row.metrics_json),
  }))
  return { campaigns, brands, prompts, runs, summarySnapshots }
}

export function getCampaignRunRecords(campaignId) {
  const db = ensureDatabase()
  return db.prepare('SELECT * FROM runs WHERE campaign_id = ? ORDER BY checked_at DESC').all(campaignId).map(assembleRunRecord)
}

export function mapCampaignRow(row) {
  return {
    id: row.id,
    name: row.name,
    projectTag: row.project_tag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapBrandRow(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    type: row.type,
    name: row.name,
    variations: parseJsonArray(row.variations_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapPromptRow(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    prompt: row.prompt,
    intent: row.intent,
    tags: parseJsonArray(row.tags_json),
    projectTag: row.project_tag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapJobRow(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    type: row.type,
    status: row.status,
    providerPreference: row.provider_preference,
    payload: parseJsonObject(row.request_payload_json),
    promptCount: row.prompt_count,
    completedRuns: row.completed_runs,
    resultSummary: parseJsonObject(row.result_summary_json),
    errorMessage: row.error_message,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  }
}

function assembleRunRecord(row) {
  const db = ensureDatabase()
  const citations = db.prepare('SELECT * FROM citations WHERE run_id = ? ORDER BY id ASC').all(row.id).map((citation) => ({
    id: citation.id,
    url: citation.url,
    domain: citation.domain,
    title: citation.title,
    sourceType: citation.source_type,
  }))

  const brandMentions = db.prepare('SELECT * FROM brand_mentions WHERE run_id = ? ORDER BY total_count DESC, name ASC').all(row.id).map((mention) => ({
    brandId: mention.brand_id,
    name: mention.name,
    type: mention.type,
    answerCount: mention.answer_count,
    citationCount: mention.citation_count,
    totalCount: mention.total_count,
    firstPosition: mention.first_position,
    appearsIn: mention.appears_in,
  }))

  const primary = brandMentions.find((item) => item.type === 'primary') || null
  const sortedByPosition = brandMentions.filter((item) => item.firstPosition !== null).sort((a, b) => a.firstPosition - b.firstPosition)

  return {
    id: row.id,
    campaignId: row.campaign_id,
    promptId: row.prompt_id,
    jobId: row.job_id,
    checkedAt: row.checked_at,
    provider: row.provider,
    model: row.model,
    configuration: parseJsonObject(row.configuration_json),
    rawAnswerText: row.raw_answer_text,
    answerSnapshot: row.answer_snapshot,
    citations,
    surfacedDomains: parseJsonArray(row.surfaced_domains_json),
    sourceCount: row.source_count,
    previousRunId: row.previous_run_id,
    projectTag: row.project_tag,
    intent: row.intent,
    tags: parseJsonArray(row.tags_json),
    mentionSummary: {
      brandMentions,
      primaryBrandMentioned: Boolean(primary && primary.totalCount > 0),
      primaryBrandMentionCount: primary?.totalCount ?? 0,
      primaryBrandFirstPosition: primary?.firstPosition ?? null,
      firstMentionedBrand: sortedByPosition[0]?.name ?? null,
      firstMentionedBrandId: sortedByPosition[0]?.brandId ?? null,
      competitorMentionCounts: brandMentions.filter((item) => item.type === 'competitor').map((item) => ({
        brandId: item.brandId,
        name: item.name,
        count: item.totalCount,
        firstPosition: item.firstPosition,
      })),
      totalMentions: brandMentions.reduce((sum, item) => sum + item.totalCount, 0),
      shareOfMentions: [],
    },
    deltas: {
      primaryPresenceDelta: row.delta_primary_presence,
      primaryMentionCountDelta: row.delta_primary_count,
      primaryFirstPositionDelta: row.delta_primary_first_position,
    },
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseJsonObject(value) {
  try {
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function unique(items) {
  return [...new Set(items.filter(Boolean))]
}
