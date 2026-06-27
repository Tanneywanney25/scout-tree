// src/app/PGNReaderWorker.js

import { wrap } from 'comlink'

const PGNReader = wrap(
  new Worker(
    new URL('./PGNReader.js', import.meta.url),
    { type: 'module' }
  )
)

export default PGNReader
