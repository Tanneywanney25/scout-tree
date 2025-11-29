// src/app/OpeningManager.js

import OpeningGraph from './OpeningGraph'
import PGNReaderWorker from './PGNReaderWorker'
import * as Constants from './Constants'

export default class OpeningManager {
  constructor(variant = Constants.VARIANT_STANDARD) {
    this.openingGraph = new OpeningGraph(variant)
    this.variant = variant
    this.reader = null
    this.isDownloading = false
  }

  async startDownload(options, callbacks) {
    const {
      playerName,
      playerColor,
      site,
      advancedFilters,
      files,
      tokens
    } = options

    const {
      onProgress,
      onComplete,
      onError
    } = callbacks

    this.isDownloading = true

    try {
      // Create worker instance
      this.reader = await new PGNReaderWorker(this.variant)

      const notify = async (limit, count, parsedGame) => {
        // Add to opening graph IMMEDIATELY
        this.openingGraph.addPGN(
          parsedGame.pgnStats,
          parsedGame.parsedMoves,
          parsedGame.latestFen,
          parsedGame.playerColor
        )

        // Update UI IMMEDIATELY for EVERY game (smooth counting 1, 2, 3...)
        if (onProgress) {
          onProgress({
            gamesProcessed: this.openingGraph.graph.pgnStats.length,
            currentGame: parsedGame.pgnStats
          })
        }

        // Check if limit reached
        if (limit && this.openingGraph.graph.pgnStats.length >= limit) {
          this.stopDownload()
          return false
        }

        return this.isDownloading
      }

      const showError = (title, message) => {
        if (onError) {
          onError({ title, message })
        }
      }

      const stopDownloading = () => {
        this.isDownloading = false
        if (onComplete) {
          onComplete({
            totalGames: this.openingGraph.graph.pgnStats.length,
            graph: this.openingGraph
          })
        }
      }

      await this.reader.fetchPGNFromSite(
        playerName,
        playerColor,
        site,
        false, // shouldDownloadToFile
        advancedFilters,
        notify,
        showError,
        stopDownloading,
        files,
        null, // downloadResponse
        tokens
      )
    } catch (error) {
      this.isDownloading = false
      if (onError) {
        onError({ title: 'Download failed', message: error.message })
      }
    }
  }

  stopDownload() {
    this.isDownloading = false
    if (this.reader) {
      this.reader.stopProcessing()
    }
  }

  getMovesForPosition(fen) {
    return this.openingGraph.getMovesForFen(fen)
  }

  getDetailsForPosition(fen) {
    return this.openingGraph.getDetailsForFen(fen)
  }

  getGameResults(fen) {
    return this.openingGraph.getGameResultsForFen(fen)
  }

  clear() {
    this.openingGraph.clear()
    this.isDownloading = false
  }

  serialize() {
    return this.openingGraph.serialize()
  }

  deserialize(data) {
    this.openingGraph.deserialize(data)
  }
}
