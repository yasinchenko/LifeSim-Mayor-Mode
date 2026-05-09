import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getGetSimulationStateQueryKey, useNewGame } from "@workspace/api-client-react";
import { Building2, Languages, Play, Save, Settings, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { deleteSave, listSaves, loadSave, saveGame } from "@/lib/saves";
import { cn } from "@/lib/utils";
import { useLanguage, type Language } from "@/contexts/language-context";
import { useAudio } from "@/contexts/audio-context";
import AudioSettingsPanel from "@/components/audio/audio-settings-panel";

const MAP_ASSET = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/assets/maps/city-map-night.webp`;

const OPTIONS = {
  ru: {
    scenarios: [
      { value: "balanced", label: "Сбалансированный город", description: "Ровный старт с запасом бюджета и без жёсткого перекоса." },
      { value: "crisis", label: "Кризисный мандат", description: "Меньше денег и больше давления: город нужно быстро стабилизировать." },
      { value: "growth", label: "Экономический рывок", description: "Больше капитала на старте, но цель требует сильного роста." },
      { value: "stability", label: "Социальная устойчивость", description: "Фокус на здоровье, населении и спокойствии жителей." },
    ],
    goals: [
      { value: "balanced", label: "Баланс интересов", description: "Довести жителей, бизнес и власть до поддержки 70+." },
      { value: "crisis_recovery", label: "Выход из кризиса", description: "Вернуть бюджет, занятость и настроение в устойчивую зону." },
      { value: "market_growth", label: "Рыночная стратегия", description: "Поднять ВВП, прибыльность бизнеса и занятость через рынок." },
      { value: "social_stability", label: "Социальная стратегия", description: "Удержать население, здоровье и доверие жителей." },
      { value: "force_order", label: "Силовая стратегия", description: "Стабилизировать безопасность и управляемость без обвала доверия." },
      { value: "corruption_network", label: "Коррупционная стратегия", description: "Быстро собрать бюджет и подрядчиков, удержав доверие выше критической зоны." },
    ],
  },
  en: {
    scenarios: [
      { value: "balanced", label: "Balanced city", description: "A steady start with a budget reserve and no harsh imbalance." },
      { value: "crisis", label: "Crisis mandate", description: "Less money and more pressure: stabilize the city quickly." },
      { value: "growth", label: "Economic leap", description: "More starting capital, but the goal demands strong growth." },
      { value: "stability", label: "Social stability", description: "Focus on health, population, and public calm." },
    ],
    goals: [
      { value: "balanced", label: "Balance interests", description: "Raise residents, business, and government support to 70+." },
      { value: "crisis_recovery", label: "Crisis recovery", description: "Bring budget, employment, and mood back to stable levels." },
      { value: "market_growth", label: "Market strategy", description: "Increase GDP, profitability, and employment through the market." },
      { value: "social_stability", label: "Social strategy", description: "Protect population, health, and resident trust." },
      { value: "force_order", label: "Force strategy", description: "Stabilize safety and control without collapsing trust." },
      { value: "corruption_network", label: "Corruption strategy", description: "Use fast contracts and budget tricks while keeping trust above crisis level." },
    ],
  },
} as const;

type MenuView = "root" | "new" | "load" | "settings" | "exit";
type Scenario = (typeof OPTIONS.ru.scenarios)[number]["value"];
type Goal = (typeof OPTIONS.ru.goals)[number]["value"];

export default function MainMenu() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { language, setLanguage, t } = useLanguage();
  const audio = useAudio();
  const [view, setView] = useState<MenuView>("root");
  const [scenarioType, setScenarioType] = useState<Scenario>("balanced");
  const [goalType, setGoalType] = useState<Goal>("balanced");
  const [dayLimit, setDayLimit] = useState(32);
  const labels = OPTIONS[language];

  useEffect(() => {
    audio.setMusicMode("menu");
    audio.setCityPhase(null);
    return () => audio.setMusicMode("none");
  }, [audio]);

  const savesQuery = useQuery({
    queryKey: ["save-slots"],
    queryFn: listSaves,
    enabled: view === "load",
  });

  const newGameMutation = useNewGame({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries();
        setLocation("/city");
      },
      onError: err => toast.error(err instanceof Error ? err.message : "New game failed"),
    },
  });

  const loadSlot = async (slotId: string) => {
    await loadSave(slotId);
    qc.invalidateQueries({ queryKey: getGetSimulationStateQueryKey() });
    qc.invalidateQueries();
    setLocation("/city");
  };

  const quickSave = async () => {
    await saveGame("quick", t.menu.quickSave);
    await savesQuery.refetch();
    toast.success(t.game.saved);
  };

  return (
    <div className="dark min-h-screen relative overflow-hidden bg-[#202831] text-foreground">
      <img src={MAP_ASSET} alt="" className="absolute inset-0 h-full w-full object-cover opacity-45" draggable={false} />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,#202831_0%,rgba(32,40,49,0.84)_42%,rgba(32,40,49,0.5)_100%)]" />

      <main className="relative z-10 min-h-screen grid lg:grid-cols-[420px_1fr]">
        <section className="min-h-screen border-r border-white/10 bg-black/30 backdrop-blur p-5 sm:p-8 flex flex-col">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div className="w-11 h-11 rounded border border-primary/35 bg-primary/15 text-primary grid place-items-center shrink-0">
                <Building2 className="w-6 h-6" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-widest text-primary">{t.menu.title}</p>
                <h1 className="text-lg font-semibold leading-tight">{t.menu.subtitle}</h1>
              </div>
            </div>
            <LanguageToggle language={language} setLanguage={setLanguage} />
          </div>

          <div className="mt-10 space-y-2">
            <MenuButton icon={Play} label={t.menu.newGame} active={view === "new"} onClick={() => setView("new")} />
            <MenuButton icon={Upload} label={t.menu.continueGame} onClick={() => setLocation("/city")} />
            <MenuButton icon={Save} label={t.menu.loadGame} active={view === "load"} onClick={() => setView("load")} />
            <MenuButton icon={Settings} label={t.menu.settings} active={view === "settings"} onClick={() => setView("settings")} />
            <MenuButton icon={X} label={t.menu.exit} active={view === "exit"} onClick={() => setView("exit")} />
          </div>

          <div className="mt-auto" />
        </section>

        <section className="min-h-screen overflow-y-auto p-5 sm:p-8 lg:p-10">
          {view === "new" && (
            <MenuPanel title={t.menu.newGame} description={`${t.menu.scenario} / ${t.menu.goal}`}>
              <OptionGrid title={t.menu.scenario} items={labels.scenarios} value={scenarioType} onChange={value => setScenarioType(value as Scenario)} />
              <OptionGrid title={t.menu.goal} items={labels.goals} value={goalType} onChange={value => setGoalType(value as Goal)} />
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{t.menu.dayLimit}</p>
                  <span className="text-sm font-semibold text-primary tabular-nums">{dayLimit}</span>
                </div>
                <input
                  type="range"
                  min={7}
                  max={120}
                  step={1}
                  value={dayLimit}
                  onChange={event => setDayLimit(parseInt(event.target.value, 10))}
                  className="w-full h-1 bg-muted rounded-full appearance-none cursor-pointer accent-primary"
                />
              </div>
              <button
                onClick={() => newGameMutation.mutate({ data: { scenarioType, goalType, dayLimit } })}
                disabled={newGameMutation.isPending}
                className="inline-flex items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                <Play className="w-4 h-4" />
                {newGameMutation.isPending ? t.menu.loading : t.menu.start}
              </button>
            </MenuPanel>
          )}

          {view === "load" && (
            <MenuPanel title={t.menu.saves} description={t.menu.loadGame}>
              <button
                onClick={() => quickSave().catch(() => toast.error(t.game.saveFailed))}
                className="inline-flex w-fit items-center gap-2 rounded border border-primary/40 bg-primary/12 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/18"
              >
                <Save className="w-3.5 h-3.5" />
                {t.menu.saveNow}
              </button>
              {savesQuery.isLoading && <p className="text-sm text-muted-foreground">{t.menu.loading}</p>}
              <div className="grid gap-2">
                {savesQuery.data?.map(slot => (
                  <div key={slot.id} className="rounded border border-border/70 bg-black/32 p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{slot.name}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {slot.summary
                          ? `Day ${slot.summary.gameDay}, ${slot.summary.goalProgress}%`
                          : new Date(slot.updatedAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => loadSlot(slot.id).catch(err => toast.error(err instanceof Error ? err.message : t.menu.loadGame))} className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
                        {t.menu.load}
                      </button>
                      <button
                        onClick={() => deleteSave(slot.id).then(() => savesQuery.refetch())}
                        className="rounded border border-border bg-secondary px-2 py-1.5 text-secondary-foreground"
                        aria-label={t.menu.delete}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </MenuPanel>
          )}

          {view === "settings" && (
            <MenuPanel title={t.menu.settings} description={t.menu.language}>
              <LanguageToggle language={language} setLanguage={setLanguage} large />
              <AudioSettingsPanel />
            </MenuPanel>
          )}

          {view === "exit" && (
            <MenuPanel title={t.menu.exit} description={t.menu.exitHint}>
              <button onClick={() => window.close()} className="inline-flex w-fit items-center gap-2 rounded bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground border border-border">
                <X className="w-4 h-4" />
                {t.menu.exit}
              </button>
            </MenuPanel>
          )}
        </section>
      </main>
    </div>
  );
}

function LanguageToggle({ language, setLanguage, large = false }: { language: Language; setLanguage: (language: Language) => void; large?: boolean }) {
  return (
    <div className={cn("inline-flex shrink-0 items-center rounded border border-border bg-black/28 p-1", large && "w-fit")}>
      <Languages className="w-3.5 h-3.5 mx-2 text-muted-foreground" />
      {(["ru", "en"] as const).map(item => (
        <button
          key={item}
          onClick={() => setLanguage(item)}
          className={cn(
            "rounded px-2 py-1 text-xs font-semibold uppercase",
            language === item ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

function MenuButton({ icon: Icon, label, active, onClick }: { icon: typeof Play; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full inline-flex items-center gap-3 rounded border px-4 py-3 text-sm font-medium transition-colors",
        active ? "border-primary bg-primary/14 text-primary" : "border-border/70 bg-black/20 text-foreground hover:border-primary/45"
      )}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  );
}

function MenuPanel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="max-w-3xl rounded border border-border/70 bg-black/45 backdrop-blur p-5 sm:p-6 space-y-5">
      <div>
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground mt-1">{description}</p>
      </div>
      {children}
    </div>
  );
}

function OptionGrid<T extends string>({
  title,
  items,
  value,
  onChange,
}: {
  title: string;
  items: readonly { value: T; label: string; description: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">{title}</p>
      <div className="grid sm:grid-cols-2 gap-2">
        {items.map(item => (
          <button
            key={item.value}
            type="button"
            onClick={() => onChange(item.value)}
            className={cn(
              "text-left border rounded p-3 transition-colors",
              value === item.value ? "border-primary bg-primary/10" : "border-border bg-black/22 hover:bg-black/32"
            )}
          >
            <span className="block text-xs font-medium text-foreground">{item.label}</span>
            <span className="block text-[10px] text-muted-foreground mt-1 leading-snug">{item.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
