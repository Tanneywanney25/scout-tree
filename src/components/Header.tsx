import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Crown } from "lucide-react";

const Header = () => {
  return (
    <header className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
      <div className="container mx-auto px-4 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
            <Crown className="w-5 h-5 text-primary-foreground" />
          </div>
          <span className="text-xl font-bold text-foreground">ScoutTree</span>
        </Link>
        
        <nav className="hidden md:flex items-center gap-6">
          <Link to="/" className="text-sm font-medium text-muted-foreground hover:text-foreground">
            Home
          </Link>
          <Link to="/scout" className="text-sm font-medium text-muted-foreground hover:text-foreground">
            Scout
          </Link>
          <Link to="/pricing" className="text-sm font-medium text-muted-foreground hover:text-foreground">
            Pricing
          </Link>
        </nav>
        
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" className="hidden sm:inline-flex">
            Sign In
          </Button>
          <Button size="sm" className="bg-primary hover:bg-primary-dark text-primary-foreground">
            Get Started
          </Button>
        </div>
      </div>
    </header>
  );
};

export default Header;
