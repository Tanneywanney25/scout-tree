// src/app/OpeningTreeSerializer.js

import { saveAs } from 'file-saver'

export function serializeToJSON(openingGraph) {
  const data = openingGraph.serialize()
  return JSON.stringify(data)
}

export function deserializeFromJSON(jsonString, openingGraph) {
  const data = JSON.parse(jsonString)
  openingGraph.deserialize(data)
}

export function downloadAsJSON(openingGraph, filename = 'repertoire.json') {
  const json = serializeToJSON(openingGraph)
  const blob = new Blob([json], { type: 'application/json' })
  saveAs(blob, filename)
}

export function uploadFromJSON(file, openingGraph) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    
    reader.onload = (e) => {
      try {
        deserializeFromJSON(e.target.result, openingGraph)
        resolve()
      } catch (error) {
        reject(error)
      }
    }
    
    reader.onerror = () => {
      reject(new Error('Failed to read file'))
    }
    
    reader.readAsText(file)
  })
}

export function serializeToPGN(openingGraph) {
  const games = openingGraph.graph.pgnStats
  
  let pgn = ''
  
  games.forEach(game => {
    pgn += `[Event "Repertoire Game"]\n`
    pgn += `[Site "${game.url || 'Unknown'}"]\n`
    pgn += `[Date "${game.date || '????.??.??'}"]\n`
    pgn += `[White "${game.white}"]\n`
    pgn += `[Black "${game.black}"]\n`
    pgn += `[Result "${game.result}"]\n`
    
    if (game.whiteElo) {
      pgn += `[WhiteElo "${game.whiteElo}"]\n`
    }
    
    if (game.blackElo) {
      pgn += `[BlackElo "${game.blackElo}"]\n`
    }
    
    pgn += '\n\n'
  })
  
  return pgn
}
