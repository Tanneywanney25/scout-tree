// src/app/chess/CrazyhouseChess.js

import { Chess } from 'chess.js'

export default class CrazyhouseChess extends Chess {
  constructor(fen) {
    super(fen)
    this.variant = 'crazyhouse'
    this.pockets = {
      white: [],
      black: []
    }
  }

  capture(move) {
    const result = super.move(move)
    if (result && result.captured) {
      const color = this.turn() === 'w' ? 'black' : 'white'
      let piece = result.captured
      
      // Pawns and promoted pieces become pawns
      if (piece === 'p' || result.flags.includes('p')) {
        piece = 'p'
      }
      
      this.pockets[color].push(piece)
    }
    return result
  }

  drop(piece, square) {
    // Implement drop logic for Crazyhouse
    const color = this.turn()
    const pocketColor = color === 'w' ? 'white' : 'black'
    
    const index = this.pockets[pocketColor].indexOf(piece.toLowerCase())
    if (index === -1) return null
    
    // Remove from pocket and place on board
    this.pockets[pocketColor].splice(index, 1)
    
    // Create artificial move
    return {
      from: 'pocket',
      to: square,
      piece: piece,
      color: color,
      flags: 'd' // drop
    }
  }

  move(move, options) {
    if (typeof move === 'object' && move.from === 'pocket') {
      return this.drop(move.piece, move.to)
    }
    return this.capture(move, options)
  }
}
