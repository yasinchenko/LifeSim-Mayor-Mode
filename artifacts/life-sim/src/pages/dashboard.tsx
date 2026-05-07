import { useState, useRef, useEffect, type ElementType } from "react";
import {
  useGetSimulationState,
  getGetSimulationStateQueryKey,
  useGetStatsHistory,
  getGetStatsHistoryQueryKey,
  getGetStatsSummaryQueryKey,
  useGetStatsSummary,
} from "@workspace/api-client-react";
import EventFeed from "@/components/event-feed";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

import {
  Users, TrendingUp, AlertTriangle, Coins, Heart, Clock, Landmark, Settings,
  Baby, Building2, Package, Briefcase, Moon, ShieldPlus, ArrowRightLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import StatCard from "@/components/stat-card";
import DebugPanel from "@/components/debug-panel";
import PopulationChart from "@/components/population-chart";
import { Link } from "wouter";

export default function Dashboard() {
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

  useEffect(() => {
    const currentTick = state?.tick;
    if (currentTick !== undefined && prevTickRef.current !== undefined && prevTickRef.current !== currentTick) {
      setTickFlash(true);
      const t = setTimeout(() => setTickFlash(false), 700);
      prevTickRef.current = currentTick;
      return () => clearTimeout(t);
    }
    if (currentTick !== undefined) {
      prevTickRef.current = currentTick;
    }
  }, [state?.tick]);

  const chartData = history?.map(h => ({
    tick: h.tick,
    mood: Math.round(h.avgMood * 10) / 10,
    gdp: Math.round(h.gdp / 1000),
    population: h.population,
    wealth: Math.round(h.avgWealth * 10) / 10,
    unemployment: Math.round(h.unemploymentRate * 10) / 10,
    govBudget: Math.round(h.governmentBudget),
  })) ?? [];

  const last20 = chartData.slice(-20);
  const sparklines = {
    population: last20.map(d => d.population),
    mood: last20.map(d => d.mood),
    gdp: last20.map(d => d.gdp),
    unemployment: last20.map(d => d.unemployment),
    govBudget: last20.map(d => d.govBudget),
    wealth: last20.map(d => d.wealth),
  };

  const formatGameTime = () => {
    if (!state) return "--:--";
    const h = String(state.gameHour).padStart(2, "0");
    return `День ${state.gameDay}, ${h}:00`;
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-foreground">Дашборд симуляции</h1>
          <p className={cn(
            "text-xs mt-0.5 flex items-center gap-1.5 transition-colors duration-300",
            tickFlash ? "text-[hsl(173,80%,40%)]" : "text-muted-foreground"
          )}>
            <span className={cn(
              "w-1.5 h-1.5 rounded-full shrink-0 transition-all duration-150",
              tickFlash ? "bg-[hsl(173,80%,40%)] scale-125 shadow-[0_0_6px_hsl(173,80%,40%)]" : "bg-muted-foreground/30"
            )} />
            {isLoading ? "Загрузка..." : `Тик #${state?.tick ?? 0} · ${formatGameTime()}`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border",
            running
              ? "bg-[hsl(173,80%,40%)]/10 border-[hsl(173,80%,40%)]/30 text-[hsl(173,80%,40%)]"
              : "bg-[hsl(348,83%,47%)]/10 border-[hsl(348,83%,47%)]/30 text-[hsl(348,83%,47%)]"
          )}>
            <span className={cn("w-1.5 h-1.5 rounded-full", running ? "bg-[hsl(173,80%,40%)] animate-pulse" : "bg-[hsl(348,83%,47%)]")} />
            {running ? "РАБОТАЕТ" : "ОСТАНОВЛЕНА"}
          </div>
          <Link
            href="/settings"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary text-secondary-foreground rounded text-xs font-medium hover:opacity-90 border border-border transition-opacity"
          >
            <Settings className="w-3 h-3" />
            Управление
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
        <StatCard label="Население" value={state?.population?.toLocaleString() ?? "--"} icon={Users} accent="teal" sparklineData={sparklines.population} running={running} />
        <StatCard label="Ср. настроение" value={state?.avgMood?.toFixed(1) ?? "--"} sub="из 100" icon={Heart} accent="amber" sparklineData={sparklines.mood} running={running} />
        <StatCard label="ВВП (капитал)" value={state ? `${Math.round(state.gdp / 1000)}K` : "--"} icon={TrendingUp} accent="blue" sparklineData={sparklines.gdp} running={running} />
        <StatCard label="Безработица" value={state ? `${state.unemploymentRate.toFixed(1)}%` : "--"} icon={AlertTriangle} accent="crimson" sparklineData={sparklines.unemployment} running={running} />
        <StatCard label="Бюджет гос-ва" value={state ? `${Math.round(state.governmentBudget).toLocaleString()}` : "--"} icon={Landmark} accent="purple" sparklineData={sparklines.govBudget} running={running} />
        <StatCard label="Ср. богатство" value={state ? `${state.avgWealth.toFixed(0)}` : "--"} icon={Coins} accent="teal" sparklineData={sparklines.wealth} running={running} />
      </div>

      {summary && (
        <div className="bg-card border border-card-border rounded p-4 space-y-4">
          <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Сводка</h2>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <SummaryMetric
              icon={ShieldPlus}
              label="Здоровье"
              sublabel="среднее по жителям"
              value={summary.avgHealth?.toFixed(1) ?? "—"}
              delta={summary.avgHealth - 50}
              deltaLabel={summary.avgHealth >= 70 ? "хорошее" : summary.avgHealth >= 40 ? "среднее" : "критическое"}
              positive={summary.avgHealth >= 50}
              bar
              barFill={summary.avgHealth / 100}
            />
            <SummaryMetric
              icon={Moon}
              label="Сон"
              sublabel="среднее по жителям"
              value={summary.avgSleep?.toFixed(1) ?? "—"}
              delta={summary.avgSleep - 50}
              deltaLabel={summary.avgSleep >= 70 ? "выспавшиеся" : summary.avgSleep >= 40 ? "усталые" : "истощённые"}
              positive={summary.avgSleep >= 50}
              bar
              barFill={summary.avgSleep / 100}
            />
            <SummaryMetric
              icon={Baby}
              label="Рождаемость"
              sublabel="родилось / умерло за день"
              value={`+${summary.birthsLastTick} / −${summary.deathsLastTick}`}
              delta={summary.birthsLastTick - summary.deathsLastTick}
              deltaLabel={
                summary.birthsLastTick - summary.deathsLastTick >= 0
                  ? `+${summary.birthsLastTick - summary.deathsLastTick} чел.`
                  : `${summary.birthsLastTick - summary.deathsLastTick} чел.`
              }
              positive={summary.birthsLastTick >= summary.deathsLastTick}
            />
            <SummaryMetric
              icon={ArrowRightLeft}
              label="Миграция"
              sublabel="прибыло / уехало за день"
              value={`+${summary.immigrantsLastTick ?? 0} / −${summary.emigrantsLastTick ?? 0}`}
              delta={(summary.immigrantsLastTick ?? 0) - (summary.emigrantsLastTick ?? 0)}
              deltaLabel={
                (summary.immigrantsLastTick ?? 0) - (summary.emigrantsLastTick ?? 0) >= 0
                  ? `+${(summary.immigrantsLastTick ?? 0) - (summary.emigrantsLastTick ?? 0)} чел.`
                  : `${(summary.immigrantsLastTick ?? 0) - (summary.emigrantsLastTick ?? 0)} чел.`
              }
              positive={(summary.immigrantsLastTick ?? 0) >= (summary.emigrantsLastTick ?? 0)}
            />
            <SummaryMetric
              icon={Building2}
              label="Бизнесы"
              sublabel="прибыльных / убыточных"
              value={`${summary.profitableBusinesses} / ${summary.unprofitableBusinesses}`}
              delta={summary.profitableBusinesses - summary.unprofitableBusinesses}
              deltaLabel={
                summary.profitableBusinesses > summary.unprofitableBusinesses
                  ? `${Math.round((summary.profitableBusinesses / summary.totalBusinesses) * 100)}% в плюсе`
                  : `${Math.round((summary.unprofitableBusinesses / summary.totalBusinesses) * 100)}% в убытке`
              }
              positive={summary.profitableBusinesses >= summary.unprofitableBusinesses}
              bar
              barFill={summary.totalBusinesses > 0 ? summary.profitableBusinesses / summary.totalBusinesses : 0}
            />
            <SummaryMetric
              icon={Package}
              label="Рынок"
              sublabel="баланс всех бизнесов"
              value={summary.marketBalance.toLocaleString()}
              delta={summary.marketBalance}
              deltaLabel={
                summary.totalDemand > 0
                  ? `спрос/пред. ${(summary.totalDemand / Math.max(summary.totalSupply, 1)).toFixed(2)}`
                  : "нет данных"
              }
              positive={summary.marketBalance >= 0}
            />
            <SummaryMetric
              icon={Briefcase}
              label="Трудоустроено"
              sublabel="жителей работает"
              value={`${summary.employedAgents} / ${summary.totalAgents}`}
              delta={summary.totalAgents > 0 ? summary.employedAgents / summary.totalAgents : 0}
              deltaLabel={
                summary.totalAgents > 0
                  ? `${Math.round((summary.employedAgents / summary.totalAgents) * 100)}% занято`
                  : "нет данных"
              }
              positive={(summary.employedAgents / Math.max(summary.totalAgents, 1)) >= 0.5}
              bar
              barFill={summary.totalAgents > 0 ? summary.employedAgents / summary.totalAgents : 0}
            />
          </div>

          <div className="border-t border-border pt-3 grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
            <div>
              <p className="text-[9px] uppercase tracking-widest text-muted-foreground mb-1">Богатейший житель</p>
              <p className="font-medium text-foreground truncate">{summary.richestAgent ?? "—"}</p>
            </div>
            <div>
              <p className="text-[9px] uppercase tracking-widest text-muted-foreground mb-1">Счастливейший житель</p>
              <p className="font-medium text-foreground truncate">{summary.happiestAgent ?? "—"}</p>
            </div>
            <div>
              <p className="text-[9px] uppercase tracking-widest text-muted-foreground mb-1">Популярный товар</p>
              <p className="font-medium text-[hsl(43,100%,50%)] truncate">{summary.mostPopularGood ?? "—"}</p>
            </div>
          </div>
        </div>
      )}

      <PopulationChart running={running} />

      <EventFeed currentDay={state?.gameDay ?? 0} running={running} />

      {chartData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ChartCard title="Среднее настроение" data={chartData} dataKey="mood" color="hsl(43,100%,50%)" domain={[0, 100]} running={running} />
          <ChartCard title="ВВП (тыс. ед.)" data={chartData} dataKey="gdp" color="hsl(173,80%,40%)" running={running} />
          <ChartCard title="Население" data={chartData} dataKey="population" color="hsl(210,100%,50%)" running={running} />
          <ChartCard title="Среднее богатство" data={chartData} dataKey="wealth" color="hsl(280,80%,60%)" running={running} />
        </div>
      )}

      {chartData.length === 0 && !isLoading && (
        <div className="bg-card border border-card-border rounded p-8 text-center">
          <Clock className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Данные появятся после первого тика симуляции</p>
          <p className="text-xs text-muted-foreground mt-1">Каждый тик = 1 игровой час = 1 минута реального времени</p>
        </div>
      )}

      <DebugPanel running={running} />
    </div>
  );
}

