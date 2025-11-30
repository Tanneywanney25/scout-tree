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
  variant?: string;
  timeControls?: string[];
  mode?: "all" | "rated" | "casual";
  dateFrom?: Date;
  dateTo?: Date;
  ratingMin?: number;
  ratingMax?: number;
  opponentName?: string;
  playerColor?: "white" | "black"; // Color the user will play (opponent plays opposite)
}

export async function fetchLichessGames(
  username: string,
  options: FetchOptions = {},
  onProgress?: (count: number) => void,
  onBatch?: (games: GameData[]) => void,
  signal?: AbortSignal
): Promise<GameData[]> {
  const {
    variant = "standard",
    timeControls = ["blitz"],
    mode = "all",
    dateFrom,
    dateTo,
    ratingMin,
    ratingMax,
    opponentName,
    playerColor
  } = options;

  // If multiple time controls selected, fetch them SEQUENTIALLY to avoid 429 rate limit
  if (timeControls.length > 1) {
    const allGames: GameData[] = [];
    let totalCount = 0;
    
    // SEQUENTIAL fetching - await each request before starting the next
    for (const tc of timeControls) {
      // Check if aborted
      if (signal?.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }
      
      try {
        const tcGames = await fetchLichessGames(
          username,
          { ...options, timeControls: [tc] },
          (count) => {
            totalCount = allGames.length + count;
            if (onProgress) onProgress(totalCount);
          },
          onBatch,
          signal
        );
        allGames.push(...tcGames);
        
        // Add delay between time controls only if games were found (to respect rate limits)
        if (timeControls.indexOf(tc) < timeControls.length - 1 && tcGames.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 300)); // Reduced to 300ms for speed
        }
      } catch (error: any) {
        // If aborted, propagate the error
        if (error.name === 'AbortError') {
          throw error;
        }
        
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

  // Build query parameters properly
  const params = new URLSearchParams();
  
  // Add variant if not standard
  if (variant && variant !== "standard") {
    params.append('perfType', variant);
  }
  
  // Add perfType (time control) if specified and no variant override
  if ((!variant || variant === "standard") && timeControls[0] && timeControls[0] !== "all") {
    params.append('perfType', timeControls[0]);
  }
  
  // Always include pgnInJson
  params.append('pgnInJson', 'true');
  
  // Date filtering
  if (dateFrom) {
    params.append('since', dateFrom.getTime().toString());
  }
  if (dateTo) {
    params.append('until', dateTo.getTime().toString());
  }
  
  // Mode filtering (rated/casual/all)
  if (mode === "rated") {
    params.append('rated', 'true');
  } else if (mode === "casual") {
    params.append('rated', 'false');
  }
  
  const url = `https://lichess.org/api/games/user/${username}?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/x-ndjson",
    },
    signal, // Add abort signal to fetch
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
  const MAX_GAMES = 3000; // Limit to prevent crashes

  try {
    while (true) {
      // Check if aborted during streaming
      if (signal?.aborted) {
        console.log('Abort signal detected, stopping stream...');
        try {
          await reader.cancel();
        } catch (e) {
          console.warn('Reader cancel error:', e);
        }
        throw new DOMException('Request aborted', 'AbortError');
      }
      
      // Stop if we've reached the game limit
      if (count >= MAX_GAMES) {
        console.log(`Reached maximum of ${MAX_GAMES} games, stopping fetch`);
        break;
      }
      
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
            
            // Color filter - user selects their color, so we want opponent's games with opposite color
            if (playerColor) {
              // Check what color the target opponent played in this game
              const opponentPlayedWhite = game.players.white.user?.name?.toLowerCase() === username.toLowerCase();
              const opponentColor = opponentPlayedWhite ? "white" : "black";
              
              // User plays playerColor, so we need opponent's games where they played the OPPOSITE color
              // e.g., if user plays white, analyze opponent's BLACK games
              const neededOpponentColor = playerColor === "white" ? "black" : "white";
              
              if (opponentColor !== neededOpponentColor) {
                shouldInclude = false;
              }
            }
            
            // Opponent name filter
            if (opponentName && opponentName.trim()) {
              const opponent = game.players.white.user?.name?.toLowerCase() === username.toLowerCase() 
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
            
            // Update progress every game for smooth counting
            if (onProgress) {
              onProgress(count);
            }
            
            // Send first game immediately for instant visualization
            if (count === 1 && onBatch) {
              onBatch([...batchBuffer]);
              batchBuffer = [];
            }
            // Then send batches every 5 games for progressive updates
            else if (batchBuffer.length >= 5 && onBatch) {
              onBatch([...batchBuffer]);
              batchBuffer = [];
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
  } catch (error: any) {
    // Ensure reader is properly closed
    try {
      await reader.cancel();
    } catch (e) {
      // Ignore cancel errors
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch (e) {
      // Reader might already be released
    }
  }

  return games;
}

export async function fetchChessComGames(
  username: string,
  options: FetchOptions = {},
  onProgress?: (count: number) => void,
  onBatch?: (games: GameData[]) => void
): Promise<GameData[]> {
  const {
    variant = "standard",
    timeControls = ["blitz"],
    mode = "all",
    dateFrom,
    dateTo,
    ratingMin,
    ratingMax,
    opponentName,
    playerColor
  } = options;
  
  // Chess.com usernames must be lowercase
  const normalizedUsername = username.toLowerCase().trim();
  
  // First get archives list
  const archivesUrl = `https://api.chess.com/pub/player/${normalizedUsername}/games/archives`;
  
  try {
    const archivesResponse = await fetch(archivesUrl, {
      headers: {
        "User-Agent": "ScoutTree/1.0 (contact: support@scouttree.com)",
      },
    });

    if (!archivesResponse.ok) {
      if (archivesResponse.status === 404) {
        throw new Error(`Chess.com user "${username}" not found. Make sure the username is correct.`);
      }
      throw new Error(`Chess.com API error: ${archivesResponse.status}`);
    }

    const { archives } = await archivesResponse.json();
    
    if (!archives || archives.length === 0) {
      throw new Error(`No game archives found for Chess.com user "${username}"`);
    }
    
    // Filter archives by date range
    let filteredArchives = archives;
    if (dateFrom || dateTo) {
      filteredArchives = archives.filter((archiveUrl: string) => {
        const match = archiveUrl.match(/\/(\d{4})\/(\d{2})$/);
        if (!match) return true;
        
        const [, year, month] = match;
        const archiveDate = new Date(parseInt(year), parseInt(month) - 1);
        
        if (dateFrom && archiveDate < new Date(dateFrom.getFullYear(), dateFrom.getMonth())) {
          return false;
        }
        if (dateTo && archiveDate > new Date(dateTo.getFullYear(), dateTo.getMonth() + 1)) {
          return false;
        }
        
        return true;
      });
    }
    
    // Process ALL archives (reversed to get newest first)
    const recentArchives = filteredArchives.reverse();
    const allGames: GameData[] = [];
    let count = 0;
    const MAX_GAMES = 3000; // Limit to prevent crashes

    for (const archiveUrl of recentArchives) {
      // Stop if we've reached the game limit
      if (count >= MAX_GAMES) {
        console.log(`Reached maximum of ${MAX_GAMES} games, stopping fetch`);
        break;
      }
      // Rate limiting: wait between archive requests only if we have fetched games
      if (count > 0 && allGames.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 300)); // Reduced to 300ms
      }

      try {
        const response = await fetch(archiveUrl, {
          headers: {
            "User-Agent": "ScoutTree/1.0 (contact: support@scouttree.com)",
          },
        });

        if (!response.ok) {
          console.warn(`Failed to fetch archive ${archiveUrl}:`, response.status);
          continue;
        }

        const data = await response.json();
        const batchGames: GameData[] = [];
        
        for (const game of data.games || []) {
          // Apply filters
          if (mode === "rated" && !game.rated) continue;
          if (mode === "casual" && game.rated) continue;
          
          // Variant filter (Chess.com uses "rules" field)
          if (variant && variant !== "standard") {
            const gameRules = game.rules || "chess";
            if (gameRules !== variant) continue;
          }
          
          // Time control filter
          if (timeControls.length > 0 && !timeControls.includes("all")) {
            if (!timeControls.includes(game.time_class)) continue;
          }
          
          // Date range filter (end_time is in seconds)
          if (dateFrom && game.end_time < dateFrom.getTime() / 1000) continue;
          if (dateTo && game.end_time > dateTo.getTime() / 1000) continue;
          
          // Color filter - user selects their color, so we want opponent's games with opposite color
          if (playerColor) {
            // Check what color the target opponent played in this game
            const opponentPlayedWhite = game.white.username.toLowerCase() === normalizedUsername;
            const opponentColor = opponentPlayedWhite ? "white" : "black";
            
            // User plays playerColor, so we need opponent's games where they played the OPPOSITE color
            // e.g., if user plays white, analyze opponent's BLACK games
            const neededOpponentColor = playerColor === "white" ? "black" : "white";
            
            if (opponentColor !== neededOpponentColor) {
              continue;
            }
          }
          
          // Rating filter
          const opponentRating = game.white.username.toLowerCase() === normalizedUsername
            ? game.black.rating
            : game.white.rating;
          
          if (ratingMin && opponentRating < ratingMin) continue;
          if (ratingMax && opponentRating > ratingMax) continue;
          
          // Opponent name filter (use partial match like Lichess)
          if (opponentName) {
            const opponent = game.white.username.toLowerCase() === normalizedUsername
              ? game.black.username
              : game.white.username;
            
            if (!opponent.toLowerCase().includes(opponentName.toLowerCase())) continue;
          }
          
          batchGames.push({
            pgn: game.pgn,
            white: game.white.username,
            black: game.black.username,
            winner: game.white.result === "win" ? "white" : 
                    game.black.result === "win" ? "black" : undefined,
            timeControl: game.time_class,
          });
          
          count++;
        }
        
        // Send first game immediately for instant visualization
        if (count === 1 && batchGames.length > 0 && onBatch) {
          onBatch(batchGames.slice(0, 1));
        }
        
        allGames.push(...batchGames);
        
        // Send batch update every 5 games
        if (batchGames.length > 0 && onBatch && count % 5 === 0) {
          onBatch(batchGames);
        }
        
        if (onProgress) {
          onProgress(count);
        }
      } catch (error) {
        console.warn(`Error processing archive ${archiveUrl}:`, error);
        continue;
      }
    }

    if (allGames.length === 0) {
      throw new Error(`No games found for Chess.com user "${username}" with the selected filters`);
    }

    return allGames;
  } catch (error: any) {
    if (error.message.includes('Chess.com')) {
      throw error;
    }
    throw new Error(`Failed to fetch Chess.com games: ${error.message}`);
  }
}
