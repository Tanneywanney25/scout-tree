import { useState, useRef, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Search, Upload, Loader2, ChevronDown, StopCircle, ArrowRight, RefreshCw, History } from "lucide-react";

// Filter snapshot interface for tracking filter changes
interface FilterSnapshot {
  username: string;
  platform: string;
  color: "white" | "black";
  variant: string;
  timeControls: string[];
  mode: "all" | "rated" | "casual";
  dateFrom: Date | undefined;
  dateTo: Date | undefined;
  ratingMin: string;
  ratingMax: string;
  opponentName: string;
}
import { toast } from "sonner";
import { fetchLichessGames, fetchChessComGames, type GameData } from "@/lib/chessApi";
import { analyzeGames, serializeOpeningTree, createEmptyAnalysis, analyzeGamesIncremental, type AnalysisResult } from "@/lib/chessAnalysis";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DateInput } from "@/components/ui/date-input";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { getBrowserFingerprint } from "@/lib/fingerprint";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { InteractiveOpeningTree } from "@/components/InteractiveOpeningTree";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const Scout = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [username, setUsername] = useState("");
  const [platform, setPlatform] = useState("lichess");
  const [color, setColor] = useState<"white" | "black">("white");
  const [variant, setVariant] = useState("standard");
  
  // Platform-specific time controls
  const lichessTimeControls = ["ultrabullet", "bullet", "blitz", "rapid", "classical", "correspondence"];
  const chesscomTimeControls = ["bullet", "blitz", "rapid", "daily"];
  
  const [timeControls, setTimeControls] = useState<string[]>(lichessTimeControls);
  const [mode, setMode] = useState<"all" | "rated" | "casual">("all");
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(new Date());
  const [ratingMin, setRatingMin] = useState<string>("");
  const [ratingMax, setRatingMax] = useState<string>("");
  const [opponentName, setOpponentName] = useState<string>("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [currentAnalysis, setCurrentAnalysis] = useState<AnalysisResult | null>(null);
  const [isAnalysisComplete, setIsAnalysisComplete] = useState(false);
  const [finalGameCount, setFinalGameCount] = useState<number>(0);
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const [currentBoardPath, setCurrentBoardPath] = useState<string[]>([]);
  const [collectedGames, setCollectedGames] = useState<GameData[]>([]); // Store games for deep analysis
  const abortControllerRef = useRef<AbortController | null>(null);
  const progressRef = useRef<number>(0); // Track accurate game count imperatively
  const collectedGamesRef = useRef<GameData[]>([]); // Ref for collecting games during streaming
  const currentAnalysisRef = useRef<AnalysisResult | null>(null); // Ref to access current analysis in abort handler
  const analysisRef = useRef<AnalysisResult | null>(null); // Synchronously updated ref for abort handler
  
  // Filter change detection state
  const [baselineFilters, setBaselineFilters] = useState<FilterSnapshot | null>(null);
  
  // Previous report state (preserved when new analysis starts)
  const [previousAnalysis, setPreviousAnalysis] = useState<AnalysisResult | null>(null);
  const [previousFinalGameCount, setPreviousFinalGameCount] = useState<number>(0);
  const [previousBoardPath, setPreviousBoardPath] = useState<string[]>([]);
  const [previousUsername, setPreviousUsername] = useState<string>("");
  
  // Get available time controls based on platform
  const availableTimeControls = platform === "chesscom" ? chesscomTimeControls : lichessTimeControls;

  // Current filters as a snapshot for comparison
  const currentFilters: FilterSnapshot = useMemo(() => ({
    username,
    platform,
    color,
    variant,
    timeControls,
    mode,
    dateFrom,
    dateTo,
    ratingMin,
    ratingMax,
    opponentName
  }), [username, platform, color, variant, timeControls, mode, dateFrom, dateTo, ratingMin, ratingMax, opponentName]);

  // Detect if filters have changed from baseline
  const filtersChanged = useMemo(() => {
    if (!baselineFilters) return false;
    
    return (
      baselineFilters.username !== currentFilters.username ||
      baselineFilters.platform !== currentFilters.platform ||
      baselineFilters.color !== currentFilters.color ||
      baselineFilters.variant !== currentFilters.variant ||
      JSON.stringify(baselineFilters.timeControls.slice().sort()) !== JSON.stringify(currentFilters.timeControls.slice().sort()) ||
      baselineFilters.mode !== currentFilters.mode ||
      baselineFilters.dateFrom?.getTime() !== currentFilters.dateFrom?.getTime() ||
      baselineFilters.dateTo?.getTime() !== currentFilters.dateTo?.getTime() ||
      baselineFilters.ratingMin !== currentFilters.ratingMin ||
      baselineFilters.ratingMax !== currentFilters.ratingMax ||
      baselineFilters.opponentName !== currentFilters.opponentName
    );
  }, [baselineFilters, currentFilters]);

  const toggleTimeControl = (tc: string) => {
    setTimeControls(prev => 
      prev.includes(tc) 
        ? prev.filter(t => t !== tc)
        : [...prev, tc]
    );
  };

  // Reset time controls when platform changes
  useEffect(() => {
    const controls = platform === "chesscom" ? chesscomTimeControls : lichessTimeControls;
    setTimeControls(controls);
  }, [platform]);

  // Keep currentAnalysisRef in sync with state to avoid stale closure in abort handler
  useEffect(() => {
    currentAnalysisRef.current = currentAnalysis;
  }, [currentAnalysis]);

  // Cleanup: abort any running analysis when component unmounts
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  // Clean up stale pending params on mount (older than 10 minutes)
  useEffect(() => {
    const pendingParams = sessionStorage.getItem('pendingScoutParams');
    if (pendingParams) {
      try {
        const params = JSON.parse(pendingParams);
        if (Date.now() - params.timestamp > 600000) {
          sessionStorage.removeItem('pendingScoutParams');
        }
      } catch {
        sessionStorage.removeItem('pendingScoutParams');
      }
    }
  }, []);

  // Restore and auto-submit after successful auth
  useEffect(() => {
    if (user && !loading) {
      const pendingParams = sessionStorage.getItem('pendingScoutParams');
      if (pendingParams) {
        try {
          const params = JSON.parse(pendingParams);
          
          // Check if params are recent (within last 10 minutes)
          if (Date.now() - params.timestamp < 600000) {
            // Restore form state
            setPlatform(params.platform);
            setUsername(params.username);
            setColor(params.color);
            setVariant(params.variant);
            setTimeControls(params.timeControls);
            setMode(params.mode);
            setDateFrom(params.dateFrom ? new Date(params.dateFrom) : undefined);
            setDateTo(params.dateTo ? new Date(params.dateTo) : undefined);
            setRatingMin(params.ratingMin);
            setRatingMax(params.ratingMax);
            setOpponentName(params.opponentName);
            
            // Clear from storage
            sessionStorage.removeItem('pendingScoutParams');
            
            toast.success('Continuing your scout with saved parameters');
            
            // Auto-submit after brief delay to let state settle
            setTimeout(() => {
              const fakeEvent = { preventDefault: () => {} } as React.FormEvent;
              handleSubmit(fakeEvent, false);
            }, 500);
          } else {
            sessionStorage.removeItem('pendingScoutParams');
          }
        } catch {
          sessionStorage.removeItem('pendingScoutParams');
        }
      }
    }
  }, [user, loading]);

  const checkUsageLimit = async (): Promise<boolean> => {
    // If user is logged in, allow unlimited scouts
    if (user) {
      return true;
    }

    // Check anonymous usage
    const fingerprint = getBrowserFingerprint();
    const { data, error } = await supabase
      .from('anonymous_scout_usage')
      .select('*')
      .eq('fingerprint', fingerprint)
      .maybeSingle();

    if (error) {
      console.error('Error checking usage:', error);
      toast.error("Error checking usage limit. Please try again.");
      return false; // Fail closed
    }

    // If fingerprint exists, they've used their free scout
    if (data) {
      return false;
    }

    return true;
  };

  const recordUsage = async () => {
    if (user) {
      // Record for logged-in user
      await supabase.from('scout_usage').insert({
        user_id: user.id,
        username,
        platform
      });
    } else {
      // Record anonymous usage
      const fingerprint = getBrowserFingerprint();
      await supabase.from('anonymous_scout_usage').insert({
        fingerprint
      });
    }
  };

  const handleSubmit = async (e: React.FormEvent, preservePrevious: boolean = false) => {
    const t0 = performance.now();
    console.log('[TIMING] Form submitted at', new Date().toISOString());
    
    e.preventDefault();
    
    if (!username.trim()) {
      toast.error("Please enter a username");
      return;
    }

    if (loading) {
      toast.error("Analysis already in progress. Please wait.");
      return;
    }

    // IMMEDIATE visual feedback - show loading state BEFORE any async operations
    setLoading(true);
    console.log('[TIMING] setLoading(true) at', (performance.now() - t0).toFixed(0), 'ms');
    
    // Force React to flush state updates so user sees the loading indicator
    await new Promise(r => setTimeout(r, 0));
    console.log('[TIMING] React flush at', (performance.now() - t0).toFixed(0), 'ms');
    
    const progressToast = toast.loading("Starting analysis...", { duration: Infinity });
    console.log('[TIMING] Toast shown at', (performance.now() - t0).toFixed(0), 'ms');

    // Check usage limit (fast for logged-in users)
    console.log('[TIMING] Starting usage check at', (performance.now() - t0).toFixed(0), 'ms');
    const canProceed = await checkUsageLimit();
    console.log('[TIMING] Usage check complete at', (performance.now() - t0).toFixed(0), 'ms');
    if (!canProceed) {
      // Save current form state to sessionStorage before showing auth modal
      sessionStorage.setItem('pendingScoutParams', JSON.stringify({
        platform,
        username,
        color,
        variant,
        timeControls,
        mode,
        dateFrom: dateFrom?.toISOString(),
        dateTo: dateTo?.toISOString(),
        ratingMin,
        ratingMax,
        opponentName,
        timestamp: Date.now()
      }));
      
      setLoading(false);
      toast.dismiss(progressToast);
      setShowAuthDialog(true);
      return;
    }

    // Preserve current report as previous if requested and a valid report exists
    if (preservePrevious && currentAnalysis && isAnalysisComplete && finalGameCount > 0) {
      setPreviousAnalysis(currentAnalysis);
      setPreviousFinalGameCount(finalGameCount);
      setPreviousBoardPath(currentBoardPath);
      setPreviousUsername(username);
    }

    if (abortControllerRef.current) {
      console.log('[TIMING] Aborting previous request at', (performance.now() - t0).toFixed(0), 'ms');
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      await new Promise(resolve => setTimeout(resolve, 50)); // Minimal delay for cleanup
      console.log('[TIMING] Abort complete at', (performance.now() - t0).toFixed(0), 'ms');
    }

    abortControllerRef.current = new AbortController();

    setProgress(null);
    setWarning(null);
    setCurrentAnalysis(null);
    setIsAnalysisComplete(false);
    progressRef.current = 0; // Reset progress ref
    console.log('[TIMING] State reset at', (performance.now() - t0).toFixed(0), 'ms');

    try {
      const actualPlatform = platform === "auto" ? "lichess" : platform;
      let analysis = createEmptyAnalysis(color);
      analysisRef.current = analysis; // Initialize synchronously
      
      const fetchOptions = {
        variant,
        timeControls,
        mode,
        dateFrom,
        dateTo,
        ratingMin: ratingMin ? parseInt(ratingMin) : undefined,
        ratingMax: ratingMax ? parseInt(ratingMax) : undefined,
        opponentName: opponentName || undefined,
        playerColor: color
      };
      
      console.log('[TIMING] Starting fetch at', (performance.now() - t0).toFixed(0), 'ms');
      console.log('[FETCH-CONFIG] Platform:', actualPlatform, 'User:', username, 'Color:', color);
      console.log('[FETCH-CONFIG] Filters:', JSON.stringify(fetchOptions, null, 2));

      toast.loading("Fetching games...", { id: progressToast, duration: Infinity });
      
      // Queue-based batch processing to prevent blocking stream reading
      const batchQueue: GameData[][] = [];
      let processingBatches = false;
      let lastAnalysisUpdate = 0;
      collectedGamesRef.current = []; // Reset game collection
      
      const processBatches = async () => {
        if (processingBatches) return;
        processingBatches = true;
        while (batchQueue.length > 0) {
          const batch = batchQueue.shift()!;
          try {
            // Collect games for deep analysis (max 50)
            if (collectedGamesRef.current.length < 50) {
              const remaining = 50 - collectedGamesRef.current.length;
              collectedGamesRef.current.push(...batch.slice(0, remaining));
            }
            
            analysis = await analyzeGamesIncremental(analysis, batch, username);
            analysisRef.current = analysis; // Update synchronously for abort handler
            // Throttle state updates to max 5 per second
            const now = performance.now();
            if (now - lastAnalysisUpdate > 200) {
              setCurrentAnalysis(analysis);
              lastAnalysisUpdate = now;
            }
          } catch (error) {
            console.error('Error processing game batch:', error);
          }
        }
        processingBatches = false;
      };
      
      if (actualPlatform === "lichess") {
        await fetchLichessGames(
          username,
          fetchOptions,
          (count) => {
            progressRef.current = count;
            setProgress(count);
            toast.loading(`Analyzing ${count} games...`, { id: progressToast, duration: Infinity });
            if (count > 2000 && !warning) {
              setWarning("Large dataset - processing all games...");
            }
          },
          (gameBatch) => {
            // Queue batch for processing - don't block stream
            batchQueue.push(gameBatch);
            processBatches(); // Fire and forget - no await
          },
          abortControllerRef.current?.signal
        );
        // Wait for any remaining batches to finish
        while (batchQueue.length > 0 || processingBatches) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        setCurrentAnalysis(analysis);
        toast.dismiss(progressToast);
      } else {
        await fetchChessComGames(
          username,
          fetchOptions,
          (count) => {
            progressRef.current = count;
            setProgress(count);
            toast.loading(`Analyzing ${count} games...`, { id: progressToast, duration: Infinity });
          },
          (gameBatch) => {
            // Queue batch for processing - don't block stream
            batchQueue.push(gameBatch);
            processBatches(); // Fire and forget - no await
          },
          abortControllerRef.current?.signal
        );
        // Wait for any remaining batches to finish
        while (batchQueue.length > 0 || processingBatches) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        setCurrentAnalysis(analysis);
        toast.dismiss(progressToast);
      }

      if (analysis.totalGames === 0) {
        toast.error("No games found for this user");
        return;
      }

      // Record usage in background - don't block the UI
      recordUsage().catch(err => console.error('[TIMING] Usage recording failed:', err));

      // Mark analysis as complete - use analysis.totalGames as the authoritative count
      // since it's incremented for every game actually added to the opening tree
      const finalCount = analysis.totalGames;
      console.log(`[SCOUT] Final count: progressRef=${progressRef.current}, analysis.totalGames=${analysis.totalGames}, using analysis.totalGames=${finalCount}`);
      setFinalGameCount(finalCount);
      setIsAnalysisComplete(true);
      
      // Store baseline filters for change detection
      setBaselineFilters({ ...currentFilters });
      
      // Save collected games for deep analysis
      setCollectedGames([...collectedGamesRef.current]);
      
      toast.success(`Analysis complete! Analyzed ${finalCount} games.`);
    } catch (error: any) {
      console.error("Scout error:", error);
      toast.dismiss();
      
      if (error.name === 'AbortError') {
        // Use synchronously-updated analysisRef (not throttled state ref)
        const analysisSnapshot = analysisRef.current;
        const gamesAnalyzed = analysisSnapshot?.totalGames || 0;
        const gamesProgress = progressRef.current || 0;
        
        // Use whichever count is higher (progress might be ahead of analysis)
        const stoppedCount = Math.max(gamesAnalyzed, gamesProgress);
        
        console.log(`[SCOUT] Analysis stopped. progressRef=${gamesProgress}, analysis.totalGames=${gamesAnalyzed}, using=${stoppedCount}`);
        
        if (stoppedCount > 0 && analysisSnapshot) {
          // CRITICAL: Preserve the analysis data - update state before marking complete
          setCurrentAnalysis(analysisSnapshot);
          setFinalGameCount(stoppedCount);
          setIsAnalysisComplete(true);
          
          // Store baseline filters for the stopped analysis
          setBaselineFilters({ ...currentFilters });
          
          // Save collected games so far
          setCollectedGames([...collectedGamesRef.current]);
          
          toast.success(`Analysis stopped. ${stoppedCount} games analyzed. View your partial report below.`);
        } else if (stoppedCount > 0) {
          // Have progress count but no analysis yet - create minimal analysis
          setFinalGameCount(stoppedCount);
          setIsAnalysisComplete(true);
          toast.success(`Analysis stopped. ${stoppedCount} games fetched.`);
        } else {
          // No games at all
          toast.info("Analysis stopped. No games were analyzed yet.");
        }
        return;
      }
      
      if (error.message?.includes('429') || error.message?.includes('rate limit')) {
        toast.error("Rate limit exceeded. Please wait before trying again.", { duration: 6000 });
      } else {
        toast.error(error.message || "Failed to generate report. Try again.");
      }
    } finally {
      if (abortControllerRef.current) {
        abortControllerRef.current = null;
      }
      setLoading(false);
      setProgress(null);
      setWarning(null);
      // Keep currentAnalysis so user can view the tree
    }
  };

  const handleStopAnalysis = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const handleNewScout = () => {
    // Reset all state
    setCurrentAnalysis(null);
    setIsAnalysisComplete(false);
    setFinalGameCount(0);
    setLoading(false);
    setProgress(null);
    setWarning(null);
    setUsername("");
    setColor("white");
    setTimeControls(platform === "chesscom" ? chesscomTimeControls : lichessTimeControls);
    setVariant("standard");
    setMode("all");
    setDateFrom(undefined);
    setDateTo(new Date());
    setRatingMin("");
    setRatingMax("");
    setOpponentName("");
    
    // Clear baseline and previous report
    setBaselineFilters(null);
    setPreviousAnalysis(null);
    setPreviousFinalGameCount(0);
    setPreviousBoardPath([]);
    setPreviousUsername("");
    
    // Clear session storage
    sessionStorage.removeItem('scoutAnalysis');
    
    toast.success("Ready for new scout");
  };

  const handleRegenerateWithNewFilters = (e: React.FormEvent) => {
    // Preserve current report and start new analysis
    handleSubmit(e, true);
  };

  const handleViewPreviousReport = () => {
    if (!previousAnalysis) return;
    
    const serializedAnalysis = {
      playerColor: previousAnalysis.playerColor,
      totalGames: previousAnalysis.totalGames,
      openingTree: serializeOpeningTree(previousAnalysis.openingTree),
      weakestLines: previousAnalysis.weakestLines,
      strongestLines: previousAnalysis.strongestLines,
      initialSelectedPath: previousBoardPath
    };
    
    sessionStorage.setItem('scoutAnalysis', JSON.stringify(serializedAnalysis));
    navigate(`/report/${previousUsername}`);
  };

  const handleViewFullReport = () => {
    if (!currentAnalysis) return;
    
    // Convert collected games to storable format - include opening for profiling!
    const storedGames = collectedGamesRef.current.map(g => ({
      pgn: g.pgn,
      white: g.white,
      black: g.black,
      result: g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '1/2-1/2',
      timeControl: g.timeControl,
      opening: g.opening, // Critical for opponent profiling!
      url: g.gameId ? `https://lichess.org/${g.gameId}` : undefined
    }));
    
    const serializedAnalysis = {
      playerColor: currentAnalysis.playerColor,
      totalGames: currentAnalysis.totalGames,
      openingTree: serializeOpeningTree(currentAnalysis.openingTree),
      weakestLines: currentAnalysis.weakestLines,
      strongestLines: currentAnalysis.strongestLines,
      initialSelectedPath: currentBoardPath,
      games: storedGames // Include games for deep analysis
    };
    
    sessionStorage.setItem('scoutAnalysis', JSON.stringify(serializedAnalysis));
    navigate(`/report/${username}`);
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />
      
      <main className="flex-1 py-12">
        <div className="container mx-auto px-4 max-w-2xl">
          <div className="text-center mb-8">
            <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-3">
              Scout an Opponent
            </h1>
            <p className="text-muted-foreground">
              Enter their username and we'll analyze their games to create a complete profile
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Player Information</CardTitle>
              <CardDescription>
                Provide the opponent's username to analyze their games
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    placeholder="e.g., magnuscarlsen"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="text-base"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="platform">Platform</Label>
                  <Select value={platform} onValueChange={setPlatform}>
                    <SelectTrigger id="platform">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="lichess">Lichess</SelectItem>
                      <SelectItem value="chesscom">Chess.com (may hit CORS)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Your Color (playing against opponent)</Label>
                  <p className="text-xs text-muted-foreground">Select the color you'll play. We'll analyze games where your opponent played the opposite color.</p>
                  <RadioGroup value={color} onValueChange={(v) => setColor(v as "white" | "black")}>
                    <div className="flex items-center space-x-4">
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="white" id="white" />
                        <Label htmlFor="white" className="font-normal cursor-pointer">White</Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="black" id="black" />
                        <Label htmlFor="black" className="font-normal cursor-pointer">Black</Label>
                      </div>
                    </div>
                  </RadioGroup>
                </div>

                <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                  <CollapsibleTrigger asChild>
                    <Button variant="outline" className="w-full flex items-center justify-between">
                      <span>Advanced Filters</span>
                      <ChevronDown className={cn("h-4 w-4 transition-transform", advancedOpen && "rotate-180")} />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-4 mt-4">
                    <div className="space-y-2">
                      <Label>Time Controls</Label>
                      <div className="grid grid-cols-2 gap-3">
                        {availableTimeControls.map(tc => (
                          <div key={tc} className="flex items-center space-x-2">
                            <Checkbox 
                              id={tc}
                              checked={timeControls.includes(tc)}
                              onCheckedChange={() => toggleTimeControl(tc)}
                            />
                            <Label htmlFor={tc} className="font-normal cursor-pointer capitalize">
                              {tc === "daily" ? "Daily" : tc}
                            </Label>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="variant-advanced">Chess Variant</Label>
                      <Select value={variant} onValueChange={setVariant}>
                        <SelectTrigger id="variant-advanced">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="standard">Standard rules</SelectItem>
                          <SelectItem value="crazyhouse">Crazyhouse</SelectItem>
                          <SelectItem value="threeCheck">Three check</SelectItem>
                          <SelectItem value="kingOfTheHill">King of the hill</SelectItem>
                          <SelectItem value="racingKings">Racing kings</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>Game Mode</Label>
                      <RadioGroup value={mode} onValueChange={(v) => setMode(v as "all" | "rated" | "casual")}>
                        <div className="flex flex-col space-y-2">
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="all" id="all" />
                            <Label htmlFor="all" className="font-normal cursor-pointer">Rated and Casual</Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="rated" id="rated" />
                            <Label htmlFor="rated" className="font-normal cursor-pointer">Rated Only</Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="casual" id="casual" />
                            <Label htmlFor="casual" className="font-normal cursor-pointer">Casual Only</Label>
                          </div>
                        </div>
                      </RadioGroup>
                    </div>

                    <div className="space-y-2">
                      <Label>Date Range</Label>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <DateInput
                            date={dateFrom}
                            onDateChange={setDateFrom}
                            placeholder="From: Forever"
                          />
                        </div>
                        <div>
                          <DateInput
                            date={dateTo}
                            onDateChange={setDateTo}
                            placeholder="To: Now"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Opponent Rating Range</Label>
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          placeholder="Min (any)"
                          type="number"
                          value={ratingMin}
                          onChange={(e) => setRatingMin(e.target.value)}
                        />
                        <Input
                          placeholder="Max (any)"
                          type="number"
                          value={ratingMax}
                          onChange={(e) => setRatingMax(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="opponentName">Opponent Name</Label>
                      <Input
                        id="opponentName"
                        placeholder="All opponents"
                        value={opponentName}
                        onChange={(e) => setOpponentName(e.target.value)}
                      />
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                {progress !== null && loading && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">
                        {currentAnalysis ? 'Analyzing games...' : 'Fetching games...'}
                      </span>
                      <span className="font-medium">{progress} games</span>
                    </div>
                    <Progress value={100} className="h-2" />
                    
                    {currentAnalysis && currentAnalysis.totalGames > 0 && (
                <div className="text-xs text-muted-foreground space-y-1">
                        <div>✓ {progress} games analyzed</div>
                        {currentAnalysis.openingTree.children && (
                          <div>✓ Opening tree being built...</div>
                        )}
                      </div>
                    )}

                    <Button 
                      type="button"
                      variant="destructive" 
                      onClick={handleStopAnalysis}
                      className="w-full"
                    >
                      <StopCircle className="mr-2 w-4 h-4" />
                      Stop Analysis
                    </Button>
                  </div>
                )}

                {warning && (
                  <div className="rounded-md bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 p-3">
                    <p className="text-sm text-amber-800 dark:text-amber-200">{warning}</p>
                  </div>
                )}

                {/* Show regenerate button when filters changed during loading */}
                {loading && filtersChanged && (
                  <div className="p-3 bg-amber-50 dark:bg-amber-900/30 rounded-md border border-amber-200 dark:border-amber-800">
                    <p className="text-sm text-amber-800 dark:text-amber-200 mb-2">
                      Filters have changed. Current analysis will continue.
                    </p>
                    <Button 
                      type="button"
                      onClick={handleRegenerateWithNewFilters}
                      className="w-full bg-orange-600 hover:bg-orange-700 text-white"
                    >
                      <RefreshCw className="mr-2 w-4 h-4" />
                      Start New Analysis with Updated Filters
                    </Button>
                  </div>
                )}

                {!isAnalysisComplete && !filtersChanged && (
                  <Button 
                    type="submit" 
                    disabled={loading}
                    className="w-full bg-primary hover:bg-primary-dark text-primary-foreground"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="mr-2 w-4 h-4 animate-spin" />
                        {progress ? `Analyzing ${progress} games...` : "Analyzing..."}
                      </>
                    ) : (
                      <>
                        <Search className="mr-2 w-4 h-4" />
                        Generate Scout Report
                      </>
                    )}
                  </Button>
                )}

                {isAnalysisComplete && currentAnalysis && finalGameCount > 0 && (
                  <div className="space-y-3">
                    {/* Show regenerate button if filters have changed */}
                    {filtersChanged && (
                      <Button 
                        type="button"
                        onClick={handleRegenerateWithNewFilters}
                        className="w-full bg-orange-600 hover:bg-orange-700 text-white"
                      >
                        <RefreshCw className="mr-2 w-4 h-4" />
                        Generate Scout Report with New Filters
                      </Button>
                    )}
                    
                    <Button 
                      type="button"
                      onClick={handleViewFullReport}
                      className="w-full bg-primary hover:bg-primary-dark text-primary-foreground"
                    >
                      <ArrowRight className="mr-2 w-4 h-4" />
                      {previousAnalysis ? `View Current Report (${finalGameCount} games)` : `View Full Report (${finalGameCount} games)`}
                    </Button>
                    
                    {/* Show previous report button if one exists */}
                    {previousAnalysis && previousFinalGameCount > 0 && (
                      <Button 
                        type="button"
                        onClick={handleViewPreviousReport}
                        variant="outline"
                        className="w-full"
                      >
                        <History className="mr-2 w-4 h-4" />
                        Previous Report ({previousFinalGameCount} games)
                      </Button>
                    )}
                    
                    <Button 
                      type="button"
                      onClick={handleNewScout}
                      variant="outline"
                      className="w-full"
                    >
                      New Scout
                    </Button>
                  </div>
                )}
              </form>
            </CardContent>
          </Card>

          {currentAnalysis && (progress || 0) >= 1 && (
            <Card className="mt-8">
              <CardHeader>
                <CardTitle>Opening Tree Preview</CardTitle>
                <CardDescription>
                  {isAnalysisComplete 
                    ? `Analysis complete - ${finalGameCount} games` 
                    : `Live preview - updating as more games are analyzed (${progress} games so far)`
                  }
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ErrorBoundary>
                  <InteractiveOpeningTree 
                    node={serializeOpeningTree(currentAnalysis.openingTree)}
                    playerColor={currentAnalysis.playerColor === "both" ? "white" : currentAnalysis.playerColor}
                    initialSelectedPath={currentBoardPath}
                    onPathChange={setCurrentBoardPath}
                  />
                </ErrorBoundary>
              </CardContent>
            </Card>
          )}
        </div>
      </main>

      <AlertDialog open={showAuthDialog} onOpenChange={setShowAuthDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Free Scout Used</AlertDialogTitle>
            <AlertDialogDescription>
              You've already used your 1 free scout report. Sign up to get unlimited opponent scouting and unlock all features!
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setShowAuthDialog(false)}>
              Cancel
            </Button>
            <Button onClick={() => navigate('/auth')}>
              Sign Up Now
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Scout;
