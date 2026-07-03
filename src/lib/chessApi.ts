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

// A scout must return fast (≤90s). Lichess hard-throttles game export to ~8
// games/s per stream and allows only 2 concurrent streams per IP (a 3rd → 429),
// so the real ceiling is ~16 raw games/s. We therefore bound a fetch by BOTH a
// raw-game budget and an absolute wall-clock deadline, shared (by reference)
// across every concurrent stream and across both platforms so the whole fetch
// stops together. The deadline is the hard guarantee; the budget usually trips
// first and yields a full, representative dataset well inside the time box.
export interface FetchBudget {
  maxRawGames: number; // stop once this many games have been *streamed* (pre client-side filters)
  deadlineTs: number; // Date.now() cutoff; fetching stops at/after this instant
  rawFetched: number; // mutated in place as games stream in
}

// Default budget: ~16 raw games/s × ~75s ≈ 1200 games, with an 80s hard wall.
// A one-colour opening tree from the most-recent ~600 games (after the ~50%
// colour filter) is highly representative, and 80s leaves headroom under 90s
// for the final parse/merge.
export const DEFAULT_RAW_GAME_BUDGET = 1200;
export const DEFAULT_FETCH_DEADLINE_MS = 80_000;

export function createFetchBudget(
  maxRawGames = DEFAULT_RAW_GAME_BUDGET,
  deadlineMs = DEFAULT_FETCH_DEADLINE_MS,
): FetchBudget {
  return { maxRawGames, deadlineTs: Date.now() + deadlineMs, rawFetched: 0 };
}

