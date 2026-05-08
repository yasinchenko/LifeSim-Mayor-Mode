import { Link, useLocation } from "wouter";
import { ArrowLeft, Building2 } from "lucide-react";

const SECTION_TITLES: Record<string, string> = {
  "/agents": "Жители",
  "/economy": "Экономика",
  "/government": "Государство",
  "/settings": "Настройки партии",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const isHome = location === "/";
  const title = SECTION_TITLES[Object.keys(SECTION_TITLES).find(path => location.startsWith(path)) ?? ""] ?? "LifeSim";

  return (
    <div className="dark min-h-screen bg-background text-foreground overflow-hidden">
      {!isHome && (
        <header className="sticky top-0 z-40 border-b border-border/70 bg-background/95 backdrop-blur">
          <div className="px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded border border-border bg-secondary px-3 py-2 text-xs font-medium text-secondary-foreground hover:opacity-90"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              К городу
            </Link>
            <div className="flex items-center gap-2 min-w-0">
              <Building2 className="w-4 h-4 text-primary shrink-0" />
              <span className="text-sm font-semibold truncate">{title}</span>
            </div>
          </div>
        </header>
      )}
      <main className={isHome ? "h-screen overflow-hidden" : "min-h-screen overflow-y-auto"}>
        {children}
      </main>
    </div>
  );
}
