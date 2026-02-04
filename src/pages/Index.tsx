import { useState } from "react"
import { Chess } from "chess.js"
import Chessboard from "chessboardjsx"

type Platform = "lichess" | "chesscom"
type Color = "white" | "black"

const LICHESS_TC = ["ultrabullet", "bullet", "blitz", "rapid", "classical", "correspondence"]
const CHESSCOM_TC = ["bullet", "blitz", "rapid", "daily"]

interface TreeNode {
  san: string
  count: number
  children: TreeNode[]
}

async function fetchLichessGames(username: string, color: Color, timeControls: string[], mode: string, dateFrom: string, dateTo: string, onProgress: (n: number) => void) {
  const params = new URLSearchParams()
  if (timeControls.length === 1) params.append("perfType", timeControls[0])
  params.append("color", color)
  if (mode === "rated") params.append("rated", "true")
  if (mode === "casual") params.append("rated", "false")
  if (dateFrom) params.append("since", new Date(dateFrom).getTime().toString())
  if (dateTo) params.append("until", new Date(dateTo).getTime().toString())
  params.append("max", "500")
  
  const res = await fetch(`https://lichess.org/api/games/user/${username}?${params}`, {
    headers: { Accept: "application/x-ndjson" }
  })
  if (!res.ok) throw new Error(`Lichess error: ${res.status}`)
  
  const text = await res.text()
  const lines = text.trim().split("\n").filter(Boolean)
  const games: string[] = []
  
  for (const line of lines) {
    try {
      const g = JSON.parse(line)
      if (g.pgn) {
        games.push(g.pgn)
        onProgress(games.length)
      }
    } catch {}
  }
  return games
}

async function fetchChesscomGames(username: string, color: Color, timeControls: string[], onProgress: (n: number) => void) {
  const archivesRes = await fetch(`https://api.chess.com/pub/player/${username}/games/archives`)
  if (!archivesRes.ok) throw new Error(`Chess.com error: ${archivesRes.status}`)
  const { archives } = await archivesRes.json()
  
  const games: string[] = []
  const recentArchives = archives.slice(-6)
  
  for (const url of recentArchives) {
    const res = await fetch(url)
    if (!res.ok) continue
    const { games: monthGames } = await res.json()
    
    for (const g of monthGames || []) {
      const isColor = color === "white" ? g.white?.username?.toLowerCase() === username.toLowerCase() : g.black?.username?.toLowerCase() === username.toLowerCase()
      if (!isColor) continue
      if (timeControls.length > 0 && !timeControls.includes(g.time_class)) continue
      if (g.pgn) {
        games.push(g.pgn)
        onProgress(games.length)
      }
    }
  }
  return games
}

function parseMoves(pgn: string): string[] {
  const moveSection = pgn.replace(/\[.*?\]/g, "").replace(/\{[^}]*\}/g, "").trim()
  const tokens = moveSection.split(/\s+/)
  const moves: string[] = []
  for (const t of tokens) {
    if (/^\d+\./.test(t)) continue
    if (["1-0", "0-1", "1/2-1/2", "*"].includes(t)) continue
    if (t) moves.push(t.replace(/[?!]+$/, ""))
  }
  return moves
}

function buildTree(pgns: string[], playerColor: Color): TreeNode {
  const root: TreeNode = { san: "", count: 0, children: [] }
  
  for (const pgn of pgns) {
    const moves = parseMoves(pgn)
    let node = root
    node.count++
    
    for (const san of moves.slice(0, 30)) {
      let child = node.children.find(c => c.san === san)
      if (!child) {
        child = { san, count: 0, children: [] }
        node.children.push(child)
      }
      child.count++
      node = child
    }
  }
  return root
}

