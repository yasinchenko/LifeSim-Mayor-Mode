import { useState, useEffect, useCallback } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Users } from "lucide-react";
import { cn } from "@/lib/utils";

interface PopulationBreakdown {
  total: number;
  byEmployment: { employed: number; unemployed: number; retired: number };
  byAge: { youth: number; adult: number; mature: number; elder: number };
  byPersonality: Record<string, number>;
  byAction: Record<string, number>;
}

type ViewMode = "employment" | "age" | "personality" | "action";

const VIEW_MODES: { key: ViewMode; label: string }[] = [
  { key: "employment", label: "Занятость" },
  { key: "age",        label: "Возраст" },
  { key: "personality",label: "Личность" },
  { key: "action",     label: "Действие" },
];

const TEAL    = "hsl(173,80%,38%)";
const AMBER   = "hsl(43,100%,50%)";
const CRIMSON = "hsl(348,83%,52%)";
const BLUE    = "hsl(210,100%,55%)";
const PURPLE  = "hsl(280,80%,62%)";
const SLATE   = "hsl(210,20%,48%)";

function buildSlices(mode: ViewMode, data: PopulationBreakdown) {
  if (mode === "employment") {
    return [
      { name: "Работающие",   value: data.byEmployment.employed,   color: TEAL },
      { name: "Безработные",  value: data.byEmployment.unemployed,  color: CRIMSON },
      { name: "Пенсионеры",   value: data.byEmployment.retired,     color: AMBER },
    ];
  }
  if (mode === "age") {
    return [
      { name: "18–30 (молодёжь)",  value: data.byAge.youth,  color: BLUE },
      { name: "31–50 (взрослые)",  value: data.byAge.adult,  color: TEAL },
      { name: "51–65 (зрелые)",    value: data.byAge.mature, color: AMBER },
      { name: "66+ (пожилые)",     value: data.byAge.elder,  color: CRIMSON },
    ];
  }
  if (mode === "personality") {
    const palette = [TEAL, AMBER, CRIMSON, BLUE, PURPLE, SLATE];
    return Object.entries(data.byPersonality)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value], i) => ({ name, value, color: palette[i % palette.length] }));
  }
  const ACTION_NAMES: Record<string, string> = {
    work: "Работают",
    eat: "Едят",
    rest: "Отдыхают",
    socialize: "Общаются",
    idle: "Бездействуют",
  };
  const palette = [TEAL, AMBER, BLUE, PURPLE, SLATE, CRIMSON];
  return Object.entries(data.byAction)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value], i) => ({
      name: ACTION_NAMES[key] ?? key,
      value,
      color: palette[i % palette.length],
    }));
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: { name: string; value: number; payload: { color: string } }[] }) {
  if (!active || !payload?.length) return null;
  const { name, value, payload: p } = payload[0];
  return (
    <div className="bg-[hsl(225,15%,7%)] border border-[hsl(225,10%,20%)] rounded px-3 py-2 text-xs shadow-lg">
      <p className="font-medium mb-0.5" style={{ color: p.color }}>{name}</p>
      <p className="text-muted-foreground">{value} чел.</p>
    </div>
  );
}

function CustomLegend({ payload, total }: { payload?: { value: string; color: string; payload: { value: number } }[]; total: number }) {
  if (!payload) return null;
  return (
    <ul className="flex flex-col gap-1 text-[10px] pl-2 justify-center">
      {payload.map((entry) => {
        const pct = total > 0 ? ((entry.payload.value / total) * 100).toFixed(1) : "0";
        return (
          <li key={entry.value} className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: entry.color }} />
            <span className="text-muted-foreground">{entry.value}</span>
            <span className="ml-auto tabular-nums font-semibold pl-3" style={{ color: entry.color }}>{pct}%</span>
          </li>
        );
      })}
    </ul>
  );
}

export default function PopulationChart({ running }: { running: boolean }) {
  const [mode, setMode] = useState<ViewMode>("employment");
  const [data, setData] = useState<PopulationBreakdown | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const res = await fetch(`${base}/api/stats/population-breakdown`);
      if (res.ok) setData(await res.json());
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, running ? 7000 : 30000);
    return () => clearInterval(interval);
  }, [fetchData, running]);

  const slices = data ? buildSlices(mode, data).filter(s => s.value > 0) : [];

  return (
    <div className="bg-card border border-card-border rounded p-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Users className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <h3 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">
          Структура населения
        </h3>
        {running && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold tracking-wider bg-[hsl(173,80%,40%)]/15 text-[hsl(173,80%,40%)] border border-[hsl(173,80%,40%)]/25">
            <span className="w-1.5 h-1.5 rounded-full bg-[hsl(173,80%,40%)] animate-pulse inline-block" />
            LIVE
          </span>
        )}
        {data && (
          <span className="text-[10px] text-muted-foreground ml-1">
            {data.total.toLocaleString()} жит.
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {VIEW_MODES.map(v => (
            <button
              key={v.key}
              onClick={() => setMode(v.key)}
              className={cn(
                "px-2 py-0.5 rounded text-[10px] font-medium border transition-colors",
                mode === v.key
                  ? "bg-primary/15 border-primary/40 text-primary"
                  : "bg-transparent border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground"
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="h-48 flex items-center justify-center text-muted-foreground text-xs">
          Загрузка...
        </div>
      )}

      {!loading && slices.length === 0 && (
        <div className="h-48 flex items-center justify-center text-muted-foreground text-xs">
          Нет данных
        </div>
      )}

      {!loading && slices.length > 0 && (
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie
              data={slices}
              cx="40%"
              cy="50%"
              innerRadius={52}
              outerRadius={84}
              paddingAngle={2}
              dataKey="value"
              strokeWidth={0}
              animationDuration={500}
              animationEasing="ease-out"
            >
              {slices.map((s, i) => (
                <Cell key={i} fill={s.color} opacity={0.9} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
            <Legend
              layout="vertical"
              align="right"
              verticalAlign="middle"
              iconType="circle"
              content={(props) => <CustomLegend payload={props.payload as Parameters<typeof CustomLegend>[0]["payload"]} total={data?.total ?? 0} />}
            />
          </PieChart>
        </ResponsiveContainer>
      )}

      {!loading && data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 pt-3 border-t border-card-border">
          <MiniStat label="Работают" value={data.byEmployment.employed} color={TEAL} total={data.total} />
          <MiniStat label="Без работы" value={data.byEmployment.unemployed} color={CRIMSON} total={data.total} />
          <MiniStat label="Пенсионеры" value={data.byEmployment.retired} color={AMBER} total={data.total} />
          <MiniStat label="Ср. возраст" value={computeAvgAge(data)} color={BLUE} unit="" />
        </div>
      )}
    </div>
  );
}

function computeAvgAge(data: PopulationBreakdown): number {
  const { youth, adult, mature, elder } = data.byAge;
  const total = youth + adult + mature + elder;
  if (total === 0) return 0;
  const approx = youth * 24 + adult * 40.5 + mature * 58 + elder * 73;
  return Math.round(approx / total);
}

function MiniStat({ label, value, color, total, unit }: {
  label: string;
  value: number;
  color: string;
  total?: number;
  unit?: string;
}) {
  const pct = total != null && total > 0 ? ` (${((value / total) * 100).toFixed(0)}%)` : "";
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums" style={{ color }}>
        {unit !== "" ? value.toLocaleString() : value}{unit ?? ""}{pct}
      </p>
    </div>
  );
}