function SummaryMetric({
  icon: Icon, label, sublabel, value, deltaLabel, positive, bar, barFill,
}: {
  icon: ElementType;
  label: string;
  sublabel: string;
  value: string;
  delta: number;
  deltaLabel: string;
  positive: boolean;
  bar?: boolean;
  barFill?: number;
}) {
  const accent = positive ? "hsl(173,80%,40%)" : "hsl(348,83%,52%)";
  return (
    <div className="bg-muted/20 border border-border/50 rounded p-3 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Icon className="w-3 h-3 text-muted-foreground shrink-0" />
        <span className="text-[9px] uppercase tracking-widest text-muted-foreground leading-tight">{label}</span>
      </div>
      <p className="text-sm font-semibold tabular-nums leading-none" style={{ color: accent }}>{value}</p>
      {bar && barFill !== undefined && (
        <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${Math.round(barFill * 100)}%`, background: accent }}
          />
        </div>
      )}
      <p className="text-[10px] text-muted-foreground leading-tight">{sublabel}</p>
      <p className="text-[10px] font-medium" style={{ color: accent }}>{deltaLabel}</p>
    </div>
  );
}

function ChartCard({ title, data, dataKey, color, domain, running }: {
  title: string;
  data: Record<string, number>[];
  dataKey: string;
  color: string;
  domain?: [number, number];
  running: boolean;
}) {
  return (
    <div className="bg-card border border-card-border rounded p-4">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">{title}</h3>
        {running && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold tracking-wider bg-[hsl(173,80%,40%)]/15 text-[hsl(173,80%,40%)] border border-[hsl(173,80%,40%)]/25">
            <span className="w-1.5 h-1.5 rounded-full bg-[hsl(173,80%,40%)] animate-pulse inline-block" />
            LIVE
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={120}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(225,10%,20%)" />
          <XAxis dataKey="tick" tick={{ fontSize: 9, fill: "hsl(210,10%,60%)" }} tickLine={false} />
          <YAxis domain={domain} tick={{ fontSize: 9, fill: "hsl(210,10%,60%)" }} tickLine={false} />
          <Tooltip
            contentStyle={{ background: "hsl(225,15%,7%)", border: "1px solid hsl(225,10%,20%)", borderRadius: 4, fontSize: 11 }}
            labelStyle={{ color: "hsl(210,20%,90%)" }}
          />
          <Line
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={true}
            animationDuration={600}
            animationEasing="ease-out"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
