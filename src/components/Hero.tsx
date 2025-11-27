import { Button } from "@/components/ui/button";
import { ArrowRight, Target, Zap, Shield } from "lucide-react";
import { Link } from "react-router-dom";

const Hero = () => {
  return (
    <section className="relative py-20 md:py-32 overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-background to-background -z-10" />
      
      <div className="container mx-auto px-4">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20">
            <Zap className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium text-foreground">AI-Powered Chess Intelligence</span>
          </div>
          
          {/* Headline */}
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-foreground">
            Know Your Opponent
            <span className="block text-primary mt-2">Before The Game Starts</span>
          </h1>
          
          {/* Subheadline */}
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Enter a username. Get a complete opponent profile, opening prep plan, and pregame checklist in under 60 seconds.
          </p>
          
          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
            <Button asChild size="lg" className="bg-primary hover:bg-primary-dark text-primary-foreground">
              <Link to="/scout">
                Scout an Opponent <ArrowRight className="ml-2 w-4 h-4" />
              </Link>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <Link to="/demo">View Demo Report</Link>
            </Button>
          </div>
          
          {/* Feature highlights */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-12 max-w-3xl mx-auto">
            <div className="flex flex-col items-center text-center space-y-2">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
                <Target className="w-6 h-6 text-primary" />
              </div>
              <h3 className="font-semibold text-foreground">Opening Weaknesses</h3>
              <p className="text-sm text-muted-foreground">Identify exploitable patterns in their repertoire</p>
            </div>
            
            <div className="flex flex-col items-center text-center space-y-2">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
                <Zap className="w-6 h-6 text-primary" />
              </div>
              <h3 className="font-semibold text-foreground">Time Pressure Habits</h3>
              <p className="text-sm text-muted-foreground">Discover how they play when the clock is ticking</p>
            </div>
            
            <div className="flex flex-col items-center text-center space-y-2">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
                <Shield className="w-6 h-6 text-primary" />
              </div>
              <h3 className="font-semibold text-foreground">Pregame Checklist</h3>
              <p className="text-sm text-muted-foreground">One-minute review before the game begins</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Hero;
