import { useState } from "react"
import { Chess } from "chess.js"
import Chessboard from "chessboardjsx"

export default function Index() {
  const [username, setUsername] = useState("")
  const [platform, setPlatform] = useState("lichess")
  const [color, setColor] = useState("white")
  const [loading, setLoading] = useState(false)
  const [tree, setTree] = useState<any>(null)
  const [path, setPath] = useState<string[]>([])

  const fetchGames = async () => {
    if (!username) return
    setLoading(true)
    let pgns: string[] = []

    if (platform === "lichess") {
      const res = await fetch(`https://lichess.org/api/games/user/${username}?color=${color}&max=200`, {
        headers: { Accept: "application/x-ndjson" }
      })
      const text = await res.text()
      for (const line of text.split("\n")) {
        try { const g = JSON.parse(line); if (g.pgn) pgns.push(g.pgn) } catch {}
      }
    } else {
      const res = await fetch(`https://api.chess.com/pub/player/${username}/games/archives`)
      const { archives } = await res.json()
      for (const url of archives.slice(-3)) {
        const r = await fetch(url)
        const { games } = await r.json()
        for (const g of games || []) {
          const isMyColor = color === "white"
            ? g.white?.username?.toLowerCase() === username.toLowerCase()
            : g.black?.username?.toLowerCase() === username.toLowerCase()
          if (isMyColor && g.pgn) pgns.push(g.pgn)
        }
      }
    }

    // build simple tree
    const root = { san: "", count: 0, children: [] as any[] }
    for (const pgn of pgns) {
      const moves = pgn.replace(/\[.*?\]/g, "").replace(/\{[^}]*\}/g, "").trim().split(/\s+/)
        .filter(t => t && !/^\d+\./.test(t) && !["1-0","0-1","1/2-1/2","*"].includes(t))
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
    setLoading(false)
  }

  // current position
  const chess = new Chess()
  for (const san of path) { try { chess.move(san) } catch { break } }
  const position = chess.fen()

  // find current node
  let currentNode = tree
  for (const san of path) currentNode = currentNode?.children?.find((c: any) => c.san === san)

  // arrows for top moves
  const arrows: any[] = []
  if (currentNode?.children) {
    const sorted = [...currentNode.children].sort((a: any, b: any) => b.count - a.count)
    for (const child of sorted.slice(0, 5)) {
      try { const m = chess.move(child.san); chess.undo(); if (m) arrows.push({ from: m.from, to: m.to }) } catch {}
    }
  }

  const onDrop = ({ sourceSquare, targetSquare }: any) => {
    const c = new Chess(position)
    try { const m = c.move({ from: sourceSquare, to: targetSquare, promotion: "q" }); if (m) setPath([...path, m.san]) } catch {}
  }

  const toXY = (sq: string) => {
    const f = "abcdefgh".indexOf(sq[0]), r = parseInt(sq[1]), flip = color === "black"
    return { x: (flip ? 7 - f : f) * 50 + 25, y: (flip ? r - 1 : 8 - r) * 50 + 25 }
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>Chess Scout</h1>
      {!tree ? (
        <div>
          <input placeholder="username" value={username} onChange={e => setUsername(e.target.value)} />
          <select value={platform} onChange={e => setPlatform(e.target.value)}>
            <option value="lichess">Lichess</option>
            <option value="chesscom">Chess.com</option>
          </select>
          <select value={color} onChange={e => setColor(e.target.value)}>
            <option value="white">White</option>
            <option value="black">Black</option>
          </select>
          <button onClick={fetchGames} disabled={loading}>{loading ? "Loading..." : "Go"}</button>
        </div>
      ) : (
        <div>
          <button onClick={() => setPath([])}>Reset</button>
          <button onClick={() => setPath(path.slice(0, -1))}>Back</button>
          <button onClick={() => setTree(null)}>New</button>
          <div style={{ position: "relative", width: 400, height: 400, marginTop: 10 }}>
            <Chessboard position={position} onDrop={onDrop} width={400} orientation={color as any} />
            <svg width={400} height={400} style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}>
              {arrows.map((a, i) => {
                const from = toXY(a.from), to = toXY(a.to)
                return <line key={i} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="green" strokeWidth={6} opacity={i === 0 ? 1 : 0.4} />
              })}
            </svg>
          </div>
        </div>
      )}
    </div>
  )
}
