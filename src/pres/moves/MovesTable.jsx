// src/pres/moves/MovesTable.jsx

import React from 'react'

export default function MovesTable({ moves, details, onMoveClick, onBack, canGoBack }) {
  if (!moves || moves.length === 0) {
    return (
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-2xl font-bold mb-4">Moves</h2>
        <p className="text-gray-400">
          {details && details.count > 0
            ? 'No more moves available from this position'
            : 'Load games to see moves'}
        </p>
      </div>
    )
  }

  const calculateWinRate = (move) => {
    const total = move.details.whiteWins + move.details.blackWins + move.details.draws
    if (total === 0) return 0
    return ((move.details.whiteWins / total) * 100).toFixed(1)
  }

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold">Moves</h2>
        {canGoBack && (
          <button
            onClick={onBack}
            className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded"
          >
            ← Back
          </button>
        )}
      </div>

      {details && (
        <div className="mb-4 p-4 bg-gray-700 rounded">
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-gray-400">Total Games:</span>{' '}
              <span className="font-medium">{details.count}</span>
            </div>
            <div>
              <span className="text-gray-400">Wins:</span>{' '}
              <span className="font-medium text-green-400">{details.whiteWins}</span>
            </div>
            <div>
              <span className="text-gray-400">Losses:</span>{' '}
              <span className="font-medium text-red-400">{details.blackWins}</span>
            </div>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="text-left py-2 px-4">Move</th>
              <th className="text-right py-2 px-4">Games</th>
              <th className="text-right py-2 px-4">Win Rate</th>
              <th className="text-right py-2 px-4">W-D-L</th>
            </tr>
          </thead>
          <tbody>
            {moves.map((move, index) => (
              <tr
                key={index}
                onClick={() => onMoveClick(move)}
                className="border-b border-gray-700 hover:bg-gray-700 cursor-pointer"
              >
                <td className="py-3 px-4 font-medium">{move.san}</td>
                <td className="py-3 px-4 text-right">{move.details.count}</td>
                <td className="py-3 px-4 text-right">
                  <span className={
                    parseFloat(calculateWinRate(move)) > 50
                      ? 'text-green-400'
                      : parseFloat(calculateWinRate(move)) < 40
                      ? 'text-red-400'
                      : 'text-yellow-400'
                  }>
                    {calculateWinRate(move)}%
                  </span>
                </td>
                <td className="py-3 px-4 text-right text-sm text-gray-400">
                  {move.details.whiteWins}-{move.details.draws}-{move.details.blackWins}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
