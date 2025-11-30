import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Crown, LogOut } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

const Header = () => {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleAuthClick = () => {
    if (user) {
      signOut();
    } else {
      navigate("/auth");
    }
  };

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
          {user && (
            <span className="hidden sm:inline text-sm text-muted-foreground">
              {user.email}
            </span>
          )}
          <Button
            variant={user ? "ghost" : "default"}
            size="sm"
            onClick={handleAuthClick}
            className={user ? "" : "bg-primary hover:bg-primary-dark text-primary-foreground"}
          >
            {user ? (
              <>
                <LogOut className="w-4 h-4 mr-2" />
                Sign Out
              </>
            ) : (
              "Get Started"
            )}
          </Button>
        </div>
      </div>
    </header>
  );
};

export default Header;
