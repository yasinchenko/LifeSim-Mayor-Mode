import React, { useState, useMemo } from "react";
import {
  useListBusinesses,
  getListBusinessesQueryKey,
  useListGoods,
  getListGoodsQueryKey,
  useGetSimulationState,
  getGetSimulationStateQueryKey,
  type ListBusinessesQueryResult,
  type ListGoodsQueryResult,
} from "@workspace/api-client-react";
import {
  Building2, Package, TrendingDown, UserMinus, UserPlus,
  BarChart2, Table2, ChevronUp, ChevronDown, ArrowRight, Tractor, Wrench, Utensils, Hammer,
} from "lucide-react";
import { cn } from "@/lib/utils";

type BizItem  = NonNullable<ListBusinessesQueryResult>[number];
type GoodItem = NonNullable<ListGoodsQueryResult>[number];
type ViewMode = "table" | "analysis";
type BizGroupBy = "type" | "status" | "size";
type BizSortCol = "label" | "count" | "profitablePct" | "avgBalance" | "totalEmployees" | "avgProduction";
type GoodSortCol = "name" | "ratio" | "priceDiff" | "demand" | "supply" | "currentPrice" | "quality";

const TYPE_LABELS: Record<string, string> = {
  food: "Еда",
  service: "Сервис",
  hospital: "Больница",
  farm: "Ферма",
  workshop: "Мастерская",
  school: "Школа",
  park: "Парк",
  temple: "Храм",
};
const TYPE_COLORS: Record<string, string> = {
  food: "text-[hsl(43,100%,50%)]",
  service: "text-[hsl(173,80%,40%)]",
  hospital: "text-[hsl(0,80%,60%)]",
  farm: "text-[hsl(84,70%,45%)]",
  workshop: "text-[hsl(200,80%,50%)]",
  school: "text-[hsl(270,70%,60%)]",
  park: "text-[hsl(120,60%,45%)]",
  temple: "text-[hsl(35,90%,55%)]",
};

const BIZ_GROUP_OPTIONS: { key: BizGroupBy; label: string }[] = [
  { key: "type",   label: "Тип" },
  { key: "status", label: "Статус" },
  { key: "size",   label: "Размер" },
];

interface BizGroup {
  label: string;
  count: number;
  profitablePct: number;
  avgBalance: number;
  totalEmployees: number;
  avgProduction: number;
  lossCount: number;
}

function getBizGroupKey(biz: BizItem, groupBy: BizGroupBy): string {
  if (groupBy === "type") return TYPE_LABELS[biz.type] ?? biz.type;
  if (groupBy === "status") {
    if (biz.balance > 0) return "Прибыльные";
    if (biz.balance < 0) return "Убыточные";
    return "Нулевой баланс";
  }
  if (biz.employeeCount <= 2) return "Малые (0–2 сотр.)";
  if (biz.employeeCount <= 6) return "Средние (3–6 сотр.)";
  return "Крупные (7+ сотр.)";
}

