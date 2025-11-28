// src/app/OpeningGraph.js

import { simplifiedFen, isDateMoreRecentThan } from './util'
import * as Constants from './Constants'
import { chessLogic, rootFen } from './chess/ChessLogic'

export default class OpeningGraph {
  constructor(variant) {
    this.graph = new Graph()
    this.hasMoves = false
    this.variant = variant
  }

  setEntries(arrayEntries, pgnStats) {
    this.graph = new Graph(arrayEntries, pgnStats)
    this.hasMoves = true
  }

  clear() {
    this.graph = new Graph()
    this.hasMoves = false
  }

  addPGN(pgnStats, parsedMoves, lastFen, playerColor) {
    pgnStats.index = this.graph.pgnStats.length
    this.graph.pgnStats.push(pgnStats)
    this.graph.playerColor = playerColor
    this.hasMoves = true
    
    parsedMoves.forEach(parsedMove => {
      this.addMoveForFen(
        parsedMove.sourceFen,
        parsedMove.targetFen,
        parsedMove.moveSan,
        pgnStats
      )
    })
    
    this.addGameResultOnFen(lastFen, pgnStats.index)
    this.addStatsToRoot(pgnStats, this.variant)
  }

  addGameResultOnFen(fullFen, resultIndex) {
    const currNode = this.getNodeFromGraph(fullFen, true)
    if (!currNode.gameResults) {
      currNode.gameResults = []
    }
    currNode.gameResults.push(resultIndex)
  }

  addStatsToRoot(pgnStats, variant) {
    const targetNode = this.getNodeFromGraph(rootFen(variant), true)
    if (!targetNode.details) {
      targetNode.details = emptyDetails()
    }
    const newDetails = this.getUpdatedMoveDetails(targetNode.details, pgnStats)
    targetNode.details = newDetails
  }

  getDetailsForFen(fullFen) {
    const node = this.getNodeFromGraph(simplifiedFen(fullFen), false)
    let details = node && node.details
    
    if (Number.isInteger(details)) {
      details = this.getUpdatedMoveDetails(emptyDetails(), this.graph.pgnStats[details])
    } else if (!details) {
      return emptyDetails()
    }
    
    details = this.updateCalculatedValues(details)
    return details
  }

  updateCalculatedValues(details) {
    if (Number.isInteger(details.bestWin)) {
      details.bestWinGame = this.graph.pgnStats[details.bestWin]
      details.bestWinElo = this.getOpponentElo(this.graph.playerColor, details.bestWinGame)
    }
    
    if (Number.isInteger(details.worstLoss)) {
      details.worstLossGame = this.graph.pgnStats[details.worstLoss]
      details.worstLossElo = this.getOpponentElo(this.graph.playerColor, details.worstLossGame)
    }
    
    if (Number.isInteger(details.lastPlayed)) {
      details.lastPlayedGame = this.graph.pgnStats[details.lastPlayed]
    }
    
    if (Number.isInteger(details.longestGame)) {
      details.longestGameInfo = this.graph.pgnStats[details.longestGame]
    }
    
    if (Number.isInteger(details.shortestGame)) {
      details.shortestGameInfo = this.graph.pgnStats[details.shortestGame]
    }
    
    details.count = details.whiteWins + details.blackWins + details.draws
    return details
  }

  getOpponentElo(playerColor, game) {
    if (playerColor === 'white') {
      return parseInt(game.blackElo, 10) || 0
    }
    return parseInt(game.whiteElo, 10) || 0
  }

  addMoveForFen(sourceFen, targetFen, moveSan, pgnStats) {
    const sourceNode = this.getNodeFromGraph(sourceFen, true)
    
    if (!sourceNode.children) {
      sourceNode.children = {}
    }
    
    if (!sourceNode.children[moveSan]) {
      sourceNode.children[moveSan] = {
        fen: targetFen,
        details: pgnStats.index
      }
    } else {
      const targetNode = sourceNode.children[moveSan]
      
      if (Number.isInteger(targetNode.details)) {
        const firstGame = this.graph.pgnStats[targetNode.details]
        targetNode.details = this.getUpdatedMoveDetails(emptyDetails(), firstGame)
      }
      
      targetNode.details = this.getUpdatedMoveDetails(targetNode.details, pgnStats)
    }
  }

