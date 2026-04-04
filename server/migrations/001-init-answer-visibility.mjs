import { getAnswerVisibilityDatabasePath, initializeAnswerVisibilityDb } from '../lib/answer-visibility-store.mjs'

initializeAnswerVisibilityDb()
console.log(`Answer visibility database ready at ${getAnswerVisibilityDatabasePath()}`)
