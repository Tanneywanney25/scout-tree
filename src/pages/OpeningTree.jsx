// src/pages/OpeningTree.jsx

import React, { useState, useEffect } from 'react'
import OpeningManager from '../app/OpeningManager'
import PGNLoader from '../pres/loader/PGNLoader'
import MovesTable from '../pres/moves/MovesTable'
import * as Constants from '../app/Constants'
import { chessLogic, rootFen } from '../app/chess/ChessLogic'

export default function OpeningTree() {
  const [manager] = useState(() => new OpeningManager())
  const [currentFen, setCurrentFen] = useState(rootFen(Constants.VARIANT_STANDARD))
  const [moves, setMoves] = useState([])
  const [details, setDetails] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [progress, setProgress] = useState({ gamesProcessed: 0 })

  useEffect(() => {
    updatePosition(currentFen)
  }, [currentFen])

  const updatePosition = (fen) => {
    const movesForPosition = manager.getMovesForPosition(fen)
    const detailsForPosition = manager.getDetailsForPosition(fen)
    
    setMoves(movesForPosition)
    setDetails(detailsForPosition)
  }

  const handleStartDownload = async (options) => {
    setIsLoading(true)

    await manager.startDownload(options, {
      onProgress: (progressData) => {
        setProgress(progressData)
        updatePosition(currentFen)
      },
      onComplete: (result) => {
        setIsLoading(false)
        console.log('Download complete:', result.totalGames, 'games')
      },
      onError: (error) => {
        setIsLoading(false)
        console.error('Download error:', error)
      }
    })
  }

  const handleMoveClick = (move) => {
    setCurrentFen(move.fen)
  }

  const handleBack = () => {
    // Get parent position by undoing last move
    const chess = chessLogic(Constants.VARIANT_STANDARD, currentFen)
    chess.undo()
    setCurrentFen(chess.fen())
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8">
          <h1 className="text-4xl font-bold mb-2">Opening Tree</h1>
          <p className="text-gray-400">Build your chess repertoire</p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <PGNLoader
              onStartDownload={handleStartDownload}
              isLoading={isLoading}
              progress={progress}
            />
          </div>

          <div className="lg:col-span-2">
            <MovesTable
              moves={moves}
              details={details}
              onMoveClick={handleMoveClick}
              onBack={handleBack}
              canGoBack={currentFen !== rootFen(Constants.VARIANT_STANDARD)}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
