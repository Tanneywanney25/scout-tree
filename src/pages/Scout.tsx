import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Search, Upload, Loader2, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { fetchLichessGames, fetchChessComGames } from "@/lib/chessApi";
import { analyzeGames, serializeOpeningTree, createEmptyAnalysis, analyzeGamesIncremental, type AnalysisResult } from "@/lib/chessAnalysis";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const Scout = () => {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [platform, setPlatform] = useState("lichess");
  const [color, setColor] = useState<"white" | "black">("white");
  const [variant, setVariant] = useState("standard");
  const [timeControls, setTimeControls] = useState<string[]>(["ultrabullet", "bullet", "blitz", "rapid", "classical", "correspondence"]);
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
  const abortControllerRef = useRef<AbortController | null>(null);

  const toggleTimeControl = (tc: string) => {
    setTimeControls(prev => 
      prev.includes(tc) 
        ? prev.filter(t => t !== tc)
        : [...prev, tc]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!username.trim()) {
      toast.error("Please enter a username");
      return;
    }

    // Prevent multiple simultaneous requests
    if (loading) {
      toast.error("Analysis already in progress. Please wait.");
      return;
    }

    // Cancel any previous request and wait for cleanup
    if (abortControllerRef.current) {
      console.log('Aborting previous request...');
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      
      // CRITICAL: Wait for Lichess to process the abort before starting new request
      await new Promise(resolve => setTimeout(resolve, 2000));
      toast.info("Starting new analysis...");
    }

    // Create new abort controller for this request
    abortControllerRef.current = new AbortController();

    setLoading(true);
    setProgress(null);
    setWarning(null);
    setCurrentAnalysis(null);

    try {
      const timeControlKey = timeControls.sort().join(",");
      // Build cache key with proper handling of undefined values
      const cacheKey = `scout_${username}_${platform}_${variant}_${timeControlKey}_${color}_${mode}_${dateFrom?.getTime() || 'all'}_${dateTo?.getTime() || 'now'}_${ratingMin || 'any'}_${ratingMax || 'any'}_${opponentName || 'all'}`;
      
      // CLEAR ALL CACHES - force fresh analysis every time
      console.log('🧹 Clearing all localStorage caches...');
      const allKeys = Object.keys(localStorage);
      allKeys.forEach(key => {
        if (key.startsWith('scout_') || key.startsWith('abort_')) {
          localStorage.removeItem(key);
          console.log(`Cleared: ${key}`);
        }
      });
      
      const loadingToast = toast.loading("Fetching and analyzing games...");

      const actualPlatform = platform === "auto" ? "lichess" : platform;
      let analysis = createEmptyAnalysis(color);
      
      // Build options object with all filters
      const fetchOptions = {
        variant,
        timeControls,
        mode,
        dateFrom,
        dateTo,
        ratingMin: ratingMin ? parseInt(ratingMin) : undefined,
        ratingMax: ratingMax ? parseInt(ratingMax) : undefined,
        opponentName: opponentName || undefined
      };
      
      toast.dismiss(loadingToast);
      const progressToast = toast.loading("Fetching games...", { duration: Infinity });
      
      if (actualPlatform === "lichess") {
        await fetchLichessGames(
          username,
          fetchOptions,
          (count) => {
            setProgress(count);
            toast.loading(`Fetched ${count} games...`, { id: progressToast, duration: Infinity });
            
            if (count > 2000 && !warning) {
              setWarning("Large dataset - processing all games...");
            }
          },
          (gameBatch) => {
            try {
              analysis = analyzeGamesIncremental(analysis, gameBatch, username);
              setCurrentAnalysis(analysis);
              toast.loading(`Analyzing ${analysis.totalGames} games...`, { id: progressToast, duration: Infinity });
            } catch (error) {
              console.error('Error processing game batch:', error);
            }
          },
          abortControllerRef.current?.signal
        );
        
        toast.dismiss(progressToast);
      } else {
        await fetchChessComGames(
          username,
          fetchOptions,
          (count) => {
            setProgress(count);
            toast.loading(`Fetched ${count} games...`, { id: progressToast, duration: Infinity });
          },
          (gameBatch) => {
            try {
              analysis = analyzeGamesIncremental(analysis, gameBatch, username);
              setCurrentAnalysis(analysis);
              toast.loading(`Analyzing ${analysis.totalGames} games...`, { id: progressToast, duration: Infinity });
            } catch (error) {
              console.error('Error processing game batch:', error);
            }
          }
        );
        
        toast.dismiss(progressToast);
      }

      if (analysis.totalGames === 0) {
        toast.error("No games found for this user");
        setLoading(false);
        return;
      }

      toast.success(`Analysis complete! Analyzed ${analysis.totalGames} games.`);
      
      // Navigate to report with final data
      const finalReportData = {
        ...analysis,
        openingTree: serializeOpeningTree(analysis.openingTree),
      };
      
      navigate(`/report/${username}`, { 
        state: finalReportData
      });
    } catch (error: any) {
      console.error("Scout error:", error);
      toast.dismiss(); // Dismiss all toasts including the loading one
      
      // Ignore abort errors (user cancelled)
      if (error.name === 'AbortError') {
        toast.info("Analysis cancelled");
        return;
      }
      
      // Show specific error message for rate limiting
      if (error.message?.includes('429') || error.message?.includes('rate limit')) {
        toast.error("Rate limit exceeded. Lichess allows only 1 request at a time. Please wait 20 seconds before trying again.", {
          duration: 6000
        });
      } else {
        toast.error(error.message || "Failed to generate report. Try again.");
      }
    } finally {
      // Clear abort controller reference
      if (abortControllerRef.current) {
        abortControllerRef.current = null;
      }
      setLoading(false);
      setProgress(null);
      setWarning(null);
      setCurrentAnalysis(null);
    }
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
                Provide the opponent's username or upload a PGN file
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
                  <Label>Your Color</Label>
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

                <div className="space-y-2">
                  <Label>Time Controls</Label>
                  <div className="grid grid-cols-2 gap-3">
                    {["ultrabullet", "bullet", "blitz", "rapid", "classical", "correspondence"].map(tc => (
                      <div key={tc} className="flex items-center space-x-2">
                        <Checkbox 
                          id={tc}
                          checked={timeControls.includes(tc)}
                          onCheckedChange={() => toggleTimeControl(tc)}
                        />
                        <Label htmlFor={tc} className="font-normal cursor-pointer capitalize">
                          {tc}
                        </Label>
                      </div>
                    ))}
                  </div>
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
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button variant="outline" className={cn("justify-start text-left font-normal", !dateFrom && "text-muted-foreground")}>
                              <CalendarIcon className="mr-2 h-4 w-4" />
                              {dateFrom ? format(dateFrom, "PPP") : "From: Forever"}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0" align="start">
                            <Calendar mode="single" selected={dateFrom} onSelect={setDateFrom} initialFocus className="pointer-events-auto" />
                          </PopoverContent>
                        </Popover>

                        <Popover>
                          <PopoverTrigger asChild>
                            <Button variant="outline" className={cn("justify-start text-left font-normal", !dateTo && "text-muted-foreground")}>
                              <CalendarIcon className="mr-2 h-4 w-4" />
                              {dateTo ? format(dateTo, "PPP") : "To: Now"}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0" align="start">
                            <Calendar mode="single" selected={dateTo} onSelect={setDateTo} initialFocus className="pointer-events-auto" />
                          </PopoverContent>
                        </Popover>
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

                {progress !== null && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">
                        {currentAnalysis ? 'Analyzing games...' : 'Fetching games...'}
                      </span>
                      <span className="font-medium">{progress} games</span>
                    </div>
                    <Progress value={100} className="h-2" />
                    
                    {currentAnalysis && currentAnalysis.totalGames > 0 && (
                      <div className="text-xs text-muted-foreground space-y-1">
                        <div>✓ {currentAnalysis.totalGames} games analyzed</div>
                        {currentAnalysis.openingTree.children.size > 0 && (
                          <div>✓ {currentAnalysis.openingTree.children.size} opening moves found</div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {warning && (
                  <div className="rounded-md bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 p-3">
                    <p className="text-sm text-amber-800 dark:text-amber-200">{warning}</p>
                  </div>
                )}

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
              </form>

              <div className="mt-6 pt-6 border-t border-border">
                <Button variant="outline" className="w-full">
                  <Upload className="mr-2 w-4 h-4" />
                  Upload PGN File Instead
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
};

export default Scout;
