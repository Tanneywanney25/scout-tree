// src/app/chess/RacingKingsChess.js

import { Chess } from 'chess.js'

export default class RacingKingsChess extends Chess {
  constructor(fen) {
    super(fen)
    this.variant = 'racingKings'
  }

  in_check() {
    return false // No check in Racing Kings
  }

  in_checkmate() {
    return false
  }

  in_stalemate() {
    return this.moves().length === 0
  }

  game_over() {
    // Game ends when a king reaches 8th rank
    const fen = this.fen()
    const position = fen.split(' ')[0]
    const rows = position.split('/')
    const rank8 = rows[0]
    
    if (rank8.includes('K') || rank8.includes('k')) {
      return true
    }
    
    return this.moves().length === 0
  }

  move(move, options) {
    const result = super.move(move, options)
    
    // Prevent moving into check (which isn't checked in racing kings normally)
    if (result && this.in_check()) {
      this.undo()
      return null
    }
    
    return result
  }
}
