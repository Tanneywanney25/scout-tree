import { useState, useEffect, useRef } from "react"
import { Chess } from "chess.js"
import Chessboard from "chessboardjsx"

// simple opening book
const OPENINGS: Record<string, string> = {
  "e4": "King's Pawn",
  "e4 e5": "Open Game",
  "e4 e5 Nf3": "King's Knight",
  "e4 e5 Nf3 Nc6": "Four Knights Setup",
  "e4 e5 Nf3 Nc6 Bb5": "Ruy Lopez",
  "e4 e5 Nf3 Nc6 Bc4": "Italian Game",
  "e4 e5 Nf3 Nf6": "Petrov Defense",
  "e4 c5": "Sicilian Defense",
  "e4 e6": "French Defense",
  "e4 c6": "Caro-Kann",
  "e4 d5": "Scandinavian",
  "d4": "Queen's Pawn",
  "d4 d5": "Closed Game",
  "d4 d5 c4": "Queen's Gambit",
  "d4 Nf6": "Indian Defense",
  "d4 Nf6 c4": "Indian Systems",
  "d4 Nf6 c4 g6": "King's Indian",
  "d4 Nf6 c4 e6": "Nimzo/Queen's Indian",
  "c4": "English Opening",
  "Nf3": "Reti Opening",
  "g3": "King's Fianchetto",
}

function detectOpening(moves: string[]): string {
  for (let i = Math.min(moves.length, 6); i >= 1; i--) {
    const key = moves.slice(0, i).join(" ")
    if (OPENINGS[key]) return OPENINGS[key]
  }
  return moves.length > 0 ? "Unknown Opening" : "Starting Position"
}

