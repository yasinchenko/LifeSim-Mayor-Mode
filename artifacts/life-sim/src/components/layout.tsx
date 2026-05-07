import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { Activity, Users, BarChart2, Landmark, Settings, Server, Menu, X, Lock } from "lucide-react";
import { useAdmin } from "@/contexts/admin-context";

const NAV = [
  { href: "/", label: "Дашборд", icon: Activity },
  { href: "/agents", label: "Жители", icon: Users },
  { href: "/economy", label: "Экономика", icon: BarChart2 },
  { href: "/government", label: "Государство", icon: Landmark },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { isAdmin } = useAdmin();

  useEffect(() => {
    setSidebarOpen(false);
  }, [location]);

  return (
    <div className="dark flex h-screen bg-background text-foreground overflow-hidden">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 w-52 flex flex-col bg-sidebar border-r border-border transition-transform duration-200",
        "md:relative md:translate-x-0 md:shrink-0",
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="flex items-center justify-between px-4 py-4 border-b border-sidebar-border">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold text-sidebar-foreground tracking-wide uppercase">LifeSim</span>
          </div>
          <button
            className="md:hidden text-muted-foreground hover:text-foreground p-0.5"
            onClick={() => setSidebarOpen(false)}
            aria-label="Закрыть меню"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav className="flex-1 py-3 px-2 space-y-0.5">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? location === href : location.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-primary"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                {label}
              </Link>
            );
          })}

          <Link
            href="/settings"
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition-colors",
              location.startsWith("/settings")
                ? "bg-sidebar-accent text-sidebar-primary"
                : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            )}
          >
            {isAdmin ? (
              <Settings className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <Lock className="w-3.5 h-3.5 shrink-0" />
            )}
            <span className="flex-1">Настройки</span>
            {isAdmin && (
              <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-primary/20 text-primary border border-primary/30 leading-none">
                ADMIN
              </span>
            )}
          </Link>
        </nav>

        <div className="px-4 py-3 border-t border-sidebar-border">
          <p className="text-[10px] text-muted-foreground">Life Simulation v1.0</p>
        </div>
      </aside>

      <div className="flex flex-col flex-1 overflow-hidden min-w-0">
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-border bg-sidebar shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            aria-label="Открыть меню"
            className="text-muted-foreground hover:text-foreground"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold tracking-wide uppercase">LifeSim</span>
          </div>
        </div>

        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