  getUpdatedMoveDetails(details, pgnStats) {
    const newDetails = { ...details }
    const playerColor = this.graph.playerColor
    const result = pgnStats.result
    
    // Update win/loss/draw counts
    if (result === Constants.RESULT_WHITE_WIN) {
      if (playerColor === 'white') {
        newDetails.whiteWins++
      } else {
        newDetails.blackWins++
      }
    } else if (result === Constants.RESULT_BLACK_WIN) {
      if (playerColor === 'black') {
        newDetails.whiteWins++
      } else {
        newDetails.blackWins++
      }
    } else if (result === Constants.RESULT_DRAW) {
      newDetails.draws++
    }
    
    // Track best win
    const opponentElo = this.getOpponentElo(playerColor, pgnStats)
    const isWin = (playerColor === 'white' && result === Constants.RESULT_WHITE_WIN) ||
                  (playerColor === 'black' && result === Constants.RESULT_BLACK_WIN)
    
    if (isWin) {
      const currentBestElo = Number.isInteger(newDetails.bestWin) ?
        this.getOpponentElo(playerColor, this.graph.pgnStats[newDetails.bestWin]) : 0
      
      if (opponentElo > currentBestElo) {
        newDetails.bestWin = pgnStats.index
      }
    }
    
    // Track worst loss
    const isLoss = (playerColor === 'white' && result === Constants.RESULT_BLACK_WIN) ||
                   (playerColor === 'black' && result === Constants.RESULT_WHITE_WIN)
    
    if (isLoss) {
      const currentWorstElo = Number.isInteger(newDetails.worstLoss) ?
        this.getOpponentElo(playerColor, this.graph.pgnStats[newDetails.worstLoss]) : 9999
      
      if (opponentElo < currentWorstElo) {
        newDetails.worstLoss = pgnStats.index
      }
    }
    
    // Track most recent game
    if (!Number.isInteger(newDetails.lastPlayed) ||
        isDateMoreRecentThan(pgnStats.date, this.graph.pgnStats[newDetails.lastPlayed].date)) {
      newDetails.lastPlayed = pgnStats.index
    }
    
    // Track longest/shortest games
    const plyCount = pgnStats.numberOfPlys
    
    if (!Number.isInteger(newDetails.longestGame) ||
        plyCount > this.graph.pgnStats[newDetails.longestGame].numberOfPlys) {
      newDetails.longestGame = pgnStats.index
    }
    
    if (!Number.isInteger(newDetails.shortestGame) ||
        plyCount < this.graph.pgnStats[newDetails.shortestGame].numberOfPlys) {
      newDetails.shortestGame = pgnStats.index
    }
    
    return newDetails
  }

  getNodeFromGraph(fen, createIfMissing) {
    const simplified = simplifiedFen(fen)
    
    if (!this.graph.nodes[simplified]) {
      if (createIfMissing) {
        this.graph.nodes[simplified] = {}
      } else {
        return null
      }
    }
    
    return this.graph.nodes[simplified]
  }

  getMovesForFen(fen) {
    const node = this.getNodeFromGraph(fen, false)
    
    if (!node || !node.children) {
      return []
    }
    
    return Object.keys(node.children).map(san => {
      const child = node.children[san]
      let details = child.details
      
      if (Number.isInteger(details)) {
        details = this.getUpdatedMoveDetails(emptyDetails(), this.graph.pgnStats[details])
      }
      
      details = this.updateCalculatedValues(details)
      
      return {
        san,
        fen: child.fen,
        details
      }
    }).sort((a, b) => b.details.count - a.details.count)
  }

  getGameResultsForFen(fen) {
    const node = this.getNodeFromGraph(fen, false)
    
    if (!node || !node.gameResults) {
      return []
    }
    
    return node.gameResults.map(index => this.graph.pgnStats[index])
  }

  serialize() {
    return {
      nodes: this.graph.nodes,
      pgnStats: this.graph.pgnStats,
      playerColor: this.graph.playerColor,
      variant: this.variant
    }
  }

  deserialize(data) {
    this.graph.nodes = data.nodes || {}
    this.graph.pgnStats = data.pgnStats || []
    this.graph.playerColor = data.playerColor
    this.variant = data.variant
    this.hasMoves = Object.keys(this.graph.nodes).length > 0
  }
}

class Graph {
  constructor(nodes = {}, pgnStats = []) {
    this.nodes = nodes
    this.pgnStats = pgnStats
    this.playerColor = 'white'
  }
}

function emptyDetails() {
  return {
    whiteWins: 0,
    blackWins: 0,
    draws: 0,
    count: 0,
    bestWin: null,
    worstLoss: null,
    lastPlayed: null,
    longestGame: null,
    shortestGame: null
  }
}
