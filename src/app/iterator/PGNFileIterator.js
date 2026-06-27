// src/app/iterator/PGNFileIterator.js

import { normalizePGN, splitPGNGames } from './IteratorUtils'

export default class PGNFileIterator {
  constructor(file, options = {}) {
    this.file = file
    this.options = options
    this.gameCount = 0
  }

  async *iterate() {
    try {
      const text = await this.readFile()
      const normalized = normalizePGN(text)
      const games = splitPGNGames(normalized)
      
      for (const game of games) {
        if (game.trim()) {
          yield game
          this.gameCount++
          
          if (this.options.maxGames && this.gameCount >= this.options.maxGames) {
            return
          }
        }
      }
    } catch (error) {
      console.error('PGNFileIterator error:', error)
      throw error
    }
  }

  async readFile() {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      
      reader.onload = (e) => {
        resolve(e.target.result)
      }
      
      reader.onerror = () => {
        reject(new Error('Failed to read file'))
      }
      
      reader.readAsText(this.file)
    })
  }

  getProgress() {
    return {
      gamesProcessed: this.gameCount,
      fileName: this.file.name
    }
  }
}