export default function EconomyPage() {
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [bizGroupBy, setBizGroupBy] = useState<BizGroupBy>("type");
  const [bizSortCol, setBizSortCol] = useState<BizSortCol>("count");
  const [bizSortDir, setBizSortDir] = useState<"asc" | "desc">("desc");
  const [goodSortCol, setGoodSortCol] = useState<GoodSortCol>("ratio");
  const [goodSortDir, setGoodSortDir] = useState<"asc" | "desc">("desc");

  const { data: simState } = useGetSimulationState({
    query: { queryKey: getGetSimulationStateQueryKey(), refetchInterval: 5000 },
  });
  const running = simState?.running ?? false;

  const { data: businesses, isLoading: bizLoading } = useListBusinesses({
    query: { queryKey: getListBusinessesQueryKey(), refetchInterval: running ? 7000 : 15000 },
  });

  const { data: goods, isLoading: goodsLoading } = useListGoods({
    query: { queryKey: getListGoodsQueryKey(), refetchInterval: running ? 7000 : 15000 },
  });

  const bizGroups = useMemo<BizGroup[]>(() => {
    if (!businesses?.length) return [];
    const map = new Map<string, BizItem[]>();
    for (const b of businesses) {
      const key = getBizGroupKey(b, bizGroupBy);
      const arr = map.get(key) ?? [];
      arr.push(b);
      map.set(key, arr);
    }
    return Array.from(map.entries()).map(([label, members]) => {
      const profitable = members.filter(b => b.balance > 0);
      return {
        label,
        count: members.length,
        profitablePct: Math.round((profitable.length / members.length) * 100),
        avgBalance: Math.round(members.reduce((s, b) => s + b.balance, 0) / members.length),
        totalEmployees: members.reduce((s, b) => s + b.employeeCount, 0),
        avgProduction: Math.round(members.reduce((s, b) => s + b.productionRate, 0) / members.length * 10) / 10,
        lossCount: members.filter(b => b.balance < 0).length,
      };
    });
  }, [businesses, bizGroupBy]);

  const sortedBizGroups = useMemo(() => {
    return [...bizGroups].sort((a, b) => {
      const av = a[bizSortCol] as number | string;
      const bv = b[bizSortCol] as number | string;
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return bizSortDir === "desc" ? -cmp : cmp;
    });
  }, [bizGroups, bizSortCol, bizSortDir]);

  const goodsWithRatio = useMemo(() => {
    if (!goods) return [];
    return goods.map(g => ({
      ...g,
      ratio: g.supply > 0 ? g.demand / g.supply : 999,
      priceDiff: g.currentPrice - g.basePrice,
      priceDiffPct: g.basePrice > 0 ? ((g.currentPrice - g.basePrice) / g.basePrice) * 100 : 0,
    }));
  }, [goods]);

  const sortedGoods = useMemo(() => {
    return [...goodsWithRatio].sort((a, b) => {
      const av = a[goodSortCol as keyof typeof a] as number | string;
      const bv = b[goodSortCol as keyof typeof b] as number | string;
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return goodSortDir === "desc" ? -cmp : cmp;
    });
  }, [goodsWithRatio, goodSortCol, goodSortDir]);

  const summaryStats = useMemo(() => {
    const biz = businesses ?? [];
    const gds = goodsWithRatio;
    const profitable = biz.filter(b => b.balance > 0).length;
    const totalBal = biz.reduce((s, b) => s + b.balance, 0);
    const mostDemanded = [...gds].sort((a, b) => b.demand - a.demand)[0];
    const mostShort = [...gds].sort((a, b) => b.ratio - a.ratio)[0];
    const topQuality = [...gds].sort((a, b) => b.quality - a.quality)[0];
    const avgQuality = gds.length > 0 ? gds.reduce((s, g) => s + g.quality, 0) / gds.length : 0;
    return { profitable, totalBal, mostDemanded, mostShort, topQuality, avgQuality };
  }, [businesses, goodsWithRatio]);

  const maxAvgBalance = sortedBizGroups.length ? Math.max(...sortedBizGroups.map(g => Math.abs(g.avgBalance))) || 1 : 1;

  const handleBizSort = (col: BizSortCol) => {
    if (bizSortCol === col) setBizSortDir(d => d === "asc" ? "desc" : "asc");
    else { setBizSortCol(col); setBizSortDir("desc"); }
  };
  const handleGoodSort = (col: GoodSortCol) => {
    if (goodSortCol === col) setGoodSortDir(d => d === "asc" ? "desc" : "asc");
    else { setGoodSortCol(col); setGoodSortDir("desc"); }
  };

  const BSortIcon = ({ col }: { col: BizSortCol }) =>
    bizSortCol !== col ? <span className="w-3 h-3 inline-block opacity-0" /> :
      bizSortDir === "asc" ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />;

  const GSortIcon = ({ col }: { col: GoodSortCol }) =>
    goodSortCol !== col ? <span className="w-3 h-3 inline-block opacity-0" /> :
      goodSortDir === "asc" ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-foreground">Экономика</h1>
            {running && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold tracking-wider bg-[hsl(173,80%,40%)]/15 text-[hsl(173,80%,40%)] border border-[hsl(173,80%,40%)]/25">
                <span className="w-1.5 h-1.5 rounded-full bg-[hsl(173,80%,40%)] animate-pulse inline-block" />
                LIVE
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {businesses?.length ?? 0} бизнесов · {goods?.length ?? 0} товаров
          </p>
        </div>
        <div className="flex items-center bg-secondary border border-border rounded overflow-hidden">
          <button
            onClick={() => setViewMode("table")}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors",
              viewMode === "table"
                ? "bg-[hsl(173,80%,40%)]/15 text-[hsl(173,80%,40%)]"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Table2 className="w-3.5 h-3.5" />
            Таблица
          </button>
          <button
            onClick={() => setViewMode("analysis")}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors",
              viewMode === "analysis"
                ? "bg-[hsl(173,80%,40%)]/15 text-[hsl(173,80%,40%)]"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <BarChart2 className="w-3.5 h-3.5" />
            Анализ
          </button>
        </div>
      </div>

      {viewMode === "table" && (
        <>
          <BizTable businesses={businesses ?? []} loading={bizLoading} />
          <GoodsTable goods={goods ?? []} loading={goodsLoading} />
        </>
      )}

      {viewMode === "analysis" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <SmCard label="Прибыльных бизнесов" value={`${summaryStats.profitable} / ${businesses?.length ?? 0}`} color="hsl(173,80%,40%)" />
            <SmCard label="Общий баланс рынка" value={summaryStats.totalBal.toLocaleString()} color={summaryStats.totalBal >= 0 ? "hsl(173,80%,40%)" : "hsl(348,83%,52%)"} />
            <SmCard label="Дефицит (спрос/пред.)" value={summaryStats.mostShort ? `${summaryStats.mostShort.name} ×${summaryStats.mostShort.ratio.toFixed(1)}` : "—"} color="hsl(348,83%,52%)" />
          </div>
          {/* Quality summary row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <SmCard label="Ср. качество товаров" value={summaryStats.avgQuality.toFixed(1)} color={summaryStats.avgQuality > 70 ? "hsl(173,80%,40%)" : summaryStats.avgQuality > 40 ? "hsl(43,100%,50%)" : "hsl(348,83%,52%)"} />
            <SmCard label="Лучший товар (качество)" value={summaryStats.topQuality ? `${summaryStats.topQuality.name} — ${summaryStats.topQuality.quality.toFixed(1)}` : "—"} color="hsl(173,80%,40%)" />
            <SmCard label="Самый востребованный" value={summaryStats.mostDemanded?.name ?? "—"} color="hsl(43,100%,50%)" />
          </div>

          <div className="bg-card border border-card-border rounded overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-wrap">
              <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Бизнесы по группам</span>
              <div className="ml-auto flex items-center gap-1">
                {BIZ_GROUP_OPTIONS.map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => setBizGroupBy(opt.key)}
                    className={cn(
                      "px-2.5 py-1 rounded text-[10px] font-medium border transition-colors",
                      bizGroupBy === opt.key
                        ? "bg-primary/15 border-primary/40 text-primary"
                        : "bg-transparent border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground"
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  {([
                    ["label",         "Группа",           "text-left"],
                    ["count",         "Кол-во",           "text-right"],
                    ["profitablePct", "Прибыльных, %",    "text-right"],
                    ["avgBalance",    "Ср. баланс",       "text-right"],
                    ["totalEmployees","Сотрудников",      "text-right"],
                    ["avgProduction", "Ср. производство", "text-right"],
                  ] as [BizSortCol, string, string][]).map(([col, label, align]) => (
                    <th
                      key={col}
                      onClick={() => handleBizSort(col)}
                      className={cn("px-3 py-2.5 text-[10px] font-medium tracking-widest uppercase text-muted-foreground cursor-pointer hover:text-foreground select-none", align)}
                    >
                      {label} <BSortIcon col={col} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedBizGroups.map((g, i) => (
                  <tr key={g.label} className={cn("border-b border-border/50", i % 2 === 0 ? "" : "bg-muted/10")}>
                    <td className="px-3 py-2.5 font-medium text-foreground">{g.label}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-foreground">{g.count}</td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-14 h-1.5 bg-muted rounded-full overflow-hidden hidden sm:block">
                          <div className="h-full rounded-full bg-[hsl(173,80%,40%)]" style={{ width: `${g.profitablePct}%` }} />
                        </div>
                        <span className={cn("tabular-nums font-medium", g.profitablePct >= 60 ? "text-[hsl(173,80%,40%)]" : g.profitablePct >= 30 ? "text-[hsl(43,100%,50%)]" : "text-[hsl(348,83%,52%)]")}>
                          {g.profitablePct}%
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-14 h-1.5 bg-muted rounded-full overflow-hidden hidden sm:block relative">
                          <div
                            className="h-full absolute right-0 rounded-full"
                            style={{
                              width: `${maxAvgBalance > 0 ? (Math.abs(g.avgBalance) / maxAvgBalance) * 100 : 0}%`,
                              background: g.avgBalance >= 0 ? "hsl(173,80%,40%)" : "hsl(348,83%,52%)",
                            }}
                          />
                        </div>
                        <span className={cn("tabular-nums font-medium", g.avgBalance >= 0 ? "text-[hsl(173,80%,40%)]" : "text-[hsl(348,83%,52%)]")}>
                          {g.avgBalance.toLocaleString()}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-foreground">{g.totalEmployees}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{g.avgProduction}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="p-4 border-t border-border space-y-2">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-3">Ср. баланс по группам</p>
              {[...sortedBizGroups].sort((a, b) => b.avgBalance - a.avgBalance).map(g => (
                <div key={g.label} className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground w-36 shrink-0 truncate">{g.label}</span>
                  <div className="flex-1 flex items-center">
                    <div className="flex-1 h-4 bg-muted/30 rounded overflow-hidden">
                      <div
                        className="h-full rounded transition-all duration-500"
                        style={{
                          width: `${maxAvgBalance > 0 ? (Math.abs(g.avgBalance) / maxAvgBalance) * 100 : 0}%`,
                          background: g.avgBalance >= 0 ? "hsl(173,80%,40%)" : "hsl(348,83%,52%)",
                          opacity: 0.7,
                        }}
                      />
                    </div>
                  </div>
                  <span className={cn("text-xs tabular-nums font-medium w-20 text-right shrink-0", g.avgBalance >= 0 ? "text-[hsl(173,80%,40%)]" : "text-[hsl(348,83%,52%)]")}>
                    {g.avgBalance.toLocaleString()}
                  </span>
                  <span className="text-[10px] text-muted-foreground w-10 text-right shrink-0 hidden sm:block">
                    {g.lossCount > 0 ? `${g.lossCount} убыт.` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-card border border-card-border rounded overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
              <Package className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Рынок товаров</span>
              <span className="ml-2 text-[10px] text-muted-foreground/60">· нажмите на заголовок для сортировки</span>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  {([
                    ["name",         "Товар",          "text-left"],
                    ["quality",      "Качество",       "text-right"],
                    ["ratio",        "Спрос/Пред.",    "text-right"],
                    ["demand",       "Спрос",          "text-right"],
                    ["supply",       "Предложение",    "text-right"],
                    ["currentPrice", "Цена",           "text-right"],
                    ["priceDiff",    "Δ к базе",       "text-right"],
                  ] as [GoodSortCol, string, string][]).map(([col, label, align]) => (
                    <th
                      key={col}
                      onClick={() => handleGoodSort(col)}
                      className={cn("px-3 py-2.5 text-[10px] font-medium tracking-widest uppercase text-muted-foreground cursor-pointer hover:text-foreground select-none", align)}
                    >
                      {label} <GSortIcon col={col} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedGoods.map((g, i) => {
                  const shortage = g.ratio > 1.2;
                  const surplus  = g.ratio < 0.8;
                  return (
                    <tr key={g.id} className={cn("border-b border-border/50", i % 2 === 0 ? "" : "bg-muted/10")}>
                      <td className="px-3 py-2.5 font-medium text-foreground">{g.name}</td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {/* Quality bar */}
                          <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden hidden sm:block">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{
                                width: `${g.quality}%`,
                                background: g.quality > 70 ? "hsl(173,80%,40%)" : g.quality > 40 ? "hsl(43,100%,50%)" : "hsl(348,83%,52%)",
                              }}
                            />
                          </div>
                          <span className={cn("tabular-nums font-semibold text-xs", g.quality > 70 ? "text-[hsl(173,80%,40%)]" : g.quality > 40 ? "text-[hsl(43,100%,50%)]" : "text-[hsl(348,83%,52%)]")}>
                            {g.quality.toFixed(1)}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-16 h-2 bg-muted rounded-full overflow-hidden hidden sm:flex">
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{
                                width: `${Math.min(g.ratio * 50, 100)}%`,
                                background: shortage ? "hsl(348,83%,52%)" : surplus ? "hsl(210,100%,55%)" : "hsl(173,80%,40%)",
                              }}
                            />
                          </div>
                          <span className={cn("tabular-nums font-semibold", shortage ? "text-[hsl(348,83%,52%)]" : surplus ? "text-[hsl(210,100%,55%)]" : "text-[hsl(173,80%,40%)]")}>
                            {g.ratio >= 999 ? "∞" : g.ratio.toFixed(2)}
                            {shortage && " ↑"}
                            {surplus  && " ↓"}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[hsl(43,100%,50%)]">{g.demand.toFixed(1)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[hsl(210,100%,50%)]">{g.supply.toFixed(1)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-foreground">{g.currentPrice.toFixed(2)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        <span className={g.priceDiff > 0 ? "text-[hsl(348,83%,52%)]" : g.priceDiff < 0 ? "text-[hsl(173,80%,40%)]" : "text-muted-foreground"}>
                          {g.priceDiff > 0 ? "+" : ""}{g.priceDiff.toFixed(2)}
                          <span className="text-[9px] ml-1 opacity-70">({g.priceDiffPct > 0 ? "+" : ""}{g.priceDiffPct.toFixed(1)}%)</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Production chain visualization */}
          {(() => {
            const bizArr = businesses ?? [];
            const farms     = bizArr.filter(b => b.type === "farm");
            const workshops = bizArr.filter(b => b.type === "workshop");
            const foods     = bizArr.filter(b => b.type === "food");
            const services  = bizArr.filter(b => b.type === "service");
            if (farms.length === 0 && workshops.length === 0) return null;

            const avgBal = (arr: BizItem[]) =>
              arr.length > 0 ? Math.round(arr.reduce((s, b) => s + b.balance, 0) / arr.length) : 0;
            const profitPct = (arr: BizItem[]) =>
              arr.length > 0 ? Math.round((arr.filter(b => b.balance > 0).length / arr.length) * 100) : 0;

            const chains: { rawLabel: string; rawColor: string; rawIcon: React.ReactNode; consLabel: string; consColor: string; consIcon: React.ReactNode; rawBiz: BizItem[]; consBiz: BizItem[] }[] = [
              {
                rawLabel: "Фермы",     rawColor: "hsl(84,70%,45%)",    rawIcon: <Tractor className="w-3.5 h-3.5" />,
                consLabel: "Продукты", consColor: "hsl(43,100%,50%)",  consIcon: <Utensils className="w-3.5 h-3.5" />,
                rawBiz: farms, consBiz: foods,
              },
              {
                rawLabel: "Мастерские", rawColor: "hsl(200,80%,50%)",   rawIcon: <Wrench className="w-3.5 h-3.5" />,
                consLabel: "Сервис",    consColor: "hsl(173,80%,40%)",  consIcon: <Hammer className="w-3.5 h-3.5" />,
                rawBiz: workshops, consBiz: services,
              },
            ];

            return (
              <div className="bg-card border border-card-border rounded overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
                  <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Производственные цепочки</span>
                </div>
                <div className="p-4 space-y-6">
                  {chains.map(chain => {
                    const rawAvg  = avgBal(chain.rawBiz);
                    const consAvg = avgBal(chain.consBiz);
                    const rawProfit  = profitPct(chain.rawBiz);
                    const consProfit = profitPct(chain.consBiz);
                    return (
                      <div key={chain.rawLabel}>
                        <div className="flex items-stretch gap-0">
                          {/* Raw producer node */}
                          <div className="flex-1 border border-border rounded-l p-3 space-y-1.5" style={{ borderColor: chain.rawColor + "40" }}>
                            <div className="flex items-center gap-1.5" style={{ color: chain.rawColor }}>
                              {chain.rawIcon}
                              <span className="text-[11px] font-semibold">{chain.rawLabel}</span>
                              <span className="ml-auto text-[10px] font-mono text-muted-foreground">{chain.rawBiz.length} бизн.</span>
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              Ср. баланс: <span className={cn("font-mono font-semibold", rawAvg >= 0 ? "text-[hsl(173,80%,40%)]" : "text-[hsl(348,83%,52%)]")}>{rawAvg.toLocaleString()}</span>
                            </div>
                            <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${rawProfit}%`, background: chain.rawColor, opacity: 0.8 }} />
                            </div>
                            <div className="text-[9px] text-muted-foreground">{rawProfit}% прибыльных</div>
                          </div>

                          {/* Arrow */}
                          <div className="flex items-center justify-center px-2 border-t border-b border-border bg-muted/10">
                            <div className="flex flex-col items-center gap-0.5">
                              <ArrowRight className="w-4 h-4 text-muted-foreground/50" />
                              <span className="text-[8px] text-muted-foreground/40 font-mono">B2B</span>
                            </div>
                          </div>

                          {/* Consumer node */}
                          <div className="flex-1 border border-border p-3 space-y-1.5" style={{ borderColor: chain.consColor + "40" }}>
                            <div className="flex items-center gap-1.5" style={{ color: chain.consColor }}>
                              {chain.consIcon}
                              <span className="text-[11px] font-semibold">{chain.consLabel}</span>
                              <span className="ml-auto text-[10px] font-mono text-muted-foreground">{chain.consBiz.length} бизн.</span>
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              Ср. баланс: <span className={cn("font-mono font-semibold", consAvg >= 0 ? "text-[hsl(173,80%,40%)]" : "text-[hsl(348,83%,52%)]")}>{consAvg.toLocaleString()}</span>
                            </div>
                            <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${consProfit}%`, background: chain.consColor, opacity: 0.8 }} />
                            </div>
                            <div className="text-[9px] text-muted-foreground">{consProfit}% прибыльных</div>
                          </div>

                          {/* Arrow */}
                          <div className="flex items-center justify-center px-2 border-t border-b border-border bg-muted/10">
                            <div className="flex flex-col items-center gap-0.5">
                              <ArrowRight className="w-4 h-4 text-muted-foreground/50" />
                              <span className="text-[8px] text-muted-foreground/40 font-mono">B2C</span>
                            </div>
                          </div>

                          {/* End consumer */}
                          <div className="flex items-center px-4 border border-border rounded-r bg-muted/10" style={{ borderColor: "hsl(173,80%,40%)40" }}>
                            <div className="text-center space-y-1">
                              <div className="text-[11px] font-semibold text-[hsl(173,80%,40%)]">Агенты</div>
                              <div className="text-[9px] text-muted-foreground font-mono">потребители</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

        </div>
      )}
    </div>
  );
}

function SmCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-card border border-card-border rounded px-3 py-2.5">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">{label}</p>
      <p className="text-sm font-semibold leading-tight" style={{ color }}>{value}</p>
    </div>
  );
}

