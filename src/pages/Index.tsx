import { useState } from "react"
import { Chess } from "chess.js"
import Chessboard from "chessboardjsx"
import OpeningManager from "../app/OpeningManager"
import { serializeOpeningTree } from "../app/OpeningTreeSerializer"

type Platform = "lichess" | "chesscom"
type Color = "white" | "black"

const LICHESS_TC = ["ultrabullet", "bullet", "blitz", "rapid", "classical", "correspondence"]
const CHESSCOM_TC = ["bullet", "blitz", "rapid", "daily"]

export default function Index() {
  const [username, setUsername] = useState("")
  const [platform, setPlatform] = useState<Platform>("lichess")
  const [color, setColor] = useState<Color>("white")
  const [timeControls, setTimeControls] = useState<string[]>([])
  const [mode, setMode] = useState<"all" | "rated" | "casual">("all")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [ratingMin, setRatingMin] = useState("")
  const [ratingMax, setRatingMax] = useState("")
  const [opponentName, setOpponentName] = useState("")
  const [loading, setLoading] = useState(false)
  const [gamesAnalyzed, setGamesAnalyzed] = useState(0)
  const [tree, setTree] = useState<any>(null)
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

    const manager = new OpeningManager()
    
    await manager.startDownload({
      playerName: username.trim(),
      playerColor: color,
      site: platform,
      advancedFilters: {
        timeControls: timeControls.length > 0 ? timeControls : tcOptions,
        mode,
        since: dateFrom ? new Date(dateFrom).getTime() : null,
        until: dateTo ? new Date(dateTo).getTime() : null,
        ratingMin: ratingMin ? parseInt(ratingMin) : null,
        ratingMax: ratingMax ? parseInt(ratingMax) : null,
        opponentName: opponentName.trim() || null,
      },
      files: null,
      tokens: null,
    }, {
      onProgress: ({ gamesProcessed }) => setGamesAnalyzed(gamesProcessed),
      onComplete: ({ graph }) => {
        const serialized = serializeOpeningTree(graph.graph, color, 20)
        setTree(serialized)
        setLoading(false)
      },
      onError: (err) => {
        alert(err.message)
        setLoading(false)
      }
    })
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
      const child = node.children?.find((c: any) => c.san === san)
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
    const sorted = [...currentNode.children].sort((a: any, b: any) => b.count - a.count)
    const maxCount = sorted[0]?.count || 1
    
    return sorted.map((child: any, i: number) => {
      try {
        const move = chess.move(child.san)
        chess.undo()
        if (!move) return null
        const freq = child.count / maxCount
        const opacity = i === 0 ? 1.0 : 0.4 + freq * 0.4
        const c = isPlayerTurn ? [100, 111, 65] : [144, 0, 9]
        return [move.from, move.to, `rgba(${c[0]},${c[1]},${c[2]},${opacity})`]
      } catch { return null }
    }).filter(Boolean)
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

          <div style={{ marginBottom: 10 }}>
            <label>Opponent Rating Min: </label>
            <input type="number" value={ratingMin} onChange={e => setRatingMin(e.target.value)} placeholder="any" style={{ width: 80 }} />
            <label style={{ marginLeft: 10 }}>Max: </label>
            <input type="number" value={ratingMax} onChange={e => setRatingMax(e.target.value)} placeholder="any" style={{ width: 80 }} />
          </div>

          <div style={{ marginBottom: 10 }}>
            <label>Opponent Name: </label>
            <input value={opponentName} onChange={e => setOpponentName(e.target.value)} placeholder="(optional)" />
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
              {arrows.map((arr: any, i: number) => {
                const files = "abcdefgh"
                const fromFile = files.indexOf(arr[0][0])
                const fromRank = parseInt(arr[0][1])
                const toFile = files.indexOf(arr[1][0])
                const toRank = parseInt(arr[1][1])
                const flip = color === "black"
                const fromX = (flip ? 7 - fromFile : fromFile) * 50 + 25
                const fromY = (flip ? fromRank - 1 : 8 - fromRank) * 50 + 25
                const toX = (flip ? 7 - toFile : toFile) * 50 + 25
                const toY = (flip ? toRank - 1 : 8 - toRank) * 50 + 25
                return (
                  <line key={i} x1={fromX} y1={fromY} x2={toX} y2={toY} stroke={arr[2]} strokeWidth={8} strokeLinecap="round" />
                )
              })}
            </svg>
          </div>
        </div>
      )}
    </div>
  )
}
