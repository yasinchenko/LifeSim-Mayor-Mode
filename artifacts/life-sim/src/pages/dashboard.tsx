import { useEffect, useMemo, useRef, useState, type ElementType } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  getGetDailyDecisionsQueryKey,
  getGetResidentRequestsQueryKey,
  getGetSimulationStateQueryKey,
  getGetStatsHistoryQueryKey,
  getGetStatsSummaryQueryKey,
  useGetDailyDecisions,
  useGetResidentRequests,
  useGetSimulationState,
  useGetStatsHistory,
  useGetStatsSummary,
  useIssueDailyDecision,
  useProcessResidentRequest,
  useStartSimulation,
  useStopSimulation,
} from "@workspace/api-client-react";
import type {
  DailyDecision,
  DailyDecisionsState,
  ResidentRequest,
  ResidentRequestsState,
  SimulationState,
  StatsSummary,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Briefcase,
  Building2,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  FileText,
  Flag,
  HandHeart,
  HeartPulse,
  Inbox,
  Landmark,
  LineChart as LineChartIcon,
  MapPin,
  Pause,
  Play,
  Settings,
  Shield,
  Sparkles,
  Trophy,
  Users,
  XCircle,
  Zap,
} from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import EventFeed from "@/components/event-feed";
import PopulationChart from "@/components/population-chart";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const MAP_ASSET = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/assets/mayor-city-map.svg`;

const SECTION_LINKS = [
  { href: "/agents", label: "Жители", icon: Users },
  { href: "/economy", label: "Экономика", icon: Briefcase },
  { href: "/government", label: "Государство", icon: Landmark },
  { href: "/settings", label: "Партия", icon: Settings },
];

const SCENARIO_LABELS: Record<string, string> = {
  balanced: "Сбалансированный город",
  crisis: "Кризисный мандат",
  growth: "Экономический рывок",
  stability: "Социальная устойчивость",
};

const GOAL_LABELS: Record<string, string> = {
  balanced: "Баланс интересов",
  crisis_recovery: "Выход из кризиса",
  economic_growth: "Рост экономики",
  social_stability: "Стабильный город",
};

type ChartDatum = {
  tick: number;
  mood: number;
  gdp: number;
  population: number;
  wealth: number;
  unemployment: number;
  govBudget: number;
};

function getApiErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const asObj = err as Record<string, unknown>;
    if (asObj.data && typeof asObj.data === "object") {
      const data = asObj.data as Record<string, unknown>;
      if (typeof data.error === "string") return data.error;
    }
    if (typeof asObj.message === "string") return asObj.message;
  }
  return "Неизвестная ошибка";
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toneFor(value: number) {
  if (value >= 70) return "good";
  if (value >= 45) return "warn";
  return "bad";
}

function toneColor(tone: "good" | "warn" | "bad") {
  if (tone === "good") return "hsl(173,80%,42%)";
  if (tone === "warn") return "hsl(43,100%,54%)";
  return "hsl(348,83%,56%)";
}

export default function Dashboard() {
  const qc = useQueryClient();
  const [tickFlash, setTickFlash] = useState(false);
  const prevTickRef = useRef<number | undefined>(undefined);

  const { data: state, isLoading } = useGetSimulationState({
    query: {
      queryKey: getGetSimulationStateQueryKey(),
      refetchInterval: 5000,
    },
  });

  const running = state?.running ?? false;

  const { data: history } = useGetStatsHistory({ limit: 60 }, {
    query: {
      queryKey: getGetStatsHistoryQueryKey({ limit: 60 }),
      refetchInterval: running ? 7000 : 60000,
    },
  });

  const { data: summary } = useGetStatsSummary({
    query: {
      queryKey: getGetStatsSummaryQueryKey(),
      refetchInterval: running ? 7000 : 30000,
    },
  });

  const { data: decisions } = useGetDailyDecisions({
    query: {
      queryKey: getGetDailyDecisionsQueryKey(),
      refetchInterval: running ? 5000 : 30000,
    },
  });

  const { data: residentRequests } = useGetResidentRequests({
    query: {
      queryKey: getGetResidentRequestsQueryKey(),
      refetchInterval: running ? 5000 : 30000,
    },
  });

  const issueDecisionMutation = useIssueDailyDecision({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetDailyDecisionsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetSimulationStateQueryKey() });
        qc.invalidateQueries({ queryKey: getGetStatsSummaryQueryKey() });
        toast.success("Решение принято");
      },
      onError: err => toast.error(`Не удалось принять решение: ${getApiErrorMessage(err)}`),
    },
  });

  const processResidentRequestMutation = useProcessResidentRequest({
    mutation: {
      onSuccess: (_data, variables) => {
        qc.invalidateQueries({ queryKey: getGetResidentRequestsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetSimulationStateQueryKey() });
        qc.invalidateQueries({ queryKey: getGetStatsSummaryQueryKey() });
        toast.success(variables.data.action === "help" ? "Житель получил помощь" : "Обращение закрыто");
      },
      onError: err => toast.error(`Не удалось обработать обращение: ${getApiErrorMessage(err)}`),
    },
  });

  const startMutation = useStartSimulation({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetSimulationStateQueryKey() });
        toast.success("Симуляция запущена");
      },
      onError: err => toast.error(`Ошибка запуска: ${getApiErrorMessage(err)}`),
    },
  });

  const stopMutation = useStopSimulation({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetSimulationStateQueryKey() });
        toast.info("Симуляция на паузе");
      },
      onError: err => toast.error(`Ошибка остановки: ${getApiErrorMessage(err)}`),
    },
  });

  useEffect(() => {
    const currentTick = state?.tick;
    if (currentTick !== undefined && prevTickRef.current !== undefined && prevTickRef.current !== currentTick) {
      setTickFlash(true);
      const t = setTimeout(() => setTickFlash(false), 700);
      prevTickRef.current = currentTick;
      return () => clearTimeout(t);
    }
    if (currentTick !== undefined) prevTickRef.current = currentTick;
    return undefined;
  }, [state?.tick]);

  const chartData = useMemo<ChartDatum[]>(() => history?.map(h => ({
    tick: h.tick,
    mood: Math.round(h.avgMood * 10) / 10,
    gdp: Math.round(h.gdp / 1000),
    population: h.population,
    wealth: Math.round(h.avgWealth * 10) / 10,
    unemployment: Math.round(h.unemploymentRate * 10) / 10,
    govBudget: Math.round(h.governmentBudget),
  })) ?? [], [history]);

  const cityHealth = useMemo(() => {
    if (!state) return { society: 0, economy: 0, government: 0 };
    const employed = 100 - state.unemploymentRate;
    const profitable = summary ? (summary.profitableBusinesses / Math.max(summary.totalBusinesses, 1)) * 100 : 60;
    return {
      society: clamp((state.avgMood + state.reputationResidents + (summary?.avgHealth ?? 58)) / 3),
      economy: clamp((employed + state.reputationBusiness + profitable) / 3),
      government: clamp((state.reputationGovernment + state.goalProgress + (state.governmentBudget >= 0 ? 75 : 30)) / 3),
    };
  }, [state, summary]);

  const gameTime = state
    ? `День ${state.gameDay}, ${String(state.gameHour).padStart(2, "0")}:00`
    : "Загрузка";

  if (isLoading || !state) {
    return (
      <div className="h-screen grid place-items-center bg-[#071019] text-foreground">
        <div className="text-center">
          <Building2 className="w-8 h-8 mx-auto mb-3 text-primary animate-pulse" />
          <p className="text-sm text-muted-foreground">Город загружается...</p>
        </div>
      </div>
    );
  }

  const ended = state.gameStatus !== "active";

  return (
    <div className="relative h-screen overflow-hidden bg-[#071019] text-foreground">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(34,200,184,0.18),transparent_38%),linear-gradient(180deg,rgba(7,16,25,0.4),#071019_88%)]" />

      <div className="relative z-10 h-full grid grid-rows-[auto_1fr_auto] gap-3 p-3 sm:p-4">
        <GameTopBar
          state={state}
          gameTime={gameTime}
          tickFlash={tickFlash}
          running={running}
          isStarting={startMutation.isPending}
          isStopping={stopMutation.isPending}
          onStart={() => startMutation.mutate()}
          onStop={() => stopMutation.mutate()}
          chartData={chartData}
          summary={summary}
        />

        <div className="min-h-0 grid grid-cols-1 xl:grid-cols-[280px_minmax(520px,1fr)_320px] gap-3 overflow-y-auto xl:overflow-hidden">
          <LeftStatusPanel state={state} health={cityHealth} decisions={decisions} />
          <CityMapStage
            state={state}
            summary={summary}
            decisions={decisions}
            health={cityHealth}
          />
          <RightRequestsPanel
            state={state}
            requestsState={residentRequests}
            decisions={decisions}
            isProcessing={processResidentRequestMutation.isPending}
            onProcess={(requestId, action) => processResidentRequestMutation.mutate({ data: { requestId, action } })}
          />
        </div>

        <ActionDock
          decisions={decisions}
          isIssuing={issueDecisionMutation.isPending}
          onIssue={(decisionId) => issueDecisionMutation.mutate({ data: { decisionId } })}
        />
      </div>

      {ended && (
        <div className="absolute inset-0 z-20 pointer-events-none flex items-start justify-center pt-24 px-4">
          <FinalReportCard state={state} summary={summary} chartData={chartData} />
        </div>
      )}
    </div>
  );
}

function GameTopBar({
  state,
  gameTime,
  tickFlash,
  running,
  isStarting,
  isStopping,
  onStart,
  onStop,
  chartData,
  summary,
}: {
  state: SimulationState;
  gameTime: string;
  tickFlash: boolean;
  running: boolean;
  isStarting: boolean;
  isStopping: boolean;
  onStart: () => void;
  onStop: () => void;
  chartData: ChartDatum[];
  summary?: StatsSummary;
}) {
  return (
    <header className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] gap-3 items-center">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 h-10 rounded bg-primary/15 border border-primary/30 grid place-items-center text-primary">
          <Flag className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">LifeSim Mayor Mode</p>
          <h1 className="text-lg font-semibold truncate">{GOAL_LABELS[state.goalType] ?? state.goalType}</h1>
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 flex-wrap">
        <div className={cn(
          "inline-flex items-center gap-2 rounded border px-3 py-2 text-xs font-medium bg-black/28 backdrop-blur",
          running ? "border-primary/40 text-primary" : "border-[hsl(348,83%,47%)]/45 text-[hsl(348,83%,58%)]"
        )}>
          <span className={cn("w-2 h-2 rounded-full", running ? "bg-primary animate-pulse" : "bg-[hsl(348,83%,58%)]")} />
          {running ? "Город живёт" : "Пауза"}
        </div>
        <div className={cn(
          "inline-flex items-center gap-2 rounded border border-border/70 bg-black/28 px-3 py-2 text-xs font-medium backdrop-blur transition-colors",
          tickFlash && "text-primary border-primary/50"
        )}>
          <Clock className="w-3.5 h-3.5" />
          {gameTime}
        </div>
        {running ? (
          <button
            onClick={onStop}
            disabled={isStopping}
            className="inline-flex items-center gap-2 rounded bg-secondary px-3 py-2 text-xs font-medium text-secondary-foreground border border-border hover:opacity-90 disabled:opacity-50"
          >
            <Pause className="w-3.5 h-3.5" />
            Пауза
          </button>
        ) : state.gameStatus === "active" && (
          <button
            onClick={onStart}
            disabled={isStarting}
            className="inline-flex items-center gap-2 rounded bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            Пуск
          </button>
        )}
      </div>

      <nav className="flex items-center justify-start lg:justify-end gap-2 overflow-x-auto">
        <MetricsDialog state={state} summary={summary} chartData={chartData} running={running} />
        {SECTION_LINKS.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="inline-flex items-center gap-2 rounded border border-border/70 bg-black/28 px-3 py-2 text-xs font-medium text-foreground backdrop-blur hover:border-primary/50 hover:text-primary whitespace-nowrap"
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

function LeftStatusPanel({
  state,
  health,
  decisions,
}: {
  state: SimulationState;
  health: { society: number; economy: number; government: number };
  decisions?: DailyDecisionsState;
}) {
  const pressure = Math.max(...(decisions?.factionPressure.pressureBySide.map(side => side.pressure) ?? [0]));

  return (
    <aside className="min-h-0 rounded border border-border/70 bg-black/30 backdrop-blur p-3 space-y-3 xl:overflow-y-auto">
      <PanelTitle icon={HeartPulse} title="Состояние города" />
      <CoreGauge label="Общество" value={health.society} icon={Users} />
      <CoreGauge label="Экономика" value={health.economy} icon={Briefcase} />
      <CoreGauge label="Государство" value={health.government} icon={Landmark} />

      <div className="border-t border-border/60 pt-3 space-y-2">
        <MiniReadout label="Прогресс цели" value={`${state.goalProgress}%`} tone={toneFor(state.goalProgress)} />
        <MiniReadout label="Дней осталось" value={String(state.daysRemaining)} tone={state.daysRemaining > 7 ? "good" : "warn"} />
        <MiniReadout label="Давление фракций" value={String(pressure)} tone={pressure >= 70 ? "bad" : pressure >= 45 ? "warn" : "good"} />
      </div>

      <div className="rounded border border-primary/25 bg-primary/10 p-3">
        <p className="text-[10px] uppercase tracking-widest text-primary">Сценарий</p>
        <p className="text-sm font-semibold mt-1">{SCENARIO_LABELS[state.scenarioType] ?? state.scenarioType}</p>
        <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
          Решения дня меняют город не сразу: часть эффектов запускается через несколько дней.
        </p>
      </div>
    </aside>
  );
}

function CityMapStage({
  state,
  summary,
  decisions,
  health,
}: {
  state: SimulationState;
  summary?: StatsSummary;
  decisions?: DailyDecisionsState;
  health: { society: number; economy: number; government: number };
}) {
  const districts = useMemo(() => buildDistricts(state, summary, decisions, health), [state, summary, decisions, health]);
  const [selectedId, setSelectedId] = useState("city-hall");
  const selected = districts.find(district => district.id === selectedId) ?? districts[0];
  const SelectedIcon = selected.icon;

  return (
    <section className="relative min-h-[560px] xl:min-h-0 rounded border border-border/70 bg-black/25 overflow-hidden">
      <img
        src={MAP_ASSET}
        alt="Карта города"
        className="absolute inset-0 h-full w-full object-cover opacity-95"
        draggable={false}
      />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,transparent_35%,rgba(7,16,25,0.58)_86%)]" />

      {districts.map(district => {
        const Icon = district.icon;
        const active = district.id === selected.id;
        const color = toneColor(toneFor(district.health));
        return (
          <button
            key={district.id}
            type="button"
            onClick={() => setSelectedId(district.id)}
            className={cn(
              "absolute -translate-x-1/2 -translate-y-1/2 rounded border bg-black/50 backdrop-blur px-3 py-2 text-left shadow-lg transition-all hover:scale-105 focus:outline-none focus:ring-2 focus:ring-primary/60",
              active ? "border-primary/70" : "border-white/20"
            )}
            style={{ left: district.x, top: district.y }}
          >
            <div className="flex items-center gap-2">
              <Icon className="w-4 h-4 shrink-0" style={{ color }} />
              <div>
                <p className="text-[10px] font-semibold leading-none whitespace-nowrap">{district.name}</p>
                <p className="text-[9px] text-muted-foreground mt-1">{district.health}</p>
              </div>
            </div>
          </button>
        );
      })}

      <div className="absolute left-4 top-4 right-4 flex items-start justify-between gap-3">
        <div className="rounded border border-white/15 bg-black/38 backdrop-blur px-3 py-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Городская карта</p>
          <p className="text-sm font-semibold">Выберите район</p>
        </div>
        <div className="rounded border border-primary/30 bg-primary/10 backdrop-blur px-3 py-2 text-right">
          <p className="text-[10px] uppercase tracking-widest text-primary">Население</p>
          <p className="text-sm font-semibold">{state.population.toLocaleString()}</p>
        </div>
      </div>

      <div className="absolute left-4 bottom-4 right-4 rounded border border-border/70 bg-black/58 backdrop-blur p-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded bg-white/8 border border-white/12 grid place-items-center shrink-0">
            <SelectedIcon className="w-5 h-5" style={{ color: toneColor(toneFor(selected.health)) }} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold">{selected.name}</h2>
              <span className="text-[10px] rounded bg-white/8 px-2 py-0.5 text-muted-foreground">{selected.role}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{selected.detail}</p>
          </div>
          <div className="ml-auto text-right shrink-0">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Индекс</p>
            <p className="text-2xl font-semibold tabular-nums" style={{ color: toneColor(toneFor(selected.health)) }}>{selected.health}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function RightRequestsPanel({
  state,
  requestsState,
  decisions,
  isProcessing,
  onProcess,
}: {
  state: SimulationState;
  requestsState?: ResidentRequestsState;
  decisions?: DailyDecisionsState;
  isProcessing: boolean;
  onProcess: (requestId: string, action: "help" | "decline") => void;
}) {
  const requests = requestsState?.requests ?? [];
  const pending = requestsState?.pendingCount ?? 0;
  const activeDemand = decisions?.factionPressure.activeDemands[0];

  return (
    <aside className="min-h-0 rounded border border-border/70 bg-black/30 backdrop-blur p-3 space-y-3 xl:overflow-y-auto">
      <PanelTitle icon={Inbox} title="Обращения и сигналы" badge={String(pending)} />

      {activeDemand && (
        <div className="rounded border border-[hsl(43,100%,50%)]/35 bg-[hsl(43,100%,50%)]/10 p-3">
          <p className="text-[10px] uppercase tracking-widest text-[hsl(43,100%,58%)]">{activeDemand.sideLabel}</p>
          <p className="text-sm font-semibold mt-1">{activeDemand.title}</p>
          <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">{activeDemand.requirement}</p>
        </div>
      )}

      <div className="space-y-2">
        {requests.slice(0, 5).map(request => (
          <RequestCard
            key={request.id}
            request={request}
            disabled={isProcessing}
            onProcess={onProcess}
          />
        ))}
      </div>

      {requests.length === 0 && (
        <div className="rounded border border-border/60 bg-white/[0.04] p-5 text-center">
          <CheckCircle2 className="w-7 h-7 mx-auto text-primary mb-2" />
          <p className="text-sm font-medium">Очередь пуста</p>
          <p className="text-[11px] text-muted-foreground mt-1">Новые обращения появятся по мере развития города.</p>
        </div>
      )}

      <div className="border-t border-border/60 pt-3">
        <MiniReadout label="Казна" value={Math.round(state.governmentBudget).toLocaleString()} tone={state.governmentBudget >= 0 ? "good" : "bad"} />
      </div>
    </aside>
  );
}

function ActionDock({
  decisions,
  isIssuing,
  onIssue,
}: {
  decisions?: DailyDecisionsState;
  isIssuing: boolean;
  onIssue: (decisionId: string) => void;
}) {
  const actions = useMemo(() => {
    if (!decisions || decisions.hasChosenToday) return [];
    return decisions.eventCards.flatMap(card => card.decisionIds
      .map(id => decisions.decisions.find(decision => decision.id === id))
      .filter((decision): decision is DailyDecision => Boolean(decision && decision.canIssue))
      .map(decision => ({ ...decision, cardTitle: card.title })));
  }, [decisions]);

  return (
    <section className="rounded border border-border/70 bg-black/45 backdrop-blur p-3 min-h-[118px]">
      <div className="flex items-center justify-between gap-3 mb-2">
        <PanelTitle icon={Zap} title="Доступные действия" badge={String(actions.length)} />
        {decisions && (
          <p className="text-[11px] text-muted-foreground">
            Очки: {decisions.actionPointsRemaining}/{decisions.actionPointsMax}
          </p>
        )}
      </div>

      {actions.length > 0 ? (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-2">
          {actions.slice(0, 3).map(action => (
            <ActionCard key={action.id} decision={action} isIssuing={isIssuing} onIssue={onIssue} />
          ))}
        </div>
      ) : (
        <div className="h-[68px] flex items-center justify-center rounded border border-dashed border-border/70 text-xs text-muted-foreground">
          {decisions?.hasChosenToday ? "Решение дня принято. Следующие действия появятся завтра." : "Сейчас нет доступных действий."}
        </div>
      )}
    </section>
  );
}

function MetricsDialog({
  state,
  summary,
  chartData,
  running,
}: {
  state: SimulationState;
  summary?: StatsSummary;
  chartData: ChartDatum[];
  running: boolean;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button className="inline-flex items-center gap-2 rounded border border-primary/40 bg-primary/12 px-3 py-2 text-xs font-medium text-primary backdrop-blur hover:bg-primary/18 whitespace-nowrap">
          <BarChart3 className="w-3.5 h-3.5" />
          Метрики
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto bg-background/98">
        <DialogHeader>
          <DialogTitle>Подробные метрики города</DialogTitle>
          <DialogDescription>
            Полная аналитика вынесена сюда, чтобы главный экран оставался игровым.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MetricTile icon={Users} label="Население" value={state.population.toLocaleString()} detail={`день ${state.gameDay}`} />
          <MetricTile icon={HeartPulse} label="Настроение" value={state.avgMood.toFixed(1)} detail="из 100" />
          <MetricTile icon={CircleDollarSign} label="ВВП" value={`${Math.round(state.gdp / 1000)}K`} detail="капитал" />
          <MetricTile icon={Landmark} label="Бюджет" value={Math.round(state.governmentBudget).toLocaleString()} detail="казна" />
          <MetricTile icon={Briefcase} label="Безработица" value={`${state.unemploymentRate.toFixed(1)}%`} detail="рынок труда" />
          <MetricTile icon={Shield} label="Здоровье" value={summary?.avgHealth?.toFixed(1) ?? "—"} detail="среднее" />
          <MetricTile icon={Sparkles} label="Бизнесы" value={summary ? `${summary.profitableBusinesses}/${summary.totalBusinesses}` : "—"} detail="прибыльные" />
          <MetricTile icon={ArrowRight} label="Миграция" value={`${(summary?.immigrantsLastTick ?? 0) - (summary?.emigrantsLastTick ?? 0)}`} detail="+ / − за день" />
        </div>

        {chartData.length > 0 && (
          <div className="grid lg:grid-cols-2 gap-3">
            <ChartCard title="Настроение" data={chartData} dataKey="mood" color="hsl(43,100%,54%)" domain={[0, 100]} />
            <ChartCard title="ВВП, тыс." data={chartData} dataKey="gdp" color="hsl(173,80%,42%)" />
            <ChartCard title="Население" data={chartData} dataKey="population" color="hsl(210,100%,58%)" />
            <ChartCard title="Казна" data={chartData} dataKey="govBudget" color="hsl(280,80%,64%)" />
          </div>
        )}

        <div className="grid xl:grid-cols-2 gap-3">
          <PopulationChart running={running} />
          <EventFeed currentDay={state.gameDay} running={running} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FinalReportCard({
  state,
  summary,
  chartData,
}: {
  state: SimulationState;
  summary?: StatsSummary;
  chartData: ChartDatum[];
}) {
  const first = chartData[0];
  const last = chartData[chartData.length - 1];
  const popDelta = first && last ? last.population - first.population : 0;
  const score = clamp(
    state.goalProgress * 0.45 +
    ((state.reputationResidents + state.reputationBusiness + state.reputationGovernment) / 3) * 0.35 +
    Math.max(0, 100 - state.unemploymentRate) * 0.2
  );

  return (
    <div className="pointer-events-auto w-full max-w-3xl rounded border border-primary/35 bg-black/82 backdrop-blur-xl p-5 shadow-2xl">
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded bg-primary/15 text-primary grid place-items-center shrink-0">
          {state.gameStatus === "victory" ? <Trophy className="w-6 h-6" /> : <FileText className="w-6 h-6" />}
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Финальный отчёт</p>
          <h2 className="text-xl font-semibold">{state.gameStatus === "victory" ? "Мандат выполнен" : "Мандат провален"} · рейтинг {score}</h2>
          <p className="text-xs text-muted-foreground mt-1">{state.gameOutcomeReason ?? "Партия завершена."}</p>
        </div>
        <Link href="/settings" className="ml-auto inline-flex items-center gap-2 rounded bg-primary px-3 py-2 text-xs font-medium text-primary-foreground">
          <Flag className="w-3.5 h-3.5" />
          Новая партия
        </Link>
      </div>
      <div className="grid sm:grid-cols-4 gap-3 mt-4">
        <ReportTile label="Дней" value={String(state.gameDay)} />
        <ReportTile label="Цель" value={`${state.goalProgress}%`} />
        <ReportTile label="Население" value={`${popDelta >= 0 ? "+" : ""}${popDelta}`} />
        <ReportTile label="Лучший житель" value={summary?.happiestAgent ?? "—"} />
      </div>
    </div>
  );
}

function buildDistricts(
  state: SimulationState,
  summary: StatsSummary | undefined,
  decisions: DailyDecisionsState | undefined,
  health: { society: number; economy: number; government: number },
) {
  const pressure = decisions?.factionPressure.pressureBySide ?? [];
  const residentsPressure = pressure.find(side => side.side === "residents")?.pressure ?? 30;
  const businessPressure = pressure.find(side => side.side === "business")?.pressure ?? 30;

  return [
    {
      id: "residential",
      name: "Кварталы",
      role: "общество",
      icon: Users,
      x: "29%",
      y: "38%",
      health: clamp(health.society - residentsPressure * 0.08),
      detail: `Настроение ${state.avgMood.toFixed(1)}, здоровье ${summary?.avgHealth?.toFixed(1) ?? "—"}, доверие жителей ${state.reputationResidents.toFixed(0)}.`,
    },
    {
      id: "city-hall",
      name: "Ратуша",
      role: "мандат",
      icon: Landmark,
      x: "50%",
      y: "38%",
      health: health.government,
      detail: `Прогресс цели ${state.goalProgress}%, власть ${state.reputationGovernment.toFixed(0)}, осталось ${state.daysRemaining} дней.`,
    },
    {
      id: "business",
      name: "Деловой район",
      role: "экономика",
      icon: Briefcase,
      x: "70%",
      y: "35%",
      health: clamp(health.economy - businessPressure * 0.08),
      detail: `ВВП ${Math.round(state.gdp / 1000)}K, безработица ${state.unemploymentRate.toFixed(1)}%, доверие бизнеса ${state.reputationBusiness.toFixed(0)}.`,
    },
    {
      id: "market",
      name: "Рынок",
      role: "товары",
      icon: CircleDollarSign,
      x: "61%",
      y: "58%",
      health: clamp(55 + Math.min(35, Math.max(-30, (summary?.marketBalance ?? 0) / 1000))),
      detail: `Баланс рынка ${summary?.marketBalance?.toLocaleString() ?? "—"}, популярный товар: ${summary?.mostPopularGood ?? "—"}.`,
    },
    {
      id: "services",
      name: "Службы",
      role: "безопасность",
      icon: Shield,
      x: "38%",
      y: "61%",
      health: clamp(((summary?.avgHealth ?? 55) + (summary?.avgSleep ?? 55) + state.reputationResidents) / 3),
      detail: `Здоровье ${summary?.avgHealth?.toFixed(1) ?? "—"}, сон ${summary?.avgSleep?.toFixed(1) ?? "—"}, активных эффектов ${decisions?.activeEffects.length ?? 0}.`,
    },
  ];
}

function PanelTitle({ icon: Icon, title, badge }: { icon: ElementType; title: string; badge?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-primary" />
        <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground">{title}</h2>
      </div>
      {badge && <span className="rounded bg-primary/12 px-2 py-0.5 text-[10px] font-semibold text-primary">{badge}</span>}
    </div>
  );
}

function CoreGauge({ label, value, icon: Icon }: { label: string; value: number; icon: ElementType }) {
  const tone = toneFor(value);
  const color = toneColor(tone);
  return (
    <div className="rounded border border-border/60 bg-white/[0.04] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4" style={{ color }} />
          <span className="text-sm font-medium">{label}</span>
        </div>
        <span className="text-lg font-semibold tabular-nums" style={{ color }}>{value}</span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${value}%`, background: color }} />
      </div>
    </div>
  );
}

