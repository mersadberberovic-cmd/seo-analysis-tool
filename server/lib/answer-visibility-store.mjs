import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const DATA_DIR = path.join(process.cwd(), 'server', 'data')
const STORE_PATH = path.join(DATA_DIR, 'answer-visibility-store.json')

const EMPTY_STORE = {
  schemaVersion: 1,
  campaigns: [],
  brands: [],
  prompts: [],
  runs: [],
  summarySnapshots: [],
}

function ensureStoreFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }

  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(EMPTY_STORE, null, 2))
  }
}

export function readAnswerVisibilityStore() {
  ensureStoreFile()
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      ...EMPTY_STORE,
      ...parsed,
      campaigns: parsed.campaigns ?? [],
      brands: parsed.brands ?? [],
      prompts: parsed.prompts ?? [],
      runs: parsed.runs ?? [],
      summarySnapshots: parsed.summarySnapshots ?? [],
    }
  } catch {
    return structuredClone(EMPTY_STORE)
  }
}

export function writeAnswerVisibilityStore(store) {
  ensureStoreFile()
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2))
}

export function createAnswerVisibilityId(prefix) {
  return `${prefix}_${randomUUID()}`
}

export function getAnswerVisibilityStorePath() {
  ensureStoreFile()
  return STORE_PATH
}
