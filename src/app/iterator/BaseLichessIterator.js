// src/app/iterator/BaseLichessIterator.js

import BaseUrlIterator from './BaseUrlIterator'

export default class BaseLichessIterator extends BaseUrlIterator {
  constructor(url, token, options = {}) {
    const headers = {
      'Accept': 'application/x-ndjson',
      ...options.headers
    }
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    
    super(url, { ...options, headers })
    this.token = token
  }

  async *iterate() {
    try {
      const response = await fetch(this.url, {
        method: 'GET',
        headers: this.options.headers
      })

      if (!response.ok) {
        throw new Error(`Lichess API error: ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue
          
          try {
            const game = JSON.parse(line)
            const pgn = this.convertToPGN(game)
            
            if (pgn) {
              yield pgn
              this.gameCount++
              
              if (this.options.maxGames && this.gameCount >= this.options.maxGames) {
                reader.cancel()
                return
              }
            }
          } catch (e) {
            console.warn('Failed to parse game:', e)
          }
        }
      }
    } catch (error) {
      console.error('BaseLichessIterator error:', error)
      throw error
    }
  }

  convertToPGN(gameData) {
    // Convert Lichess JSON to PGN format
    const headers = []
    
    headers.push(`[Event "${gameData.event || 'Casual Game'}"]`)
    headers.push(`[Site "${gameData.site || 'lichess.org'}"]`)
    headers.push(`[Date "${gameData.date || '????.??.??'}"]`)
    headers.push(`[White "${gameData.players?.white?.user?.name || 'Unknown'}"]`)
    headers.push(`[Black "${gameData.players?.black?.user?.name || 'Unknown'}"]`)
    headers.push(`[Result "${gameData.status || '*'}"]`)
    
    if (gameData.variant && gameData.variant !== 'standard') {
      headers.push(`[Variant "${gameData.variant}"]`)
    }
    
    if (gameData.speed) {
      headers.push(`[TimeControl "${gameData.speed}"]`)
    }
    
    const moves = gameData.moves || gameData.pgn || ''
    
    return `${headers.join('\n')}\n\n${moves}\n`
  }
}
