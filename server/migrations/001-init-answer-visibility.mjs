import fs from 'node:fs'
import path from 'node:path'

const dataDir = path.join(process.cwd(), 'server', 'data')
const storePath = path.join(dataDir, 'answer-visibility-store.json')

const initialStore = {
  schemaVersion: 1,
  campaigns: [],
  brands: [],
  prompts: [],
  runs: [],
  summarySnapshots: [],
}

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

if (!fs.existsSync(storePath)) {
  fs.writeFileSync(storePath, JSON.stringify(initialStore, null, 2))
  console.log(`Created ${storePath}`)
} else {
  console.log(`Store already exists at ${storePath}`)
}