export default function Index() {
  const [username, setUsername] = useState("")
  const [platform, setPlatform] = useState("lichess")
  const [color, setColor] = useState("white")
  const [loading, setLoading] = useState(false)
  const [tree, setTree] = useState<any>(null)
  const [path, setPath] = useState<string[]>([])
  const [totalGames, setTotalGames] = useState(0)
  const [analysis, setAnalysis] = useState("")
  const [analyzing, setAnalyzing] = useState(false)
  const [fullPath, setFullPath] = useState<string[]>([])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!tree) return
      if (e.key === "ArrowLeft") {
        setPath(prev => prev.length === 0 ? prev : prev.slice(0, -1))
      } else if (e.key === "ArrowRight") {
        setPath(prev => {
          if (prev.length < fullPath.length && fullPath[prev.length]) {
            return [...prev, fullPath[prev.length]]
          }
          let node = tree
          for (const s of prev) node = node?.children?.find((c: any) => c.san === s)
          if (!node?.children?.length) return prev
          const best = [...node.children].sort((a: any, b: any) => b.count - a.count)[0]
          return [...prev, best.san]
        })
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [tree, fullPath])

  useEffect(() => {
    if (path.length > fullPath.length || !path.every((m, i) => fullPath[i] === m)) {
      setFullPath([...path])
    }
  }, [path])

  const fetchGames = async () => {
    if (!username) return
    setLoading(true)
    setAnalysis("")
    let pgns: string[] = []

    try {
      if (platform === "lichess") {
        const res = await fetch(`https://lichess.org/api/games/user/${username}?color=${color}&max=200&opening=true`, {
          headers: { Accept: "application/x-ndjson" }
        })
        if (!res.ok) throw new Error("Lichess error")
        const text = await res.text()
        for (const line of text.split("\n")) {
          try {
            const g = JSON.parse(line)
            // Lichess NDJSON returns 'moves' (space-separated SAN), not 'pgn'
            if (g.moves) pgns.push(g.moves)
          } catch {}
        }
      } else {
        const res = await fetch(`https://api.chess.com/pub/player/${username}/games/archives`)
        if (!res.ok) throw new Error("Chess.com error")
        const { archives } = await res.json()
        for (const url of (archives || []).slice(-3)) {
          const r = await fetch(url)
          if (!r.ok) continue
          const { games } = await r.json()
          for (const g of games || []) {
            const isMyColor = color === "white"
              ? g.white?.username?.toLowerCase() === username.toLowerCase()
              : g.black?.username?.toLowerCase() === username.toLowerCase()
            if (isMyColor && g.pgn) pgns.push(g.pgn)
          }
        }
      }

      // build tree
      const root = { san: "", count: 0, children: [] as any[] }
      for (const pgn of pgns) {
        // Lichess gives space-separated moves, Chess.com gives full PGN
        const cleaned = pgn.replace(/\[.*?\]/g, "").replace(/\{[^}]*\}/g, "").trim()
        const moves = cleaned.split(/\s+/)
          .filter((t: string) => t && !/^\d+\./.test(t) && !["1-0", "0-1", "1/2-1/2", "*"].includes(t))
          .map((t: string) => t.replace(/[?!]+$/, ""))
        let node = root
        node.count++
        for (const san of moves.slice(0, 20)) {
          let child = node.children.find((c: any) => c.san === san)
          if (!child) { child = { san, count: 0, children: [] }; node.children.push(child) }
          child.count++
          node = child
        }
      }

      setTree(root)
      setPath([])
      setTotalGames(pgns.length)

      // get AI analysis
      runAnalysis(root, pgns.length)
    } catch (e: any) {
      alert(e.message)
    }
    setLoading(false)
  }

  const runAnalysis = async (root: any, count: number) => {
    setAnalyzing(true)
    try {
      // build opening stats from tree
      const topMoves = [...root.children].sort((a: any, b: any) => b.count - a.count).slice(0, 8)
      const stats = topMoves.map((m: any) => {
        const sub = [...(m.children || [])].sort((a: any, b: any) => b.count - a.count).slice(0, 3)
        const subStr = sub.map((s: any) => `  → ${s.san} (${s.count})`).join("\n")
        return `${m.san}: ${m.count} games\n${subStr}`
      }).join("\n")

      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analyze-player`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({ username, platform, color, openingStats: stats, totalGames: count }),
      })
      const data = await res.json()
      if (data.error) setAnalysis("Analysis unavailable: " + data.error)
      else setAnalysis(data.analysis)
    } catch {
      setAnalysis("Could not get AI analysis.")
    }
    setAnalyzing(false)
  }

  // current position
  const chess = new Chess()
  for (const san of path) { try { chess.move(san) } catch { break } }
  const position = chess.fen()

  // current node in tree
  let currentNode = tree
  for (const san of path) currentNode = currentNode?.children?.find((c: any) => c.san === san)

  // build arrows with proper data
  const arrows: { from: string; to: string; opacity: number; isPlayer: boolean }[] = []
  if (currentNode?.children?.length) {
    const tempChess = new Chess(position)
    const sorted = [...currentNode.children].sort((a: any, b: any) => b.count - a.count)
    const isWhiteTurn = path.length % 2 === 0
    const isPlayerTurn = (color === "white" && isWhiteTurn) || (color === "black" && !isWhiteTurn)
    const max = sorted[0]?.count || 1

    for (const child of sorted.slice(0, 5)) {
      try {
        const m = tempChess.move(child.san)
        tempChess.undo()
        if (m) arrows.push({
          from: m.from,
          to: m.to,
          opacity: child.count / max,
          isPlayer: isPlayerTurn,
        })
      } catch {}
    }
  }

  // next candidate moves for clicking
  const candidates = currentNode?.children
    ? [...currentNode.children].sort((a: any, b: any) => b.count - a.count)
    : []

  const onDrop = ({ sourceSquare, targetSquare }: any) => {
    const c = new Chess(position)
    try {
      const m = c.move({ from: sourceSquare, to: targetSquare, promotion: "q" })
      if (m) setPath([...path, m.san])
    } catch {}
  }

  const toXY = (sq: string, boardSize: number) => {
    const cellSize = boardSize / 8
    const f = "abcdefgh".indexOf(sq[0])
    const r = parseInt(sq[1])
    const flip = color === "black"
    return {
      x: (flip ? 7 - f : f) * cellSize + cellSize / 2,
      y: (flip ? r - 1 : 8 - r) * cellSize + cellSize / 2,
    }
  }

  const opening = detectOpening(path)
  const boardSize = 400

  return (
    <div style={{ fontFamily: "monospace", padding: 20, maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ borderBottom: "2px solid black", paddingBottom: 8, marginBottom: 20 }}>Chess Scout</h1>

      {!tree ? (
        <div>
          <div style={{ marginBottom: 8 }}>
            <input
              placeholder="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              style={{ border: "1px solid black", padding: "6px 10px", width: 200 }}
            />
          </div>
          <div style={{ marginBottom: 8 }}>
            <select value={platform} onChange={e => setPlatform(e.target.value)} style={{ border: "1px solid black", padding: "4px 8px" }}>
              <option value="lichess">Lichess</option>
              <option value="chesscom">Chess.com</option>
            </select>
            <select value={color} onChange={e => setColor(e.target.value)} style={{ border: "1px solid black", padding: "4px 8px", marginLeft: 4 }}>
              <option value="white">White</option>
              <option value="black">Black</option>
            </select>
          </div>
          <button
            onClick={fetchGames}
            disabled={loading || !username.trim()}
            style={{ border: "2px solid black", background: "black", color: "white", padding: "8px 20px", cursor: "pointer" }}
          >
            {loading ? "Loading..." : "Scout"}
          </button>
        </div>
      ) : (
        <div>
          {/* controls */}
          <div style={{ marginBottom: 12, display: "flex", gap: 4 }}>
            <button onClick={() => setPath([])} style={btnStyle}>Reset</button>
            <button onClick={() => setPath(path.slice(0, -1))} disabled={!path.length} style={btnStyle}>Back</button>
            <button onClick={() => { setTree(null); setAnalysis("") }} style={btnStyle}>New</button>
            <span style={{ marginLeft: 12, fontSize: 13 }}>{totalGames} games</span>
          </div>

          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            {/* board */}
            <div style={{ position: "relative", width: boardSize, height: boardSize, border: "1px solid black" }}>
              <Chessboard position={position} onDrop={onDrop} width={boardSize} orientation={color as any} />
              <svg width={boardSize} height={boardSize} style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}>
                <defs>
                  <marker id="arrowGreen" markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto">
                    <polygon points="0 0, 4 2, 0 4" fill="rgba(0,0,0,0.8)" />
                  </marker>
                  <marker id="arrowRed" markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto">
                    <polygon points="0 0, 4 2, 0 4" fill="rgba(120,0,0,0.8)" />
                  </marker>
                </defs>
                {arrows.map((a, i) => {
                  const from = toXY(a.from, boardSize)
                  const to = toXY(a.to, boardSize)
                  const markerId = a.isPlayer ? "arrowGreen" : "arrowRed"
                  // shorten the line so arrowhead doesn't overshoot
                  const dx = to.x - from.x, dy = to.y - from.y
                  const len = Math.sqrt(dx * dx + dy * dy)
                  const shorten = 6
                  const toX = to.x - (dx / len) * shorten
                  const toY = to.y - (dy / len) * shorten
                  return (
                    <line
                      key={i}
                      x1={from.x} y1={from.y}
                      x2={toX} y2={toY}
                      stroke={a.isPlayer ? "rgba(0,0,0,0.7)" : "rgba(120,0,0,0.7)"}
                      strokeWidth={i === 0 ? 8 : 5}
                      opacity={Math.max(0.3, a.opacity)}
                      strokeLinecap="round"
                      markerEnd={`url(#${markerId})`}
                    />
                  )
                })}
              </svg>
            </div>

            {/* side panel */}
            <div style={{ flex: 1, minWidth: 200 }}>
              {/* opening */}
              <div style={{ border: "1px solid black", padding: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", marginBottom: 4 }}>Opening</div>
                <div style={{ fontWeight: "bold" }}>{opening}</div>
              </div>

              {/* move list */}
              <div style={{ border: "1px solid black", padding: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", marginBottom: 4 }}>Moves</div>
                <div style={{ fontSize: 13 }}>
                  {path.length === 0 ? (
                    <span style={{ color: "#888" }}>No moves yet</span>
                  ) : (
                    path.map((m, i) => (
                      <span key={i}>
                        {i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : ""}
                        <span
                          style={{ cursor: "pointer", textDecoration: "underline", marginRight: 4 }}
                          onClick={() => setPath(path.slice(0, i + 1))}
                        >{m}</span>
                      </span>
                    ))
                  )}
                </div>
              </div>

              {/* candidate moves */}
              <div style={{ border: "1px solid black", padding: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", marginBottom: 4 }}>Next Moves</div>
                {candidates.length === 0 ? (
                  <span style={{ color: "#888", fontSize: 13 }}>No data</span>
                ) : (
                  candidates.slice(0, 8).map((c: any, i: number) => (
                    <div
                      key={i}
                      style={{ cursor: "pointer", padding: "2px 0", fontSize: 13, display: "flex", justifyContent: "space-between" }}
                      onClick={() => setPath([...path, c.san])}
                    >
                      <span style={{ textDecoration: "underline" }}>{c.san}</span>
                      <span>{c.count} ({Math.round(c.count / (currentNode?.count || 1) * 100)}%)</span>
                    </div>
                  ))
                )}
              </div>

              {/* AI analysis */}
              <div style={{ border: "1px solid black", padding: 10 }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", marginBottom: 4 }}>AI Analysis</div>
                {analyzing ? (
                  <span style={{ color: "#888", fontSize: 13 }}>Analyzing...</span>
                ) : analysis ? (
                  <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{analysis}</div>
                ) : (
                  <span style={{ color: "#888", fontSize: 13 }}>No analysis</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  border: "1px solid black",
  background: "white",
  padding: "4px 12px",
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 13,
}
