const PlatformLogos = () => {
  return (
    <section className="py-12 border-t border-border bg-muted/30">
      <div className="container mx-auto px-4">
        <p className="text-center text-sm text-muted-foreground mb-6">
          Supported Platforms
        </p>
        <div className="flex flex-wrap items-center justify-center gap-8 md:gap-12">
          <div className="flex items-center gap-2 text-foreground/70 hover:text-foreground transition-colors">
            <div className="w-8 h-8 rounded bg-foreground/10 flex items-center justify-center font-bold text-sm">
              L
            </div>
            <span className="font-semibold">Lichess</span>
          </div>
          <div className="flex items-center gap-2 text-foreground/70 hover:text-foreground transition-colors">
            <div className="w-8 h-8 rounded bg-foreground/10 flex items-center justify-center font-bold text-sm">
              C
            </div>
            <span className="font-semibold">Chess.com</span>
          </div>
          <div className="flex items-center gap-2 text-foreground/70 hover:text-foreground transition-colors">
            <div className="w-8 h-8 rounded bg-foreground/10 flex items-center justify-center font-bold text-sm">
              P
            </div>
            <span className="font-semibold">PGN Upload</span>
          </div>
        </div>
      </div>
    </section>
  );
};

export default PlatformLogos;
