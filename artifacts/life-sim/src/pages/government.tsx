import {
  useGetGovernment,
  getGetGovernmentQueryKey,
  useListBusinesses,
  getListBusinessesQueryKey,
} from "@workspace/api-client-react";
import { Landmark, TrendingDown, TrendingUp, Percent, ShieldCheck, BookOpen, TreePine, Star, Briefcase, AlertTriangle } from "lucide-react";
import StatCard from "@/components/stat-card";
import { cn } from "@/lib/utils";

export default function GovernmentPage() {
  const { data: gov, isLoading } = useGetGovernment({
    query: { queryKey: getGetGovernmentQueryKey(), refetchInterval: 15000 },
  });
  const { data: businesses } = useListBusinesses({
    query: { queryKey: getListBusinessesQueryKey(), refetchInterval: 30000 },
  });

  const schools = businesses?.filter(b => b.type === "school") ?? [];
  const parks = businesses?.filter(b => b.type === "park") ?? [];
  const temples = businesses?.filter(b => b.type === "temple") ?? [];

  const unemploymentHigh = gov ? gov.unemploymentRatePct >= gov.grantThresholdPct : false;

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-base font-semibold text-foreground">Государство</h1>
        <p className="text-xs text-muted-foreground mt-0.5">Бюджет, налоги, субсидии и гранты</p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 bg-card border border-card-border rounded animate-pulse" />
          ))}
        </div>
      ) : gov ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label="Бюджет"
              value={gov.budget.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              sub="единиц"
              icon={Landmark}
              accent="teal"
            />
            <StatCard
              label="Всего собрано налогов"
              value={gov.totalTaxCollected.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              sub="за всё время"
              icon={TrendingUp}
              accent="blue"
            />
            <StatCard
              label="Субсидии выплачено"
              value={gov.totalSubsidiesPaid.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              sub="за всё время"
              icon={TrendingDown}
              accent="crimson"
            />
            <StatCard
              label="Пенсии выплачено"
              value={gov.totalPensionPaid.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              sub="за всё время"
              icon={ShieldCheck}
              accent="amber"
            />
            <StatCard
              label="Ставка налога"
              value={`${(gov.taxRate * 100).toFixed(1)}%`}
              sub={`от дохода агентов`}
              icon={Percent}
              accent="amber"
            />
            <StatCard
              label="Гранты выданы"
              value={gov.totalGrantsPaid.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              sub={gov.grantsIssuedLastDay > 0 ? `вчера: ${gov.grantsIssuedLastDay} грант${gov.grantsIssuedLastDay > 1 ? "а" : ""}` : "за всё время"}
              icon={Briefcase}
              accent="teal"
            />
          </div>

          {/* Government Grants Panel */}
          <div className={cn(
            "bg-card border rounded p-4 space-y-3",
            unemploymentHigh ? "border-[hsl(348,83%,47%)]/40 bg-[hsl(348,83%,47%)]/5" : "border-card-border"
          )}>
            <div className="flex items-center justify-between">
              <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">
                Гранты на открытие бизнеса
              </h2>
              {unemploymentHigh && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-semibold bg-[hsl(348,83%,47%)]/15 text-[hsl(348,83%,47%)] border border-[hsl(348,83%,47%)]/25">
                  <AlertTriangle className="w-2.5 h-2.5" />
                  АКТИВНО
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-4 text-xs">
              <div className="space-y-1">
                <p className="text-muted-foreground">Безработица сейчас</p>
                <p className={cn("font-semibold text-base tabular-nums", unemploymentHigh ? "text-[hsl(348,83%,47%)]" : "text-foreground")}>
                  {gov.unemploymentRatePct.toFixed(1)}%
                </p>
                <p className="text-[10px] text-muted-foreground">
                  порог выдачи ≥ {gov.grantThresholdPct}%
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground">Размер гранта</p>
                <p className="font-semibold text-base text-foreground tabular-nums">3 000 ед.</p>
                <p className="text-[10px] text-muted-foreground">стартовый капитал бизнеса</p>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground">Вчера выдано</p>
                <p className={cn("font-semibold text-base tabular-nums", gov.grantsIssuedLastDay > 0 ? "text-[hsl(45,93%,47%)]" : "text-muted-foreground/60")}>
                  {gov.grantsIssuedLastDay} / 3
                </p>
                <p className="text-[10px] text-muted-foreground">макс. 3 гранта в день</p>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground leading-relaxed border-t border-border/50 pt-2">
              При безработице выше {gov.grantThresholdPct}% государство выдаёт гранты самым активным безработным агентам — они открывают кафе или сервисные предприятия и сразу трудоустраиваются.
            </p>
          </div>

          <div className="bg-card border border-card-border rounded p-4 space-y-4">
            <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Параметры</h2>
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div className="space-y-1">
                <p className="text-muted-foreground">Размер субсидии</p>
                <p className="font-medium text-foreground text-base">{gov.subsidyAmount.toFixed(0)} ед.</p>
                <p className="text-[10px] text-muted-foreground">выплачивается агентам с нулевым балансом за тик</p>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground">Налоговая ставка</p>
                <p className="font-medium text-foreground text-base">{(gov.taxRate * 100).toFixed(1)}%</p>
                <p className="text-[10px] text-muted-foreground">удерживается с каждой зарплаты</p>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground">Пенсионная ставка</p>
                <p className="font-medium text-foreground text-base">{(gov.pensionRate * 100).toFixed(0)}%</p>
                <p className="text-[10px] text-muted-foreground">от базовой зарплаты выплачивается пенсионерам за тик</p>
              </div>
            </div>
          </div>

          <div className="bg-card border border-card-border rounded p-4 space-y-3">
            <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Публичные службы</h2>
            <div className="grid grid-cols-3 gap-3 text-xs">
              <div className="flex flex-col items-center gap-1.5 p-3 bg-[hsl(270,70%,60%)]/5 border border-[hsl(270,70%,60%)]/20 rounded">
                <BookOpen className="w-4 h-4 text-[hsl(270,70%,60%)]" />
                <span className="text-muted-foreground">Школы</span>
                <span className="text-lg font-bold text-[hsl(270,70%,60%)]">{schools.length}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {schools.reduce((s, b) => s + b.employeeCount, 0)} сотр.
                </span>
              </div>
              <div className="flex flex-col items-center gap-1.5 p-3 bg-[hsl(120,60%,45%)]/5 border border-[hsl(120,60%,45%)]/20 rounded">
                <TreePine className="w-4 h-4 text-[hsl(120,60%,45%)]" />
                <span className="text-muted-foreground">Парки</span>
                <span className="text-lg font-bold text-[hsl(120,60%,45%)]">{parks.length}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {parks.reduce((s, b) => s + b.employeeCount, 0)} сотр.
                </span>
              </div>
              <div className="flex flex-col items-center gap-1.5 p-3 bg-[hsl(35,90%,55%)]/5 border border-[hsl(35,90%,55%)]/20 rounded">
                <Star className="w-4 h-4 text-[hsl(35,90%,55%)]" />
                <span className="text-muted-foreground">Храмы</span>
                <span className="text-lg font-bold text-[hsl(35,90%,55%)]">{temples.length}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {temples.reduce((s, b) => s + b.employeeCount, 0)} сотр.
                </span>
              </div>
            </div>
          </div>

          <div className="bg-card border border-card-border rounded p-4">
            <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground mb-3">Баланс</h2>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between py-1 border-b border-border/50">
                <span className="text-muted-foreground">Собрано налогов</span>
                <span className="text-[hsl(173,80%,40%)] tabular-nums">+{gov.totalTaxCollected.toFixed(0)}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-border/50">
                <span className="text-muted-foreground">Выплачено субсидий</span>
                <span className="text-[hsl(348,83%,47%)] tabular-nums">-{gov.totalSubsidiesPaid.toFixed(0)}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-border/50">
                <span className="text-muted-foreground">Выплачено пенсий</span>
                <span className="text-[hsl(348,83%,47%)] tabular-nums">-{gov.totalPensionPaid.toFixed(0)}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-border/50">
                <span className="text-muted-foreground">Финансирование публичных служб</span>
                <span className="text-[hsl(348,83%,47%)] tabular-nums">-{gov.totalPublicServicesPaid.toFixed(0)}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-border/50">
                <span className="text-muted-foreground">Гранты на открытие бизнеса</span>
                <span className="text-[hsl(348,83%,47%)] tabular-nums">-{gov.totalGrantsPaid.toFixed(0)}</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="font-medium text-foreground">Итого бюджет</span>
                <span className={`tabular-nums font-medium ${gov.budget >= 0 ? "text-[hsl(173,80%,40%)]" : "text-[hsl(348,83%,47%)]"}`}>
                  {gov.budget.toFixed(0)}
                </span>
              </div>
            </div>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Нет данных</p>
      )}
    </div>
  );
}
