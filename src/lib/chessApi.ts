// API utilities for fetching games from chess platforms

export interface GameData {
  pgn: string;
  white: string;
  black: string;
  winner?: string;
  opening?: string;
  timeControl?: string;
}

export interface FetchOptions {
  timeControls?: string[];
  mode?: "all" | "rated" | "casual";
  dateFrom?: Date;
  dateTo?: Date;
  ratingMin?: number;
  ratingMax?: number;
  opponentName?: string;
}

export async function fetchLichessGames(
  username: string,
  options: FetchOptions = {},
  onProgress?: (count: number) => void,
  onBatch?: (games: GameData[]) => void
): Promise<GameData[]> {
  const {
    timeControls = ["blitz"],
    mode = "all",
    dateFrom,
    dateTo,
    ratingMin,
    ratingMax,
    opponentName
  } = options;

  // If multiple time controls selected, fetch them SEQUENTIALLY to avoid 429 rate limit
  if (timeControls.length > 1) {
    const allGames: GameData[] = [];
    let totalCount = 0;
    
    // SEQUENTIAL fetching - await each request before starting the next
    for (const tc of timeControls) {
      try {
        const tcGames = await fetchLichessGames(
          username,
          { ...options, timeControls: [tc] },
          (count) => {
            totalCount = allGames.length + count;
            if (onProgress) onProgress(totalCount);
          },
          onBatch
        );
        allGames.push(...tcGames);
        
        // Add small delay between time controls to respect rate limits
        if (timeControls.indexOf(tc) < timeControls.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error: any) {
        // If we hit rate limit, stop and return what we have
        if (error.message.includes('429') || error.message.includes('rate limit')) {
          console.warn(`Rate limit hit at time control ${tc}, returning ${allGames.length} games`);
          break;
        }
        throw error;
      }
    }
    
    return allGames;
  }

  const perfType = timeControls[0] && timeControls[0] !== "all" ? `&perfType=${timeControls[0]}` : "";
  
  // Date filtering
  let sinceParam = "";
  let untilParam = "";
  if (dateFrom) {
    sinceParam = `&since=${dateFrom.getTime()}`;
  }
  if (dateTo) {
    untilParam = `&until=${dateTo.getTime()}`;
  }
  
  // Mode filtering (rated/casual/all)
  let ratedParam = "";
  if (mode === "rated") {
    ratedParam = "&rated=true";
  } else if (mode === "casual") {
    ratedParam = "&rated=false";
  }
  // If mode === "all", don't add rated parameter to get both
  
  const url = `https://lichess.org/api/games/user/${username}?${perfType}&pgnInJson=true${ratedParam}${sinceParam}${untilParam}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/x-ndjson",
    },
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(`Rate limit exceeded. Lichess allows only 1 request at a time. Please wait a moment and try again.`);
    }
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
  let batchBuffer: GameData[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const game = JSON.parse(line);
            
            // Apply client-side filters
            let shouldInclude = true;
            
            // Opponent name filter
            if (opponentName && opponentName.trim()) {
              const opponent = game.players.white.user?.name === username.toLowerCase() 
                ? game.players.black.user?.name 
                : game.players.white.user?.name;
              if (!opponent?.toLowerCase().includes(opponentName.toLowerCase())) {
                shouldInclude = false;
              }
            }
            
            // Rating range filter
            if (ratingMin !== undefined || ratingMax !== undefined) {
              const playerIsWhite = game.players.white.user?.name?.toLowerCase() === username.toLowerCase();
              const playerRating = playerIsWhite ? game.players.white.rating : game.players.black.rating;
              
              if (ratingMin !== undefined && playerRating < ratingMin) {
                shouldInclude = false;
              }
              if (ratingMax !== undefined && playerRating > ratingMax) {
                shouldInclude = false;
              }
            }
            
            if (!shouldInclude) continue;
            
            const gameData: GameData = {
              pgn: game.pgn,
              white: game.players.white.user?.name || "Unknown",
              black: game.players.black.user?.name || "Unknown",
              winner: game.winner,
              opening: game.opening?.name,
              timeControl: game.speed,
            };
            
            games.push(gameData);
            batchBuffer.push(gameData);
            count++;
            
            // Send batch every 25 games for immediate analysis
            if (batchBuffer.length >= 25 && onBatch) {
              onBatch([...batchBuffer]);
              batchBuffer = [];
            }
            
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
    
    // Send remaining games in batch
    if (batchBuffer.length > 0 && onBatch) {
      onBatch([...batchBuffer]);
    }
    
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
