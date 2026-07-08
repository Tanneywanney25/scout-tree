import Header from "@/components/Header";
import Hero from "@/components/Hero";
import PlatformLogos from "@/components/PlatformLogos";
// import PricingSection from "@/components/PricingSection";

const Landing = () => {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <Hero />
        <PlatformLogos />
        {/* <PricingSection /> */}
      </main>
      <footer className="border-t border-border py-8">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          <p>© 2025 ScoutTree. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
