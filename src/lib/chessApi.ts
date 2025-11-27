// API utilities for fetching games from chess platforms

export interface GameData {
  pgn: string;
  white: string;
  black: string;
  winner?: string;
  opening?: string;
  timeControl?: string;
}

export async function fetchLichessGames(
  username: string,
  timeControl: string = "blitz",
  maxGames: number = 500
): Promise<GameData[]> {
  const perfType = timeControl === "all" ? "" : `&perfType=${timeControl}`;
  const url = `https://lichess.org/api/games/user/${username}?max=${maxGames}${perfType}&pgnInJson=true`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/x-ndjson",
    },
  });

  if (!response.ok) {
    throw new Error(`Lichess API error: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const lines = text.trim().split("\n").filter(line => line.trim());
  
  const games: GameData[] = lines.map(line => {
    const game = JSON.parse(line);
    return {
      pgn: game.pgn,
      white: game.players.white.user?.name || "Unknown",
      black: game.players.black.user?.name || "Unknown",
      winner: game.winner,
      opening: game.opening?.name,
      timeControl: game.speed,
    };
  });

  return games;
}

export async function fetchChessComGames(
  username: string,
  timeControl: string = "blitz",
  maxGames: number = 500
): Promise<GameData[]> {
  // First get archives list
  const archivesUrl = `https://api.chess.com/pub/player/${username}/games/archives`;
  
  const archivesResponse = await fetch(archivesUrl, {
    headers: {
      "User-Agent": "ScoutTree/1.0 (contact: support@scouttree.com)",
    },
  });

  if (!archivesResponse.ok) {
    throw new Error(`Chess.com API error: ${archivesResponse.status}`);
  }

  const { archives } = await archivesResponse.json();
  
  // Fetch games from recent archives (last 3 months)
  const recentArchives = archives.slice(-3);
  const allGames: GameData[] = [];

  for (const archiveUrl of recentArchives) {
    // Rate limiting: wait 1 second between requests
    if (allGames.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const response = await fetch(archiveUrl, {
      headers: {
        "User-Agent": "ScoutTree/1.0 (contact: support@scouttree.com)",
      },
    });

    if (!response.ok) continue;

    const data = await response.json();
    const games = data.games
      .filter((game: any) => {
        if (timeControl === "all") return true;
        return game.time_class === timeControl;
      })
      .map((game: any) => ({
        pgn: game.pgn,
        white: game.white.username,
        black: game.black.username,
        winner: game.white.result === "win" ? "white" : 
                game.black.result === "win" ? "black" : undefined,
        timeControl: game.time_class,
      }));

    allGames.push(...games);
    
    if (allGames.length >= maxGames) break;
  }

  return allGames.slice(0, maxGames);
}