export default function Index() {
  const [username, setUsername] = useState("")
  const [platform, setPlatform] = useState<Platform>("lichess")
  const [color, setColor] = useState<Color>("white")
  const [timeControls, setTimeControls] = useState<string[]>([])
  const [mode, setMode] = useState<"all" | "rated" | "casual">("all")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [loading, setLoading] = useState(false)
  const [gamesAnalyzed, setGamesAnalyzed] = useState(0)
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [path, setPath] = useState<string[]>([])

  const tcOptions = platform === "lichess" ? LICHESS_TC : CHESSCOM_TC

  const toggleTC = (tc: string) => {
    setTimeControls(prev => prev.includes(tc) ? prev.filter(t => t !== tc) : [...prev, tc])
  }

  const generate = async () => {
    if (!username.trim()) return
    setLoading(true)
    setGamesAnalyzed(0)
    setTree(null)
    setPath([])
    
    try {
      let pgns: string[]
      if (platform === "lichess") {
        pgns = await fetchLichessGames(username.trim(), color, timeControls.length > 0 ? timeControls : tcOptions, mode, dateFrom, dateTo, setGamesAnalyzed)
      } else {
        pgns = await fetchChesscomGames(username.trim(), color, timeControls.length > 0 ? timeControls : tcOptions, setGamesAnalyzed)
      }
      setTree(buildTree(pgns, color))
    } catch (e: any) {
      alert(e.message)
    }
    setLoading(false)
  }

  const position = (() => {
    const chess = new Chess()
    for (const san of path) {
      try { chess.move(san) } catch { break }
    }
    return chess.fen()
  })()

  const currentNode = (() => {
    if (!tree) return null
    let node = tree
    for (const san of path) {
      const child = node.children.find(c => c.san === san)
      if (!child) return null
      node = child
    }
    return node
  })()

  const arrows = (() => {
    if (!currentNode?.children?.length) return []
    const chess = new Chess(position)
    const isWhiteTurn = path.length % 2 === 0
    const isPlayerTurn = (color === "white" && isWhiteTurn) || (color === "black" && !isWhiteTurn)
    const sorted = [...currentNode.children].sort((a, b) => b.count - a.count)
    const maxCount = sorted[0]?.count || 1
    
    return sorted.map((child, i) => {
      try {
        const move = chess.move(child.san)
        chess.undo()
        if (!move) return null
        const freq = child.count / maxCount
        const opacity = i === 0 ? 1.0 : 0.4 + freq * 0.4
        const c = isPlayerTurn ? [100, 111, 65] : [144, 0, 9]
        return { from: move.from, to: move.to, color: `rgba(${c[0]},${c[1]},${c[2]},${opacity})` }
      } catch { return null }
    }).filter(Boolean) as { from: string; to: string; color: string }[]
  })()

  const onDrop = ({ sourceSquare, targetSquare }: any) => {
    const chess = new Chess(position)
    try {
      const move = chess.move({ from: sourceSquare, to: targetSquare, promotion: "q" })
      if (move) setPath(prev => [...prev, move.san])
    } catch {}
  }

  return (
    <div style={{ fontFamily: "monospace", padding: 20 }}>
      <h1>Chess Scout</h1>
      
      {!tree ? (
        <div>
          <div style={{ marginBottom: 10 }}>
            <label>Username: </label>
            <input value={username} onChange={e => setUsername(e.target.value)} />
          </div>

          <div style={{ marginBottom: 10 }}>
            <label>Platform: </label>
            <select value={platform} onChange={e => { setPlatform(e.target.value as Platform); setTimeControls([]) }}>
              <option value="lichess">Lichess</option>
              <option value="chesscom">Chess.com</option>
            </select>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label>Your Color: </label>
            <select value={color} onChange={e => setColor(e.target.value as Color)}>
              <option value="white">White</option>
              <option value="black">Black</option>
            </select>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label>Time Controls: </label>
            {tcOptions.map(tc => (
              <label key={tc} style={{ marginRight: 10 }}>
                <input type="checkbox" checked={timeControls.includes(tc)} onChange={() => toggleTC(tc)} />
                {tc}
              </label>
            ))}
          </div>

          <div style={{ marginBottom: 10 }}>
            <label>Mode: </label>
            <select value={mode} onChange={e => setMode(e.target.value as any)}>
              <option value="all">Rated and Casual</option>
              <option value="rated">Rated Only</option>
              <option value="casual">Casual Only</option>
            </select>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label>Date From: </label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            <label style={{ marginLeft: 10 }}>To: </label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>

          <button onClick={generate} disabled={loading || !username.trim()}>
            {loading ? `Analyzing... ${gamesAnalyzed} games` : "Generate Scout Report"}
          </button>
        </div>
      ) : (
        <div>
          <p>Games analyzed: {gamesAnalyzed}</p>
          <button onClick={() => setPath([])}>Reset</button>
          <button onClick={() => setPath(prev => prev.slice(0, -1))} disabled={path.length === 0}>Back</button>
          <button onClick={() => setTree(null)}>New Search</button>
          
          <div style={{ marginTop: 20, position: "relative", width: 400, height: 400 }}>
            <Chessboard
              position={position}
              onDrop={onDrop}
              width={400}
              draggable={true}
              orientation={color}
            />
            <svg width={400} height={400} style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}>
              {arrows.map((arr, i) => {
                const files = "abcdefgh"
                const fromFile = files.indexOf(arr.from[0])
                const fromRank = parseInt(arr.from[1])
                const toFile = files.indexOf(arr.to[0])
                const toRank = parseInt(arr.to[1])
                const flip = color === "black"
                const fromX = (flip ? 7 - fromFile : fromFile) * 50 + 25
                const fromY = (flip ? fromRank - 1 : 8 - fromRank) * 50 + 25
                const toX = (flip ? 7 - toFile : toFile) * 50 + 25
                const toY = (flip ? toRank - 1 : 8 - toRank) * 50 + 25
                return (
                  <line key={i} x1={fromX} y1={fromY} x2={toX} y2={toY} stroke={arr.color} strokeWidth={8} strokeLinecap="round" />
                )
              })}
            </svg>
          </div>
        </div>
      )}
    </div>
  )
}
