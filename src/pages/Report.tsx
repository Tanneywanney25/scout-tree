import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Download, Copy, ChevronRight, AlertCircle } from "lucide-react";
import { toast } from "sonner";

const Report = () => {
  const mockReport = {
    username: "demo_player",
    platform: "Lichess",
    rating: 2150,
    gamesAnalyzed: 247,
    summary: "Demo_player is a solid tactical player who favors the King's Indian Defense as Black. Shows strong attacking instincts but occasionally overextends in the middlegame. Time management is a weakness in blitz games - blunder rate increases significantly under 30 seconds.",
    
    weaknesses: [
      {
        title: "Time Pressure Blunders",
        confidence: "high",
        description: "Blunder rate increases by 340% when under 30 seconds",
        evidence: "32 of 85 blitz losses occurred with <20s on clock"
      },
      {
        title: "Endgame Conversion",
        confidence: "medium", 
        description: "Struggles to convert winning rook endgames (+2 advantage)",
        evidence: "Drew/lost 8 of 15 favorable rook endgames"
      },
      {
        title: "Queen's Gambit Declined",
        confidence: "high",
        description: "Limited experience defending QGD structures",
        evidence: "Only 12 games, 33% win rate vs 54% overall"
      }
    ],

    recommendations: [
      {
        title: "Exploit Time Pressure",
        line: "1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6",
        description: "Play the Najdorf to create complex positions that burn clock",
        successRate: "68%"
      },
      {
        title: "Enter Rook Endgames",
        line: "1.d4 Nf6 2.c4 g6 3.Nc3 Bg7 4.e4 d6 5.Nf3 O-O",
        description: "Trade pieces to reach rook endgames where conversion is weak",
        successRate: "61%"
      }
    ],

    pregameChecklist: [
      "They struggle under time pressure - aim for complex middlegames",
      "Weak in rook endgames - simplify when ahead",
      "Limited QGD experience - consider 1.d4 approach",
      "Strong King's Indian player - avoid if playing 1.d4",
      "Takes 2-3 seconds per move in opening - stay in prep to maintain tempo"
    ]
  };

  const getConfidenceBadge = (level: string) => {
    const variants: Record<string, string> = {
      high: "bg-confidence-high text-white",
      medium: "bg-confidence-medium text-white", 
      low: "bg-confidence-low text-white"
    };
    return variants[level] || variants.low;
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  const handleDownload = () => {
    toast.success("Report downloaded");
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />
      
      <main className="flex-1 py-8">
        <div className="container mx-auto px-4 max-w-6xl">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-3xl font-bold text-foreground mb-2">
                Scout Report: {mockReport.username}
              </h1>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span>{mockReport.platform}</span>
                <span>•</span>
                <span>Rating: {mockReport.rating}</span>
                <span>•</span>
                <span>{mockReport.gamesAnalyzed} games analyzed</span>
              </div>
            </div>
            <Button onClick={handleDownload} variant="outline">
              <Download className="mr-2 w-4 h-4" />
              Download JSON
            </Button>
          </div>

          <div className="grid lg:grid-cols-3 gap-6">
            {/* Left Column: Summary & Checklist */}
            <div className="lg:col-span-1 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>60-Second Summary</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-foreground leading-relaxed">
                    {mockReport.summary}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Pregame Checklist</CardTitle>
                  <CardDescription>Review before the game starts</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-3">
                    {mockReport.pregameChecklist.map((item, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <ChevronRight className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                        <span className="text-foreground">{item}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </div>

            {/* Right Column: Detailed Analysis */}
            <div className="lg:col-span-2 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Key Weaknesses</CardTitle>
                  <CardDescription>Exploitable patterns found in their games</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {mockReport.weaknesses.map((weakness, i) => (
                    <div key={i} className="border border-border rounded-lg p-4">
                      <div className="flex items-start justify-between mb-2">
                        <h4 className="font-semibold text-foreground">{weakness.title}</h4>
                        <Badge className={getConfidenceBadge(weakness.confidence)}>
                          {weakness.confidence}
                        </Badge>
                      </div>
                      <p className="text-sm text-foreground mb-2">{weakness.description}</p>
                      <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/50 p-2 rounded">
                        <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                        <span>{weakness.evidence}</span>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Recommended Lines</CardTitle>
                  <CardDescription>Opening strategies to exploit weaknesses</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {mockReport.recommendations.map((rec, i) => (
                    <div key={i} className="border border-border rounded-lg p-4">
                      <div className="flex items-start justify-between mb-2">
                        <h4 className="font-semibold text-foreground">{rec.title}</h4>
                        <Badge variant="secondary">
                          {rec.successRate} success
                        </Badge>
                      </div>
                      <div className="bg-muted/50 p-3 rounded mb-2 flex items-center justify-between group">
                        <code className="text-sm font-mono text-foreground">{rec.line}</code>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="opacity-0 group-hover:opacity-100"
                          onClick={() => handleCopy(rec.line)}
                        >
                          <Copy className="w-3 h-3" />
                        </Button>
                      </div>
                      <p className="text-sm text-muted-foreground">{rec.description}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Training Drill</CardTitle>
                  <CardDescription>3 positions to practice before your game</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="bg-muted/30 border border-border rounded-lg p-8 text-center">
                    <p className="text-sm text-muted-foreground">
                      Training positions would appear here
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Report;