function BizTable({ businesses, loading }: { businesses: BizItem[]; loading: boolean }) {
  return (
    <div className="bg-card border border-card-border rounded overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Бизнесы</span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/20">
            <th className="text-left px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground">Название</th>
            <th className="text-left px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground">Тип</th>
            <th className="text-right px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground">Баланс</th>
            <th className="text-right px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground">Сотрудники</th>
            <th className="text-right px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground">Нанято/Уволено</th>
            <th className="text-right px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground">Продуктивность</th>
            <th className="text-right px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground">Производство/тик</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 8 }).map((_, i) => (
              <tr key={i} className="border-b border-border/50">
                {Array.from({ length: 7 }).map((_, j) => (
                  <td key={j} className="px-3 py-2"><div className="h-3 bg-muted rounded animate-pulse" /></td>
                ))}
              </tr>
            ))
          ) : businesses.map(biz => {
            const struggling = biz.balance < 0;
            return (
              <tr key={biz.id} className={cn("border-b border-border/50 hover:bg-accent/20", struggling && "bg-[hsl(348,83%,47%)]/5")}>
                <td className="px-3 py-2 font-medium text-foreground">
                  <span className="flex items-center gap-1.5">
                    {biz.name}
                    {struggling && (
                      <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-semibold tracking-wider bg-[hsl(348,83%,47%)]/15 text-[hsl(348,83%,47%)] border border-[hsl(348,83%,47%)]/25">
                        <TrendingDown className="w-2.5 h-2.5" />
                        УБЫТОК
                      </span>
                    )}
                  </span>
                </td>
                <td className={cn("px-3 py-2 font-medium", TYPE_COLORS[biz.type] ?? "text-muted-foreground")}>
                  {TYPE_LABELS[biz.type] ?? biz.type}
                </td>
                <td className={cn("px-3 py-2 text-right tabular-nums font-medium", struggling ? "text-[hsl(348,83%,47%)]" : "text-[hsl(173,80%,40%)]")}>
                  {biz.balance.toFixed(0)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-foreground">
                  {biz.employeeCount}
                  {biz.maxEmployees != null && (
                    <span className="text-muted-foreground/60 text-xs ml-0.5">/{biz.maxEmployees}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <span className="flex items-center justify-end gap-2">
                    {biz.hiredThisTick > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-[hsl(173,80%,40%)]">
                        <UserPlus className="w-3 h-3" />{biz.hiredThisTick}
                      </span>
                    )}
                    {biz.firedThisTick > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-[hsl(348,83%,47%)]">
                        <UserMinus className="w-3 h-3" />{biz.firedThisTick}
                      </span>
                    )}
                    {biz.hiredThisTick === 0 && biz.firedThisTick === 0 && (
                      <span className="text-muted-foreground/40">—</span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {biz.productivityLevel > 0 ? (
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[hsl(45,93%,47%)]/10 text-[hsl(45,93%,47%)] border border-[hsl(45,93%,47%)]/20">
                      Lv.{biz.productivityLevel}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{biz.productionRate.toFixed(1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GoodsTable({ goods, loading }: { goods: GoodItem[]; loading: boolean }) {
  return (
    <div className="bg-card border border-card-border rounded overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Package className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Товары</span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/20">
            <th className="text-left px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground">Товар</th>
            <th className="text-right px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground">Баз. цена</th>
            <th className="text-right px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground">Текущая цена</th>
            <th className="text-right px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground">Качество</th>
            <th className="text-right px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground">Спрос</th>
            <th className="text-right px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground">Предложение</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 8 }).map((_, i) => (
              <tr key={i} className="border-b border-border/50">
                {Array.from({ length: 6 }).map((_, j) => (
                  <td key={j} className="px-3 py-2"><div className="h-3 bg-muted rounded animate-pulse" /></td>
                ))}
              </tr>
            ))
          ) : goods.map(good => {
            const priceDiff = good.currentPrice - good.basePrice;
            const pricePct = good.basePrice > 0 ? (priceDiff / good.basePrice) * 100 : 0;
            const isUp = priceDiff > 0.01;
            const isDown = priceDiff < -0.01;
            const demandSupplyRatio = good.supply > 0 ? good.demand / good.supply : 999;
            return (
              <tr key={good.id} className="border-b border-border/50 hover:bg-accent/20">
                <td className="px-3 py-2 font-medium text-foreground">{good.name}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{good.basePrice.toFixed(2)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  <div className="flex items-center justify-end gap-1">
                    <span className={isUp ? "text-[hsl(348,83%,47%)]" : isDown ? "text-[hsl(173,80%,40%)]" : "text-foreground"}>
                      {good.currentPrice.toFixed(2)}
                    </span>
                    <span className={`text-[10px] font-medium tabular-nums ${isUp ? "text-[hsl(348,83%,47%)]" : isDown ? "text-[hsl(173,80%,40%)]" : "text-muted-foreground"}`}>
                      {isUp ? "▲" : isDown ? "▼" : "–"}{Math.abs(pricePct).toFixed(1)}%
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <div className="w-10 h-1.5 bg-muted rounded-full overflow-hidden hidden sm:block">
                      <div className="h-full rounded-full" style={{ width: `${good.quality}%`, background: good.quality > 70 ? "hsl(173,80%,40%)" : good.quality > 40 ? "hsl(43,100%,50%)" : "hsl(348,83%,52%)" }} />
                    </div>
                    <span className={cn("tabular-nums text-xs", good.quality > 70 ? "text-[hsl(173,80%,40%)]" : good.quality > 40 ? "text-[hsl(43,100%,50%)]" : "text-[hsl(348,83%,52%)]")}>
                      {good.quality.toFixed(1)}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-[hsl(43,100%,50%)]">
                  {good.demand.toFixed(1)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  <span className={demandSupplyRatio > 1.5 ? "text-[hsl(348,83%,47%)]" : demandSupplyRatio < 0.7 ? "text-[hsl(173,80%,40%)]" : "text-[hsl(210,100%,50%)]"}>
                    {good.supply.toFixed(1)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