function budgetExhausted(budget?: FetchBudget): boolean {
  if (!budget) return false;
  return budget.rawFetched >= budget.maxRawGames || Date.now() >= budget.deadlineTs;
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
  signal?: AbortSignal,
  budget?: FetchBudget
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

      // Stop launching new time-control streams once the raw-game budget or the
      // wall-clock deadline is hit — this is what keeps a scout inside 90s.
      if (budgetExhausted(budget)) {
        console.log(`[FETCH-MULTI] Budget/deadline reached, returning ${allGames.length} games`);
        break;
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
              signal,
              budget // shared across the 2 concurrent streams in this chunk
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
  
  // Always include pgnInJson and clocks for time management analysis
  params.append('pgnInJson', 'true');
  params.append('clocks', 'true');

  // Cap the stream server-side to the remaining raw-game budget. Lichess returns
  // most-recent games first, so this yields a fresh, representative sample and —
  // crucially, given the ~8 games/s throttle — lets the server stop early instead
  // of streaming a player's entire multi-thousand-game history.
  if (budget) {
    const remaining = Math.max(1, budget.maxRawGames - budget.rawFetched);
    params.append('max', String(remaining));
  }
  
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

      // Stop as soon as the shared raw-game budget or wall-clock deadline is hit.
      if (budgetExhausted(budget)) {
        try { await reader.cancel(); } catch { /* ignore */ }
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
            if (budget) budget.rawFetched++;

            // Apply client-side filters with tracking
            let shouldInclude = true;
            let dropReason = '';
            
            // Color filter - only include games where scouted player played the selected color
            if (playerColor) {
              const whiteUser = game.players?.white?.user;
              const blackUser = game.players?.black?.user;
              
              // Handle anonymous/missing user data - skip games where we can't determine player
              if (!whiteUser && !blackUser) {
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

              // If opponent rating is missing/undefined, INCLUDE the game (don't filter on unknown).
              if (opponentRating !== undefined && opponentRating !== null) {
                // ratingMin is inclusive ("Minimum X" → rating >= X), ratingMax inclusive.
                if (ratingMin !== undefined && opponentRating < ratingMin) {
                  shouldInclude = false;
                  dropReason = 'rating';
                  filterDrops.rating++;
                } else if (ratingMax !== undefined && opponentRating > ratingMax) {
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
  signal?: AbortSignal,
  budget?: FetchBudget
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

    console.log(`[CHESS.COM] ${filteredArchives.length} archives to process (parallel, newest-first)`);

    // Newest-first so the freshest games count against the budget first.
    const recentArchives: string[] = filteredArchives.slice().reverse();
    const allGames: GameData[] = [];
    let count = 0;
    const MAX_GAMES = 3000; // Client safety cap

    // Per-game filtering, factored out so archives can be fetched in parallel and
    // their games folded in centrally. Same filter semantics as before.
    const filterArchiveGames = (games: any[]): GameData[] => {
      const out: GameData[] = [];
      for (const game of games) {
        if (mode === "rated" && !game.rated) continue;
        if (mode === "casual" && game.rated) continue;

        if (variant && variant !== "standard") {
          const gameRules = game.rules || "chess";
          if (gameRules !== variant) continue;
        }

        if (timeControls.length > 0 && !timeControls.includes("all")) {
          const mappedControls = timeControls.map(mapToChessComTimeClass);
          if (!game.time_class || !mappedControls.includes(game.time_class)) continue;
        }

        if (dateFrom) {
          const dateFromTimestamp = new Date(dateFrom.getTime());
          dateFromTimestamp.setHours(0, 0, 0, 0);
          if (game.end_time < dateFromTimestamp.getTime() / 1000) continue;
        }
        if (dateTo) {
          const dateToTimestamp = new Date(dateTo.getTime());
          dateToTimestamp.setHours(23, 59, 59, 999);
          if (game.end_time > dateToTimestamp.getTime() / 1000) continue;
        }

        if (playerColor) {
          const scoutedPlayerPlayedWhite = game.white.username.toLowerCase() === normalizedUsername;
          const scoutedPlayerColor = scoutedPlayerPlayedWhite ? "white" : "black";
          if (scoutedPlayerColor !== playerColor) continue;
        }

        const opponentRating = game.white.username.toLowerCase() === normalizedUsername
          ? game.black.rating
          : game.white.rating;
        if (opponentRating !== undefined && opponentRating !== null) {
          if (ratingMin && opponentRating < ratingMin) continue;
          if (ratingMax && opponentRating > ratingMax) continue;
        }

        if (opponentName) {
          const opponent = game.white.username.toLowerCase() === normalizedUsername
            ? game.black.username
            : game.white.username;
          if (!opponent.toLowerCase().includes(opponentName.toLowerCase())) continue;
        }

        const chessComGameId = game.url?.split('/').pop() || game.uuid;
        out.push({
          pgn: game.pgn,
          white: game.white.username.toLowerCase(),
          black: game.black.username.toLowerCase(),
          winner: game.white.result === "win" ? "white" : game.black.result === "win" ? "black" : undefined,
          timeControl: game.time_class,
          gameId: chessComGameId,
        });
      }
      return out;
    };

    let batchBuffer: GameData[] = [];
    const emit = (gd: GameData) => {
      allGames.push(gd);
      count++;
      batchBuffer.push(gd);
      if (onProgress) onProgress(count);
      if ((count === 1 || batchBuffer.length >= 5) && onBatch) {
        onBatch([...batchBuffer]);
        batchBuffer = [];
      }
    };

    // Fetch archives in parallel waves. Chess.com's archive API is CDN-cached and
    // tolerates concurrency well (measured ~8x faster than the old sequential +
    // 300ms-delay loop). We stop as soon as the budget/deadline/cap is reached.
    const POOL = 6;
    for (let i = 0; i < recentArchives.length; i += POOL) {
      if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
      if (count >= MAX_GAMES || budgetExhausted(budget)) break;

      const wave = recentArchives.slice(i, i + POOL);
      const datas = await Promise.all(
        wave.map((url) =>
          fetch(url, {
            headers: { "User-Agent": "ScoutTree/1.0 (contact: support@scouttree.com)" },
            signal,
          })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
        )
      );

      for (const data of datas) {
        if (!data?.games || !Array.isArray(data.games)) continue;
        if (budget) budget.rawFetched += data.games.length;
        const filtered = filterArchiveGames(data.games);
        for (const gd of filtered) {
          emit(gd);
          if (count >= MAX_GAMES) break;
        }
      }
    }

    if (batchBuffer.length > 0 && onBatch) {
      onBatch([...batchBuffer]);
      batchBuffer = [];
    }

    console.log(`[CHESS.COM] FINAL: ${allGames.length} games after filtering`);
    
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
