// src/app/util.js

export function fenToSetup(fen) {
  if (!fen) return null
  const parts = fen.split(' ')
  return parts[0]
}

export function setupToFen(setup, turn = 'w', castling = 'KQkq') {
  return `${setup} ${turn} ${castling} - 0 1`
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

export function parsePgnDate(dateStr) {
  if (!dateStr || dateStr === '????.??.??') return null
  try {
    const [year, month, day] = dateStr.split('.')
    if (year === '????') return null
    return new Date(
      year,
      month !== '??' ? parseInt(month, 10) - 1 : 0,
      day !== '??' ? parseInt(day, 10) : 1
    )
  } catch (e) {
    return null
  }
}
