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
  dateFilter: "all" | "year" | "6months" = "all",
  onProgress?: (count: number) => void
): Promise<GameData[]> {
  const perfType = timeControl === "all" ? "" : `&perfType=${timeControl}`;
  
  // Calculate since timestamp for date filtering
  let sinceParam = "";
  if (dateFilter === "year") {
    const yearAgo = Date.now() - (365 * 24 * 60 * 60 * 1000);
    sinceParam = `&since=${yearAgo}`;
  } else if (dateFilter === "6months") {
    const sixMonthsAgo = Date.now() - (180 * 24 * 60 * 60 * 1000);
    sinceParam = `&since=${sixMonthsAgo}`;
  }
  
  const url = `https://lichess.org/api/games/user/${username}?${perfType}&pgnInJson=true&rated=true${sinceParam}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/x-ndjson",
    },
  });

  if (!response.ok) {
    throw new Error(`Lichess API error: ${response.status} ${response.statusText}`);
  }

  // Stream processing for large datasets
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Failed to get response reader");
  }

  const decoder = new TextDecoder();
  let buffer = '';
  const games: GameData[] = [];
  let count = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      
      // Keep incomplete line in buffer
      buffer = lines.pop() || '';
      
      // Process all complete lines
      for (const line of lines) {
        if (line.trim()) {
          try {
            const game = JSON.parse(line);
            games.push({
              pgn: game.pgn,
              white: game.players.white.user?.name || "Unknown",
              black: game.players.black.user?.name || "Unknown",
              winner: game.winner,
              opening: game.opening?.name,
              timeControl: game.speed,
            });
            count++;
            
            // Update progress every 50 games
            if (count % 50 === 0 && onProgress) {
              onProgress(count);
            }
          } catch (e) {
            console.warn("Failed to parse game line:", e);
          }
        }
      }
    }
    
    // Final progress update
    if (onProgress && count > 0) {
      onProgress(count);
    }
  } finally {
    reader.releaseLock();
  }

  return games;
}

export async function fetchChessComGames(
  username: string,
  timeControl: string = "blitz"
): Promise<GameData[]> {
  const maxGames = 500; // Chess.com: limited to prevent rate limiting
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
