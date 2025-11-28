// src/app/iterator/BaseUrlIterator.js
// CRITICAL: Converted from Node 'request' to browser 'fetch'

export default class BaseUrlIterator {
  constructor(url, options = {}) {
    this.url = url
    this.options = options
    this.buffer = ''
    this.gameCount = 0
  }

  async *iterate() {
    try {
      const response = await fetch(this.url, {
        method: 'GET',
        headers: {
          'Accept': 'application/x-chess-pgn',
          ...this.options.headers
        }
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        
        if (done) {
          // Yield final buffer if any
          if (this.buffer.trim()) {
            yield this.buffer
            this.gameCount++
          }
          break
        }

        // Decode chunk
        const chunk = decoder.decode(value, { stream: true })
        this.buffer += chunk

        // Split on double newline (game separator)
        const games = this.buffer.split('\n\n\n')
        
        // Keep last incomplete game in buffer
        this.buffer = games.pop() || ''

        // Yield complete games
        for (const game of games) {
          if (game.trim()) {
            yield game
            this.gameCount++
            
            if (this.options.maxGames && this.gameCount >= this.options.maxGames) {
              reader.cancel()
              return
            }
          }
        }
      }
    } catch (error) {
      console.error('BaseUrlIterator error:', error)
      throw error
    }
  }

  getProgress() {
    return {
      gamesProcessed: this.gameCount,
      complete: false
    }
  }
}
