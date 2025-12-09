import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { 
  fetchDuePositions, 
  fetchAllTrainingPositions, 
  getTrainingStats,
  TrainingPosition 
} from '@/lib/trainingGeneration';
import { TrainingMode } from './TrainingMode';
import { 
  Brain, 
  Calendar, 
  Star, 
  TrendingUp,
  Play,
  BarChart3
} from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';

const CHART_COLORS = ['hsl(var(--primary))', '#22c55e', '#eab308', '#ef4444', '#8b5cf6', '#06b6d4'];

const categoryLabels: Record<string, string> = {
  hanging_material: 'Hanging Material',
  missed_tactics: 'Missed Tactics',
  pawn_structure: 'Pawn Structure',
  bad_exchange: 'Bad Exchange',
  time_pressure: 'Time Pressure',
  positional: 'Positional',
  endgame: 'Endgame',
  opening: 'Opening',
  calculation: 'Calculation',
  other: 'Other'
};

export function TrainingDashboard() {
  const [isTraining, setIsTraining] = useState(false);
  const [duePositions, setDuePositions] = useState<TrainingPosition[]>([]);
  const [allPositions, setAllPositions] = useState<TrainingPosition[]>([]);
  const [stats, setStats] = useState<{
    total: number;
    dueToday: number;
    masteryDistribution: number[];
    weaknessBreakdown: Record<string, number>;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const [due, all, statsData] = await Promise.all([
        fetchDuePositions(20),
        fetchAllTrainingPositions(),
        getTrainingStats()
      ]);
      setDuePositions(due);
      setAllPositions(all);
      setStats(statsData);
    } catch (e) {
      console.error('Error loading training data:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleTrainingComplete = () => {
    setIsTraining(false);
    loadData(); // Refresh stats after training
  };

  if (isTraining && duePositions.length > 0) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setIsTraining(false)}>
          ← Back to Dashboard
        </Button>
        <TrainingMode 
          positions={duePositions} 
          onComplete={handleTrainingComplete}
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  // Prepare chart data
  const weaknessChartData = stats?.weaknessBreakdown 
    ? Object.entries(stats.weaknessBreakdown).map(([category, count]) => ({
        name: categoryLabels[category] || category,
        value: count
      }))
    : [];

  const masteryChartData = stats?.masteryDistribution
    ? stats.masteryDistribution.map((count, level) => ({
        name: `${level} Stars`,
        value: count
      })).filter(d => d.value > 0)
    : [];

  const averageMastery = stats && stats.total > 0
    ? stats.masteryDistribution.reduce((sum, count, level) => sum + count * level, 0) / stats.total
    : 0;

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-primary" />
              <div>
                <div className="text-2xl font-bold">{stats?.total || 0}</div>
                <div className="text-xs text-muted-foreground">Total Positions</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Calendar className="h-5 w-5 text-orange-500" />
              <div>
                <div className="text-2xl font-bold">{stats?.dueToday || 0}</div>
                <div className="text-xs text-muted-foreground">Due Today</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Star className="h-5 w-5 text-yellow-500" />
              <div>
                <div className="text-2xl font-bold">{averageMastery.toFixed(1)}</div>
                <div className="text-xs text-muted-foreground">Avg Mastery</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-green-500" />
              <div>
                <div className="text-2xl font-bold">
                  {stats?.masteryDistribution?.[5] || 0}
                </div>
                <div className="text-xs text-muted-foreground">Mastered (5★)</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Start Training CTA */}
      {stats && stats.dueToday > 0 && (
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold">Ready to Practice?</h3>
                <p className="text-muted-foreground">
                  You have {stats.dueToday} position{stats.dueToday !== 1 ? 's' : ''} due for review
                </p>
              </div>
              <Button onClick={() => setIsTraining(true)} size="lg">
                <Play className="h-4 w-4 mr-2" />
                Start Training
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {stats?.total === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <Brain className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Training Positions Yet</h3>
            <p className="text-muted-foreground mb-4">
              Run a weakness analysis on your games to generate personalized training drills.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Charts */}
      {stats && stats.total > 0 && (
        <div className="grid md:grid-cols-2 gap-6">
          {/* Weakness Distribution */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="h-4 w-4" />
                Weakness Categories
              </CardTitle>
            </CardHeader>
            <CardContent>
              {weaknessChartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={weaknessChartData}
                      cx="50%"
                      cy="50%"
                      innerRadius={40}
                      outerRadius={80}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {weaknessChartData.map((_, index) => (
                        <Cell 
                          key={`cell-${index}`} 
                          fill={CHART_COLORS[index % CHART_COLORS.length]} 
                        />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[200px] flex items-center justify-center text-muted-foreground">
                  No data yet
                </div>
              )}
            </CardContent>
          </Card>

          {/* Mastery Distribution */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Star className="h-4 w-4" />
                Mastery Levels
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {stats.masteryDistribution.map((count, level) => {
                  const percentage = stats.total > 0 ? (count / stats.total) * 100 : 0;
                  return (
                    <div key={level} className="space-y-1">
                      <div className="flex justify-between text-sm">
                        <span className="flex items-center gap-1">
                          {Array.from({ length: level }).map((_, i) => (
                            <Star key={i} className="h-3 w-3 fill-yellow-500 text-yellow-500" />
                          ))}
                          {level === 0 && <span className="text-muted-foreground">Not started</span>}
                        </span>
                        <span>{count}</span>
                      </div>
                      <Progress value={percentage} className="h-2" />
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Recent Positions */}
      {allPositions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Training Positions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {allPositions.slice(0, 5).map((position) => (
                <div 
                  key={position.id} 
                  className="flex items-center justify-between py-2 border-b last:border-0"
                >
                  <div className="flex items-center gap-3">
                    <Badge variant="outline">
                      {categoryLabels[position.weakness_category] || position.weakness_category}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      {position.game_context}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star 
                          key={i} 
                          className={`h-3 w-3 ${
                            i < position.mastery_level 
                              ? 'fill-yellow-500 text-yellow-500' 
                              : 'text-muted'
                          }`} 
                        />
                      ))}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {position.times_correct}/{position.times_attempted}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
