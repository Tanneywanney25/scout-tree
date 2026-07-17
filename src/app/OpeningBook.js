// src/app/OpeningBook.js

import * as Common from './Common'

export async function fetchBookMoves(fen, variant, bookSettings) {
  const ratings = bookSettings.openingBookRating || ['1600', '1800', '2000', '2200', '2500']
  const speeds = bookSettings.openingBookTimeControls || ['bullet', 'blitz', 'rapid', 'classical']
  const bookType = bookSettings.openingBookType || 'lichess'
  
  const url = `https://explorer.lichess.ovh/${bookType}?` +
    `fen=${encodeURIComponent(fen)}&` +
    `variant=${Common.lichessPerf(variant)}&` +
    `ratings=${ratings.join(',')}&` +
    `speeds=${speeds.join(',')}`
  
  try {
    const response = await fetch(url)
    
    if (!response.ok) {
      return { fetch: 'failed' }
    }
    
    const data = await response.json()
    return data
  } catch (error) {
    console.error('Failed to fetch book moves:', error)
    return { fetch: 'failed' }
  }
}
