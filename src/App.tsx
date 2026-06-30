import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import Landing from "./pages/Landing";
import Scout from "./pages/Scout";
import Report from "./pages/Report";
import OpeningTree from "./pages/OpeningTree";
import Auth from "./pages/Auth";
import AuthCallback from "./pages/AuthCallback";
import Training from "./pages/Training";
import Onboarding from "./pages/Onboarding";
import Settings from "./pages/Settings";
import MyScouts from "./pages/MyScouts";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/scout" element={<Scout />} />
            <Route path="/report/:id" element={<Report />} />
            <Route path="/demo" element={<Report />} />
            <Route path="/pricing" element={<Landing />} />
            <Route path="/opening-tree" element={<OpeningTree />} />
            <Route path="/auth" element={<Auth />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/onboarding" element={<Onboarding />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/scouts" element={<MyScouts />} />
            <Route path="/training" element={<Training />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
