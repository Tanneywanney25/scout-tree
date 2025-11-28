// src/app/iterator/IteratorUtils.js

import normalizeNewline from 'normalize-newline'

export function normalizePGN(pgnText) {
  if (!pgnText) return ''
  
  // Normalize line endings
  let normalized = normalizeNewline(pgnText)
  
  // Ensure double newline between games
  normalized = normalized.replace(/\n\[/g, '\n\n[')
  
  // Remove extra whitespace
  normalized = normalized.replace(/[ \t]+$/gm, '')
  
  return normalized
}

export function splitPGNGames(pgnText) {
  const normalized = normalizePGN(pgnText)
  
  // Split on double newline followed by '['
  const games = normalized.split(/\n\n+(?=\[)/)
  
  return games.filter(game => game.trim().length > 0)
}

export function extractHeaders(pgnText) {
  const headers = {}
  const headerRegex = /\[(\w+)\s+"([^"]*)"\]/g
  
  let match
  while ((match = headerRegex.exec(pgnText)) !== null) {
    headers[match[1]] = match[2]
  }
  
  return headers
}

export function extractMoves(pgnText) {
  // Remove headers
  const withoutHeaders = pgnText.replace(/\[.*?\]\n/g, '')
  
  // Remove comments
  const withoutComments = withoutHeaders
    .replace(/\{[^}]*\}/g, '')
    .replace(/;[^\n]*/g, '')
  
  // Remove move numbers and result
  const moves = withoutComments
    .replace(/\d+\./g, '')
    .replace(/1-0|0-1|1\/2-1\/2|\*/g, '')
    .trim()
  
  return moves
}
