// src/app/iterator/ChessComIterator.js

import BaseUrlIterator from './BaseUrlIterator'
import * as Constants from '../Constants'
import { delay } from '../Common'

export default class ChessComIterator {
  constructor(username, options = {}) {
    this.username = username.toLowerCase()
    this.options = options
    this.monthUrls = []
    this.currentIterator = null
    this.gameCount = 0
    this.totalGamesAvailable = null
  }

  async *iterate() {
    // Get archive URLs
    const archiveUrl = `${Constants.CHESSCOM_API}/player/${this.username}/games/archives`
    
    try {
      const response = await fetch(archiveUrl)
      if (!response.ok) {
        throw new Error(`Chess.com API error: ${response.status}`)
      }
      
      const data = await response.json()
      this.monthUrls = data.archives || []
      
      if (this.options.since || this.options.until) {
        this.monthUrls = this.filterArchivesByDate(this.monthUrls)
      }
      
      // Process each month
      for (const monthUrl of this.monthUrls.reverse()) {
        await delay(100) // Rate limiting
        
        const pgnUrl = `${monthUrl}/pgn`
        const iterator = new BaseUrlIterator(pgnUrl, this.options)
        
        for await (const game of iterator.iterate()) {
          if (this.shouldIncludeGame(game)) {
            yield game
            this.gameCount++
            
            if (this.options.maxGames && this.gameCount >= this.options.maxGames) {
              this.totalGamesAvailable = this.gameCount
              return
            }
          }
        }
      }
      
      this.totalGamesAvailable = this.gameCount
    } catch (error) {
      console.error('ChessComIterator error:', error)
      this.totalGamesAvailable = this.gameCount
      throw error
    }
  }

  isComplete() {
    return this.totalGamesAvailable !== null
  }

  getTotalGames() {
    return this.totalGamesAvailable || this.gameCount
  }

  filterArchivesByDate(archives) {
    return archives.filter(url => {
      const match = url.match(/\/(\d{4})\/(\d{2})$/)
      if (!match) return true
      
      const [, year, month] = match
      const archiveDate = new Date(year, month - 1)
      
      if (this.options.since && archiveDate < new Date(this.options.since)) {
        return false
      }
      
      if (this.options.until && archiveDate > new Date(this.options.until)) {
        return false
      }
      
      return true
    })
  }

  shouldIncludeGame(pgn) {
    // Filter by variant
    if (this.options.variant && this.options.variant !== 'standard') {
      if (!pgn.includes(`[Variant "${this.options.variant}"]`)) {
        return false
      }
    }
    
    // Filter by time control
    if (this.options.timeControls && this.options.timeControls.length > 0) {
      const tcMatch = pgn.match(/\[TimeControl "([^"]+)"\]/)
      if (tcMatch) {
        const tc = this.parseTimeControl(tcMatch[1])
        if (!this.options.timeControls.includes(tc)) {
          return false
        }
      }
    }
    
    return true
  }

  parseTimeControl(tc) {
    if (!tc || tc === '-') return 'correspondence'
    
    const parts = tc.split('+')
    const base = parseInt(parts[0], 10)
    const increment = parts.length > 1 ? parseInt(parts[1], 10) : 0
    
    const total = base + (40 * increment)
    
    if (total < 30) return 'ultraBullet'
    if (total < 180) return 'bullet'
    if (total < 480) return 'blitz'
    if (total < 1500) return 'rapid'
    if (total < 21600) return 'classical'
    return 'correspondence'
  }

  getProgress() {
    return {
      gamesProcessed: this.gameCount,
      monthsRemaining: this.monthUrls.length
    }
  }
}
