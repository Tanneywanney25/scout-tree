import React from 'react';
import Header from '@/components/Header';
import { TrainingDashboard } from '@/components/TrainingDashboard';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { LogIn } from 'lucide-react';

export default function Training() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <main className="container mx-auto px-4 py-8">
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        </main>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <main className="container mx-auto px-4 py-8">
          <div className="max-w-md mx-auto text-center py-12">
            <h1 className="text-2xl font-bold mb-4">Training Drills</h1>
            <p className="text-muted-foreground mb-6">
              Sign in to access personalized training drills based on your weakness analysis.
            </p>
            <Button onClick={() => navigate('/auth')}>
              <LogIn className="h-4 w-4 mr-2" />
              Sign In
            </Button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="container mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Training Drills</h1>
          <p className="text-muted-foreground">
            Practice positions where you or your opponents made mistakes
          </p>
        </div>
        <TrainingDashboard />
      </main>
    </div>
  );
}
