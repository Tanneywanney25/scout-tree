// src/pres/loader/PGNLoader.jsx

import React, { useState } from 'react'
import * as Constants from '../../app/Constants'

export default function PGNLoader({ onStartDownload, isLoading, progress }) {
  const [site, setSite] = useState(Constants.SITE_LICHESS)
  const [username, setUsername] = useState('')
  const [color, setColor] = useState('white')
  const [variant, setVariant] = useState(Constants.VARIANT_STANDARD)
  const [timeControls, setTimeControls] = useState([])
  const [maxGames, setMaxGames] = useState(1000)

  const handleSubmit = (e) => {
    e.preventDefault()

    if (!username.trim()) {
      alert('Please enter a username')
      return
    }

    onStartDownload({
      playerName: username.trim(),
      playerColor: color,
      site,
      advancedFilters: {
        variant,
        timeControls,
        [Constants.FILTER_NAME_DOWNLOAD_LIMIT]: maxGames
      },
      tokens: {} // Add OAuth tokens here if available
    })
  }

  const handleTimeControlToggle = (tc) => {
    setTimeControls(prev =>
      prev.includes(tc)
        ? prev.filter(t => t !== tc)
        : [...prev, tc]
    )
  }

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h2 className="text-2xl font-bold mb-4">Load Games</h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">Site</label>
          <select
            value={site}
            onChange={(e) => setSite(e.target.value)}
            className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
          >
            <option value={Constants.SITE_LICHESS}>Lichess.org</option>
            <option value={Constants.SITE_CHESSCOM}>Chess.com</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter username"
            className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
            disabled={isLoading}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Color</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setColor('white')}
              className={`flex-1 py-2 rounded ${
                color === 'white'
                  ? 'bg-blue-600'
                  : 'bg-gray-700 hover:bg-gray-600'
              }`}
            >
              White
            </button>
            <button
              type="button"
              onClick={() => setColor('black')}
              className={`flex-1 py-2 rounded ${
                color === 'black'
                  ? 'bg-blue-600'
                  : 'bg-gray-700 hover:bg-gray-600'
              }`}
            >
              Black
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Time Controls</label>
          <div className="grid grid-cols-2 gap-2">
            {['bullet', 'blitz', 'rapid', 'classical'].map(tc => (
              <button
                key={tc}
                type="button"
                onClick={() => handleTimeControlToggle(tc)}
                className={`py-2 rounded capitalize ${
                  timeControls.includes(tc)
                    ? 'bg-blue-600'
                    : 'bg-gray-700 hover:bg-gray-600'
                }`}
              >
                {tc}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Max Games</label>
          <input
            type="number"
            value={maxGames}
            onChange={(e) => setMaxGames(parseInt(e.target.value, 10))}
            min="1"
            max="10000"
            className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
          />
        </div>

        <button
          type="submit"
          disabled={isLoading}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 py-3 rounded font-medium"
        >
          {isLoading ? 'Loading...' : 'Load Games'}
        </button>
      </form>

      {isLoading && (
        <div className="mt-4 p-4 bg-gray-700 rounded">
          <div className="text-sm mb-2">
            Games processed: {progress.gamesProcessed}
          </div>
          <div className="w-full bg-gray-600 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all"
              style={{ width: `${Math.min((progress.gamesProcessed / maxGames) * 100, 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
