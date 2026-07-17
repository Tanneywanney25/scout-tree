// src/app/iterator/LichessIterator.js

import BaseLichessIterator from './BaseLichessIterator'
import * as Constants from '../Constants'

export default class LichessIterator extends BaseLichessIterator {
  constructor(username, options = {}, token = null) {
    const {
      variant = 'standard',
      timeControls = [],
      since = null,
      until = null,
      maxGames = 1000,
      rated = null,
      color = null
    } = options

    // Build API URL
    let url = `${Constants.LICHESS_API}/api/games/user/${username}`
    
    const params = new URLSearchParams()
    
    if (variant && variant !== 'standard') {
      params.append('perfType', variant)
    }
    
    if (since) {
      params.append('since', since)
    }
    
    if (until) {
      params.append('until', until)
    }
    
    if (maxGames) {
      params.append('max', Math.min(maxGames, 1000))
    }
    
    if (rated !== null) {
      params.append('rated', rated)
    }
    
    if (color) {
      params.append('color', color)
    }
    
    params.append('pgnInJson', 'true')
    params.append('clocks', 'false')
    params.append('evals', 'false')
    params.append('opening', 'false')
    
    const queryString = params.toString()
    if (queryString) {
      url += `?${queryString}`
    }

    super(url, token, { maxGames, timeControls })
    
    this.username = username
    this.variant = variant
    this.timeControls = timeControls
  }

  convertToPGN(gameData) {
    const pgn = super.convertToPGN(gameData)
    
    // Filter by time control if specified
    if (this.timeControls.length > 0) {
      const speed = gameData.speed
      if (!this.timeControls.includes(speed)) {
        return null
      }
    }
    
    return pgn
  }
}