function MiniReadout({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" | "bad" }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums" style={{ color: toneColor(tone) }}>{value}</span>
    </div>
  );
}

function RequestCard({
  request,
  disabled,
  onProcess,
}: {
  request: ResidentRequest;
  disabled: boolean;
  onProcess: (requestId: string, action: "help" | "decline") => void;
}) {
  return (
    <div className="rounded border border-border/60 bg-white/[0.04] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold truncate">{request.residentName}, {request.residentAge}</p>
          <p className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
            <MapPin className="w-3 h-3" />
            {request.district}
          </p>
        </div>
        <span className="text-[9px] rounded bg-white/8 px-2 py-0.5 text-muted-foreground shrink-0">{request.categoryLabel}</span>
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed mt-2 line-clamp-3">{request.problem}</p>
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={() => onProcess(request.id, "help")}
          disabled={!request.canHelp || disabled}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded bg-primary px-2 py-1.5 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
        >
          <HandHeart className="w-3 h-3" />
          Помочь
        </button>
        <button
          onClick={() => onProcess(request.id, "decline")}
          disabled={disabled}
          className="inline-flex items-center justify-center rounded bg-white/8 px-2 py-1.5 text-muted-foreground disabled:opacity-50"
          aria-label="Отказать"
        >
          <XCircle className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function ActionCard({ decision, isIssuing, onIssue }: {
  decision: DailyDecision & { cardTitle: string };
  isIssuing: boolean;
  onIssue: (decisionId: string) => void;
}) {
  const tone = decision.tone === "critical" ? "bad" : decision.tone === "opportunity" ? "good" : "warn";
  const color = toneColor(tone);
  return (
    <div className="rounded border bg-white/[0.05] p-3" style={{ borderColor: `${color}66` }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-widest truncate" style={{ color }}>{decision.sideLabel}</p>
          <h3 className="text-sm font-semibold leading-tight mt-1">{decision.title}</h3>
        </div>
        <Sparkles className="w-4 h-4 shrink-0" style={{ color }} />
      </div>
      <p className="text-[11px] text-muted-foreground line-clamp-2 mt-2">{decision.impactSummary}</p>
      <div className="flex items-center justify-between gap-2 mt-3">
        <span className="text-[10px] text-muted-foreground">Бюджет {Math.round(decision.budgetCost).toLocaleString()}</span>
        <button
          onClick={() => onIssue(decision.id)}
          disabled={isIssuing || !decision.canIssue}
          className="inline-flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
        >
          Принять
          <ArrowRight className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

function MetricTile({ icon: Icon, label, value, detail }: { icon: ElementType; label: string; value: string; detail: string }) {
  return (
    <div className="rounded border border-border/60 bg-muted/15 p-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="w-3.5 h-3.5" />
        <span className="text-[10px] uppercase tracking-widest">{label}</span>
      </div>
      <p className="text-xl font-semibold tabular-nums mt-1">{value}</p>
      <p className="text-[10px] text-muted-foreground mt-0.5">{detail}</p>
    </div>
  );
}

function ReportTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border/60 bg-white/[0.04] p-3 min-w-0">
      <p className="text-[9px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold mt-1 truncate">{value}</p>
    </div>
  );
}

function ChartCard({ title, data, dataKey, color, domain }: {
  title: string;
  data: Record<string, number>[];
  dataKey: string;
  color: string;
  domain?: [number, number];
}) {
  return (
    <div className="rounded border border-border/60 bg-muted/15 p-4">
      <div className="flex items-center gap-2 mb-3">
        <LineChartIcon className="w-3.5 h-3.5 text-muted-foreground" />
        <h3 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">{title}</h3>
      </div>
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
          <XAxis dataKey="tick" tick={{ fontSize: 9, fill: "hsl(210,10%,60%)" }} tickLine={false} />
          <YAxis domain={domain} tick={{ fontSize: 9, fill: "hsl(210,10%,60%)" }} tickLine={false} />
          <Tooltip
            contentStyle={{ background: "hsl(225,15%,7%)", border: "1px solid hsl(225,10%,20%)", borderRadius: 4, fontSize: 11 }}
            labelStyle={{ color: "hsl(210,20%,90%)" }}
          />
          <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} dot={false} isAnimationActive />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
