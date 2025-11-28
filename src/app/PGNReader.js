// src/app/PGNReader.js

import { chessLogic } from './chess/ChessLogic'
import LichessIterator from './iterator/LichessIterator'
import ChessComIterator from './iterator/ChessComIterator'
import PGNFileIterator from './iterator/PGNFileIterator'
import PGNUrlIterator from './iterator/PGNUrlIterator'
import * as Constants from './Constants'
import { expose } from 'comlink'

export default class PGNReader {
  constructor(variant) {
    this.totalGames = 0
    this.pendingGames = 0
    this.pendingDownloads = true
    this.variant = variant
    this.chess = chessLogic(this.variant)
    this.fen = this.chess.fen()
    this.continueProcessingGames = true
  }

  async fetchPGNFromSite(
    playerName,
    playerColor,
    site,
    shouldDownloadToFile,
    advancedFilters,
    notify,
    showError,
    stopDownloading,
    files,
    downloadResponse,
    tokens
  ) {
    this.continueProcessingGames = true

    const handleResponse = async (result, pendingDownloads) => {
      if (!result) {
        return this.continueProcessingGames
      }

      this.totalGames += result.length
      this.pendingGames += result.length
      this.pendingDownloads = pendingDownloads

      setTimeout(() => {
        this.parsePGNTimed(
          site,
          result,
          0,
          advancedFilters,
          playerColor,
          playerName,
          notify,
          showError,
          stopDownloading
        )
      }, 1)

      return this.continueProcessingGames
    }

    const processor = shouldDownloadToFile ? downloadResponse : handleResponse

    try {
      if (site === Constants.SITE_LICHESS) {
        const iterator = new LichessIterator(
          playerName,
          {
            variant: this.variant,
            ...advancedFilters
          },
          tokens?.lichess
        )

        for await (const pgn of iterator.iterate()) {
          await processor([pgn], iterator.gameCount < iterator.options.maxGames)
          
          if (!this.continueProcessingGames) break
        }
      } else if (site === Constants.SITE_CHESSCOM) {
        const iterator = new ChessComIterator(playerName, {
          variant: this.variant,
          ...advancedFilters
        })

        for await (const pgn of iterator.iterate()) {
          await processor([pgn], true)
          
          if (!this.continueProcessingGames) break
        }
      } else if (site === Constants.SITE_CUSTOM) {
        const file = files[0]
        const iterator = new PGNFileIterator(file, advancedFilters)

        for await (const pgn of iterator.iterate()) {
          await processor([pgn], true)
          
          if (!this.continueProcessingGames) break
        }
      }
    } catch (error) {
      showError('Download failed', error.message)
    }

    return 'done'
  }

  parsePGNTimed(
    site,
    pgnArray,
    index,
    advancedFilters,
    playerColor,
    playerName,
    notify,
    showError,
    stopDownloading
  ) {
    if (index < pgnArray.length) {
      this.pendingGames--
    }

    if (!this.pendingDownloads && this.pendingGames <= 0) {
      stopDownloading()
    }

    if (index >= pgnArray.length || !this.continueProcessingGames) {
      return
    }

    const pgn = pgnArray[index]

    // Parse PGN string into game object
    const parsedPgn = this.parsePgnString(pgn)

    // Ignore games with no moves or less than 2 moves
    if (
      parsedPgn.moves.length > 2 &&
      parsedPgn.moves[0] &&
      (parsedPgn.moves[0].move_number == null || parsedPgn.moves[0].move_number === 1)
    ) {
      const chess = this.chess
      chess.load(this.fen)
      let pgnParseFailed = false
      const parsedMoves = []

      parsedPgn.moves.forEach(element => {
        const sourceFen = chess.fen()
        const move = chess.move(element.move, { sloppy: true })
        const targetFen = chess.fen()

        if (!move) {
          if (!pgnParseFailed) {
            console.log('Failed to load game', parsedPgn.moves, element.move)
          }
          pgnParseFailed = true
          return
        }

        parsedMoves.push({
          sourceFen,
          targetFen,
          moveSan: move.san
        })
      })

      if (pgnParseFailed) {
        showError('Failed to load a game', `${playerName}:${playerColor}`)
      } else {
        const fen = chess.fen()
        const parsedPGNDetails = {
          pgnStats: this.gameResult(parsedPgn, site),
          parsedMoves,
          latestFen: fen,
          playerColor
        }

        notify(
          advancedFilters[Constants.FILTER_NAME_DOWNLOAD_LIMIT],
          1,
          parsedPGNDetails
        ).then(continueProcessingGames => {
          this.continueProcessingGames = continueProcessingGames
        })
      }
    }

    setTimeout(() => {
      this.parsePGNTimed(
        site,
        pgnArray,
        index + 1,
        advancedFilters,
        playerColor,
        playerName,
        notify,
        showError,
        stopDownloading
      )
    }, 1)
  }

  parsePgnString(pgnText) {
    const headers = {}
    const moves = []

    // Extract headers
    const headerRegex = /\[(\w+)\s+"([^"]*)"\]/g
    let match
    while ((match = headerRegex.exec(pgnText)) !== null) {
      headers[match[1]] = match[2]
    }

    // Extract result
    let result = '*'
    if (pgnText.includes('1-0')) result = '1-0'
    else if (pgnText.includes('0-1')) result = '0-1'
    else if (pgnText.includes('1/2-1/2')) result = '1/2-1/2'

    // Extract moves
    const movesText = pgnText
      .replace(/\[.*?\]\n/g, '')
      .replace(/\{[^}]*\}/g, '')
      .replace(/;[^\n]*/g, '')

    const movePattern = /(\d+\.+)\s*([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O(?:-O)?[+#]?)/g
    let moveMatch

    while ((moveMatch = movePattern.exec(movesText)) !== null) {
      const moveNum = parseInt(moveMatch[1], 10)
      moves.push({
        move_number: moveNum,
        move: moveMatch[2]
      })
    }

    return { headers, moves, result }
  }

  gameResult(pgn, site) {
    let url = null

    if (site === Constants.SITE_CHESSCOM) {
      url = pgn.headers.Link
    } else if (site === Constants.SITE_LICHESS) {
      url = pgn.headers.Site
    }

    let headers = null
    if (!url) {
      headers = pgn.headers
    }

    return {
      result: pgn.result,
      white: pgn.headers.White,
      black: pgn.headers.Black,
      whiteElo: pgn.headers.WhiteElo,
      blackElo: pgn.headers.BlackElo,
      url,
      date: pgn.headers.Date,
      headers,
      numberOfPlys: pgn.moves.length
    }
  }

  stopProcessing() {
    this.continueProcessingGames = false
  }
}

// Expose for Comlink
expose(PGNReader)
