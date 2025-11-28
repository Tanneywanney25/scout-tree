// src/app/util.js

export function simplifiedFen(fen) {
  if (!fen) return ''
  
  // Keep only position and turn
  const parts = fen.split(' ')
  return `${parts[0]} ${parts[1]}`
}

export function fenToSetup(fen) {
  if (!fen) return null
  const parts = fen.split(' ')
  return parts[0]
}

export function setupToFen(setup, turn = 'w', castling = 'KQkq') {
  return `${setup} ${turn} ${castling} - 0 1`
}

export function isDateMoreRecentThan(dateStr1, dateStr2) {
  const date1 = parsePgnDate(dateStr1)
  const date2 = parsePgnDate(dateStr2)
  
  if (!date1 || !date2) return false
  return date1 > date2
}

export function parsePgnDate(dateStr) {
  if (!dateStr || dateStr === '????.??.??') return null
  
  try {
    const [year, month, day] = dateStr.split('.')
    if (year === '????') return null
    
    return new Date(
      parseInt(year, 10),
      month !== '??' ? parseInt(month, 10) - 1 : 0,
      day !== '??' ? parseInt(day, 10) : 1
    )
  } catch (e) {
    return null
  }
}

export function moveToSan(chess, move) {
  try {
    const result = chess.move(move)
    if (!result) return null
    const san = result.san
    chess.undo()
    return san
  } catch (e) {
    return null
  }
}
