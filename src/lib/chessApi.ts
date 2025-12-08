// API utilities for fetching games from chess platforms

export interface GameData {
  pgn: string;
  white: string;
  black: string;
  winner?: string;
  opening?: string;
  timeControl?: string;
  gameId?: string; // Native game ID from platform API
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

// Map time control names to Chess.com time_class values
function mapToChessComTimeClass(timeControl: string): string {
  const mapping: Record<string, string> = {
    'ultrabullet': 'bullet',
    'bullet': 'bullet',
    'blitz': 'blitz',
    'rapid': 'rapid',
    'classical': 'daily',
    'correspondence': 'daily',
    'daily': 'daily'
  };
  return mapping[timeControl] || timeControl;
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

  // If multiple time controls selected, fetch them in PARALLEL batches for speed
  if (timeControls.length > 1) {
    const allGames: GameData[] = [];
    const seenGameIds = new Set<string>(); // Track unique games to prevent duplicates
    let cumulativeCount = 0; // Track total games across all time controls
    
    // Helper function to extract Lichess game ID - prioritize native API ID
    const extractGameId = (game: GameData): string => {
      // Use native game ID from API if available (most reliable)
      if (game.gameId) {
        return `lichess_${game.gameId}`;
      }
      // Fallback: extract from [Site "https://lichess.org/GAMEID"]
      const siteMatch = game.pgn?.match(/\[Site "https:\/\/lichess\.org\/([^"]+)"\]/);
      if (siteMatch?.[1]) {
        return `lichess_${siteMatch[1]}`;
      }
      // Last resort: use full PGN length + last 100 chars for uniqueness (avoids false positives)
      const pgnLen = game.pgn?.length || 0;
      const pgnEnd = game.pgn?.slice(-100) || '';
      return `${game.white}-${game.black}-${game.timeControl}-${pgnLen}-${pgnEnd}`;
    };
    
    console.log(`[FETCH-MULTI] Starting PARALLEL multi-TC fetch for ${username}`);
    console.log(`[FETCH-MULTI] Time controls to fetch: [${timeControls.join(', ')}] (${timeControls.length} total)`);
    console.log(`[FETCH-MULTI] Filters: mode=${mode}, dateFrom=${dateFrom?.toISOString()}, dateTo=${dateTo?.toISOString()}`);
    console.log(`[FETCH-MULTI] Rating filter: ${ratingMin ?? 'any'}-${ratingMax ?? 'any'}, color=${playerColor ?? 'any'}`);
    
    let lastReportedCount = 0; // Track highest count ever reported - NEVER go backwards
    
    // PARALLEL fetching with limit of 2 concurrent requests to respect rate limits
    const PARALLEL_LIMIT = 2;
    const tcChunks: string[][] = [];
    for (let i = 0; i < timeControls.length; i += PARALLEL_LIMIT) {
      tcChunks.push(timeControls.slice(i, i + PARALLEL_LIMIT));
    }
    
    for (const chunk of tcChunks) {
      // Check if aborted
      if (signal?.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }
      
      const chunkStartCount = cumulativeCount;
      
      try {
        // Fetch chunk in parallel - DON'T pass onBatch to inner fetches to avoid race condition
        const results = await Promise.allSettled(
          chunk.map(tc => {
            return fetchLichessGames(
              username,
              { ...options, timeControls: [tc] },
              (count) => {
                // Report cumulative total: games from previous TCs + current chunk progress
                const totalSoFar = cumulativeCount + count;
                // NEVER report a lower count than previously reported
                if (totalSoFar >= lastReportedCount) {
                  lastReportedCount = totalSoFar;
                  if (onProgress) onProgress(totalSoFar);
                }
              },
              undefined, // Don't pass onBatch - we handle dedup/batching synchronously below
              signal
            );
          })
        );
        
        // Collect ALL games from this parallel chunk first
        const chunkGames: GameData[] = [];
        for (const result of results) {
          if (result.status === 'fulfilled') {
            chunkGames.push(...result.value);
            console.log(`[FETCH-MULTI] TC complete: ${result.value.length} games fetched`);
          } else if (result.reason?.name !== 'AbortError') {
            console.warn(`[FETCH-MULTI] TC fetch failed:`, result.reason?.message);
          }
        }
        
        // NOW deduplicate synchronously (no race condition - single threaded)
        const uniqueChunkGames: GameData[] = [];
        let duplicatesRemoved = 0;
        for (const game of chunkGames) {
          const gameId = extractGameId(game);
          if (seenGameIds.has(gameId)) {
            duplicatesRemoved++;
          } else {
            seenGameIds.add(gameId);
            uniqueChunkGames.push(game);
          }
        }
        
        if (duplicatesRemoved > 0) {
          console.log(`[DEDUP] Chunk: ${chunkGames.length} games, ${uniqueChunkGames.length} unique, ${duplicatesRemoved} duplicates removed`);
        }
        
        // Add unique games to allGames and send batch
        allGames.push(...uniqueChunkGames);
        if (onBatch && uniqueChunkGames.length > 0) {
          onBatch(uniqueChunkGames);
        }
        
        // Update cumulative count
        cumulativeCount = allGames.length;
        
        // Minimal delay between chunks (50ms) to avoid rate limit spikes
        if (tcChunks.indexOf(chunk) < tcChunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (error: any) {
        // If aborted, propagate the error
        if (error.name === 'AbortError') {
          throw error;
        }
        
        // If we hit rate limit, stop and return what we have
        if (error.message.includes('429') || error.message.includes('rate limit')) {
          console.warn(`[FETCH-MULTI] Rate limit hit, returning ${allGames.length} games`);
          break;
        }
        throw error;
      }
    }
    
    console.log(`[FETCH-MULTI] All TCs complete. Total unique games: ${allGames.length}`);
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
  
  // Date filtering - normalize to day boundaries for inclusive behavior
  if (dateFrom) {
    const fromStartOfDay = new Date(dateFrom.getTime());
    fromStartOfDay.setHours(0, 0, 0, 0);
    params.append('since', fromStartOfDay.getTime().toString());
    console.log('[LICHESS-API] dateFrom normalized to start of day:', fromStartOfDay.toISOString());
  }
  if (dateTo) {
    const toEndOfDay = new Date(dateTo.getTime());
    toEndOfDay.setHours(23, 59, 59, 999);
    params.append('until', toEndOfDay.getTime().toString());
    console.log('[LICHESS-API] dateTo normalized to end of day:', toEndOfDay.toISOString());
  }
  
  // Mode filtering (rated/casual/all)
  if (mode === "rated") {
    params.append('rated', 'true');
  } else if (mode === "casual") {
    params.append('rated', 'false');
  }
  
  const url = `https://lichess.org/api/games/user/${username}?${params.toString()}`;
  
  console.log('[LICHESS-API] Request URL:', url);
  console.log('[LICHESS-API] Filters applied:', { timeControls, playerColor, mode, dateFrom, dateTo, ratingMin, ratingMax, opponentName });
  const fetchStartTime = performance.now();

  const response = await fetch(url, {
    headers: {
      Accept: "application/x-ndjson",
    },
    signal, // Add abort signal to fetch
  });
  
  console.log('[LICHESS-API] Response received in', (performance.now() - fetchStartTime).toFixed(0), 'ms, status:', response.status);

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
  
  // Filter tracking counters
  let rawGamesRead = 0;
  let lastProgressUpdate = 0; // For throttling progress updates
  const filterDrops = { color: 0, opponentName: 0, rating: 0, timeControl: 0 };
  console.log('[STREAM] Starting to read games...');

  let streamStartTime = performance.now();
  let lastChunkTime = streamStartTime;
  
  try {
    while (true) {
      if (signal?.aborted) {
        console.log('Abort signal detected, stopping stream...');
        try {
          await reader.cancel();
        } catch (e) {
          console.warn('Reader cancel error:', e);
        }
        throw new DOMException('Request aborted', 'AbortError');
      }
      
      if (count >= MAX_GAMES) {
        console.log(`Reached maximum of ${MAX_GAMES} games, stopping fetch`);
        break;
      }
      
      const chunkStart = performance.now();
      const { done, value } = await reader.read();
      const chunkEnd = performance.now();
      
      // Log stalls longer than 2 seconds
      if (chunkEnd - chunkStart > 2000) {
        console.warn('[STREAM-STALL] Chunk read took', (chunkEnd - chunkStart).toFixed(0), 'ms after', count, 'games');
      }
      lastChunkTime = chunkEnd;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const game = JSON.parse(line);
            rawGamesRead++;
            
            // Apply client-side filters with tracking
            let shouldInclude = true;
            let dropReason = '';
            
            // Color filter - only include games where scouted player played the selected color
            if (playerColor) {
              const whiteUser = game.players?.white?.user;
              const blackUser = game.players?.black?.user;
              
              // Handle anonymous/missing user data - skip games where we can't determine player
              if (!whiteUser && !blackUser) {
                console.log('[FILTER-WARN] Game', game.id, 'has no user data on either side, skipping');
                shouldInclude = false;
                dropReason = 'noUserData';
                continue;
              }
              
              const scoutedPlayerPlayedWhite = whiteUser?.name?.toLowerCase() === username.toLowerCase();
              const scoutedPlayerPlayedBlack = blackUser?.name?.toLowerCase() === username.toLowerCase();
              
              // If player not found on either side (e.g., anonymous opponent), skip
              if (!scoutedPlayerPlayedWhite && !scoutedPlayerPlayedBlack) {
                // This is normal for games vs anonymous - include if we can infer from other side
                // If white is anonymous and black matches username, player is black
                if (!whiteUser && blackUser?.name?.toLowerCase() === username.toLowerCase()) {
                  // Player is black
                  if (playerColor !== "black") {
                    shouldInclude = false;
                    dropReason = 'color';
                    filterDrops.color++;
                  }
                } else if (!blackUser && whiteUser?.name?.toLowerCase() === username.toLowerCase()) {
                  // Player is white
                  if (playerColor !== "white") {
                    shouldInclude = false;
                    dropReason = 'color';
                    filterDrops.color++;
                  }
                } else {
                  console.log('[FILTER-WARN] Game', game.id, 'player not found in either color, skipping');
                  shouldInclude = false;
                  dropReason = 'playerNotFound';
                  continue;
                }
              } else {
                const scoutedPlayerColor = scoutedPlayerPlayedWhite ? "white" : "black";
                
                // Only show games where scouted player played the selected color
                if (scoutedPlayerColor !== playerColor) {
                  shouldInclude = false;
                  dropReason = 'color';
                  filterDrops.color++;
                }
              }
            }
            
            // Opponent name filter
            if (shouldInclude && opponentName && opponentName.trim()) {
              const opponent = game.players.white.user?.name?.toLowerCase() === username.toLowerCase() 
                ? game.players.black.user?.name 
                : game.players.white.user?.name;
              if (!opponent?.toLowerCase().includes(opponentName.toLowerCase())) {
                shouldInclude = false;
                dropReason = 'opponentName';
                filterDrops.opponentName++;
              }
            }
            
            // Opponent rating range filter (matches UI label "Opponent Rating Range")
            if (shouldInclude && (ratingMin !== undefined || ratingMax !== undefined)) {
              const playerIsWhite = game.players.white.user?.name?.toLowerCase() === username.toLowerCase();
              const opponentRating = playerIsWhite ? game.players.black.rating : game.players.white.rating;
              const opponentProvisional = playerIsWhite ? game.players.black.provisional : game.players.white.provisional;
              
              // Log rating details for debugging (every 10th game to avoid spam)
              if (count % 10 === 1) {
                console.log(`[RATING-DEBUG] Game ${game.id}: opponent=${opponentRating}, provisional=${opponentProvisional}, filter=${ratingMin ?? 'any'}-${ratingMax ?? 'any'}`);
              }
              
              // If opponent rating is missing/undefined, INCLUDE the game (don't filter on unknown)
              if (opponentRating === undefined || opponentRating === null) {
                console.log('[FILTER-WARN] Game', game.id, 'has no opponent rating, including anyway');
              } else {
                // Use < for inclusive "Minimum X" semantics (rating >= ratingMin)
                // Changed from <= to < to be more inclusive - "Above 1886" means >= 1886
                if (ratingMin !== undefined && opponentRating < ratingMin) {
                  shouldInclude = false;
                  dropReason = 'rating';
                  filterDrops.rating++;
                  console.log(`[RATING-DROP] Game ${game.id}: opponent=${opponentRating} < min=${ratingMin}`);
                }
                if (shouldInclude && ratingMax !== undefined && opponentRating > ratingMax) {
                  shouldInclude = false;
                  dropReason = 'rating';
                  filterDrops.rating++;
                }
              }
            }
            
            // Time control filter - validate API returned correct time control
            if (shouldInclude && timeControls.length > 0 && !timeControls.includes("all")) {
              const gameSpeed = game.speed; // bullet, blitz, rapid, etc.
              if (!timeControls.includes(gameSpeed)) {
                shouldInclude = false;
                dropReason = 'timeControl';
                filterDrops.timeControl++;
              }
            }
            
            if (!shouldInclude) {
              // Log every 100th dropped game to avoid console spam
              if ((filterDrops.color + filterDrops.opponentName + filterDrops.rating + filterDrops.timeControl) % 100 === 1) {
                console.log('[FILTER-DROP] Game', game.id, 'dropped for:', dropReason);
              }
              continue;
            }
            
            const gameData: GameData = {
              pgn: game.pgn,
              white: game.players.white.user?.name || "Unknown",
              black: game.players.black.user?.name || "Unknown",
              winner: game.winner,
              opening: game.opening?.name,
              timeControl: game.speed,
              gameId: game.id, // Native Lichess game ID from API
            };
            
            games.push(gameData);
            batchBuffer.push(gameData);
            count++;
            
            // Throttle progress updates to max 10 per second to reduce React re-renders
            const now = performance.now();
            if (!lastProgressUpdate || now - lastProgressUpdate > 100) {
              if (onProgress) {
                onProgress(count);
              }
              lastProgressUpdate = now;
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
      console.log('[STREAM] Sending final batch of', batchBuffer.length, 'games');
      onBatch([...batchBuffer]);
    }
    
    if (onProgress && count > 0) {
      onProgress(count);
    }
    
    // Log final stream summary with comparison info
    console.log('[STREAM-COMPLETE] Raw games from API:', rawGamesRead);
    console.log('[STREAM-COMPLETE] Games passed filters:', count);
    console.log('[STREAM-COMPLETE] Filter drop summary:', filterDrops);
    console.log('[STREAM-COMPLETE] Drop rate:', rawGamesRead > 0 ? ((rawGamesRead - count) / rawGamesRead * 100).toFixed(1) + '%' : '0%');
    console.log('[COMPARISON] To verify against OpeningTree.org:');
    console.log(`[COMPARISON] 1. Same filters: ${username}, color=${playerColor ?? 'any'}, TCs=${timeControls.join(',')}`);
    console.log(`[COMPARISON] 2. ScoutTree count: ${count} games after filtering from ${rawGamesRead} raw`);
    console.log(`[COMPARISON] 3. If gap exists, check: date boundaries, rating filter edge cases, anonymous players`);
  } catch (error: any) {
    console.log('[STREAM-ERROR] Error at game', rawGamesRead, '- filter drops so far:', filterDrops);
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
    
    // Filter archives by date range - be inclusive of boundary months
    // Important: We need to include months that COULD contain games in the date range
    let filteredArchives = archives;
    if (dateFrom || dateTo) {
      filteredArchives = archives.filter((archiveUrl: string) => {
        const match = archiveUrl.match(/\/(\d{4})\/(\d{2})$/);
        if (!match) return true;
        
        const [, year, month] = match;
        const archiveYear = parseInt(year);
        const archiveMonth = parseInt(month) - 1; // 0-indexed month
        
        // Create date at start and end of archive month for proper comparison
        const archiveMonthStart = new Date(archiveYear, archiveMonth, 1);
        archiveMonthStart.setHours(0, 0, 0, 0);
        
        // Last day of month at 23:59:59
        const archiveMonthEnd = new Date(archiveYear, archiveMonth + 1, 0);
        archiveMonthEnd.setHours(23, 59, 59, 999);
        
        // Normalize dateFrom to start of day and dateTo to end of day for fair comparison
        const normalizedDateFrom = dateFrom ? new Date(dateFrom.getTime()) : null;
        if (normalizedDateFrom) {
          normalizedDateFrom.setHours(0, 0, 0, 0);
        }
        
        const normalizedDateTo = dateTo ? new Date(dateTo.getTime()) : null;
        if (normalizedDateTo) {
          normalizedDateTo.setHours(23, 59, 59, 999);
        }
        
        // Include archive if it overlaps with the date range
        // Archive is excluded only if it's entirely BEFORE dateFrom or entirely AFTER dateTo
        if (normalizedDateFrom && archiveMonthEnd.getTime() < normalizedDateFrom.getTime()) {
          return false;
        }
        if (normalizedDateTo && archiveMonthStart.getTime() > normalizedDateTo.getTime()) {
          return false;
        }
        
        return true;
      });
      
      console.log(`Date range filtering: ${archives.length} total archives, ${filteredArchives.length} match date range`);
      if (dateFrom) console.log(`  dateFrom: ${dateFrom.toISOString()}`);
      if (dateTo) console.log(`  dateTo: ${dateTo.toISOString()}`);
    }

    console.log(`[CHESS.COM] Fetching archives for ${username}: ${filteredArchives.length} archives to process`);
    console.log(`[CHESS.COM] Filters: TCs=${timeControls.join(',')}, mode=${mode}, color=${playerColor ?? 'any'}`);
    console.log(`[CHESS.COM] Date range: ${dateFrom?.toISOString() ?? 'any'} to ${dateTo?.toISOString() ?? 'any'}`);
    console.log(`[CHESS.COM] Rating filter: ${ratingMin ?? 'any'}-${ratingMax ?? 'any'}`);
    
    // Process ALL archives (reversed to get newest first)
    const recentArchives = filteredArchives.reverse();
    const allGames: GameData[] = [];
    let count = 0;
    const MAX_GAMES = 3000; // Limit to prevent crashes

    for (const archiveUrl of recentArchives) {
      // Check if aborted
      if (signal?.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }
      
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
          signal, // Add abort signal to fetch
        });

        if (!response.ok) {
          console.warn(`Failed to fetch archive ${archiveUrl}:`, response.status);
          continue;
        }

        const data = await response.json();
        
        if (!data.games || !Array.isArray(data.games)) {
          continue;
        }

        let batchGames: GameData[] = [];
        let gamesBeforeFilter = data.games.length;
        
        for (const game of data.games) {
          // Apply filters
          if (mode === "rated" && !game.rated) continue;
          if (mode === "casual" && game.rated) continue;
          
          // Variant filter (Chess.com uses "rules" field)
          if (variant && variant !== "standard") {
            const gameRules = game.rules || "chess";
            if (gameRules !== variant) continue;
          }
          
          // Time control filter with mapping to Chess.com time_class
          if (timeControls.length > 0 && !timeControls.includes("all")) {
            const mappedControls = timeControls.map(mapToChessComTimeClass);
            if (!game.time_class || !mappedControls.includes(game.time_class)) continue;
          }
          
          // Date range filter (end_time is in seconds since epoch)
          // Be inclusive: dateFrom at 00:00:00 and dateTo at 23:59:59
          if (dateFrom) {
            const dateFromTimestamp = new Date(dateFrom.getTime());
            dateFromTimestamp.setHours(0, 0, 0, 0);
            if (game.end_time < dateFromTimestamp.getTime() / 1000) {
              continue;
            }
          }
          if (dateTo) {
            const dateToTimestamp = new Date(dateTo.getTime());
            dateToTimestamp.setHours(23, 59, 59, 999);
            if (game.end_time > dateToTimestamp.getTime() / 1000) {
              continue;
            }
          }
          
          // Color filter - only include games where scouted player played the selected color
          if (playerColor) {
            const scoutedPlayerPlayedWhite = game.white.username.toLowerCase() === normalizedUsername;
            const scoutedPlayerColor = scoutedPlayerPlayedWhite ? "white" : "black";
            
            // Only show games where scouted player played the selected color
            if (scoutedPlayerColor !== playerColor) {
              continue;
            }
          }
          
          // Rating filter - handle missing ratings gracefully
          const opponentRating = game.white.username.toLowerCase() === normalizedUsername
            ? game.black.rating
            : game.white.rating;
          
          // Only filter if opponent rating exists AND is outside range
          if (opponentRating !== undefined && opponentRating !== null) {
            if (ratingMin && opponentRating < ratingMin) continue;
            if (ratingMax && opponentRating > ratingMax) continue;
          }
          // If rating is missing, include the game (don't filter on unknown)
          
          // Opponent name filter (use partial match like Lichess)
          if (opponentName) {
            const opponent = game.white.username.toLowerCase() === normalizedUsername
              ? game.black.username
              : game.white.username;
            
            if (!opponent.toLowerCase().includes(opponentName.toLowerCase())) continue;
          }
          
          // Extract Chess.com game ID from URL (format: https://www.chess.com/game/live/123456789)
          const chessComGameId = game.url?.split('/').pop() || game.uuid;
          
          const gameData: GameData = {
            pgn: game.pgn,
            white: game.white.username.toLowerCase(), // Normalize to lowercase for consistent matching
            black: game.black.username.toLowerCase(), // Normalize to lowercase for consistent matching
            winner: game.white.result === "win" ? "white" : 
                    game.black.result === "win" ? "black" : undefined,
            timeControl: game.time_class,
            gameId: chessComGameId, // Native Chess.com game ID
          };
          
          batchGames.push(gameData);
          allGames.push(gameData);
          count++;
          
          // Update progress every game
          if (onProgress) {
            onProgress(count);
          }
          
          // Send first game immediately for instant visualization
          if (count === 1 && onBatch) {
            onBatch([gameData]);
            batchGames = []; // Clear after sending first game
          }
          // Then send batches every 5 games from the current batch buffer
          else if (batchGames.length >= 5 && onBatch) {
            onBatch([...batchGames]);
            batchGames = []; // Clear batch after sending
          }
        }

        console.log(`[CHESS.COM] Archive ${archiveUrl.split('/').slice(-2).join('/')}: ${gamesBeforeFilter} raw games, ${allGames.length} passed filters`);
        
        // Send any remaining games in the batch after processing this archive
        if (batchGames.length > 0 && onBatch) {
          onBatch(batchGames);
          batchGames = [];
        }
      } catch (error) {
        console.warn(`Error processing archive ${archiveUrl}:`, error);
        continue;
      }
    }

    console.log(`[CHESS.COM] FINAL: Total games fetched and passed all filters: ${allGames.length}`);
    
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
