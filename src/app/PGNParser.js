// src/app/PGNParser.js
// This is a simplified parser - the real one is generated from PEG grammar

export function parsePGN(pgnText) {
  const games = []
  const gameStrings = pgnText.split(/\n\n+(?=\[)/)
  
  gameStrings.forEach(gameText => {
    if (!gameText.trim()) return
    
    const game = {
      headers: {},
      moves: []
    }
    
    // Extract headers
    const headerRegex = /\[(\w+)\s+"([^"]*)"\]/g
    let match
    while ((match = headerRegex.exec(gameText)) !== null) {
      game.headers[match[1]] = match[2]
    }
    
    // Extract moves
    const movesText = gameText
      .replace(/\[.*?\]\n/g, '')
      .replace(/\{[^}]*\}/g, '')
      .replace(/;[^\n]*/g, '')
    
    const moveMatches = movesText.match(/[NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O(?:-O)?[+#]?/g)
    
    if (moveMatches) {
      game.moves = moveMatches
    }
    
    games.push(game)
  })
  
  return games
}

export function parseGame(gameText) {
  const games = parsePGN(gameText)
  return games[0] || null
}
