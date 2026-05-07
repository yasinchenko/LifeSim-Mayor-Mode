import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, Bug } from "lucide-react";

interface TickDebugReport {
  tick: number;
  elapsedMs: number;
  computedAt: number;
  agents: {
    processed: number;
    skipped: number;
    actions: { work: number; eat: number; rest: number; sleep: number; heal: number; socialize: number; idle: number; study?: number; relax?: number; pray?: number };
    moneyIn: number;
    moneyOut: number;
  };
  businesses: {
    total: number;
    active: number;
    unprofitable: number;
    staffless: number;
    employed: number;
    hired: number;
    fired: number;
    balanceBefore: number;
    balanceAfter: number;
    wagesPaid: number;
  };
  government: {
    budgetBefore: number;
    budgetAfter: number;
    taxRevenue: number;
    pensionsPaid: number;
    subsidiesPaid: number;
    pensionRecipients: number;
    subsidyRecipients: number;
  };
  market: {
    totalDemand: number;
    totalSupply: number;
    avgPrice: number;
    priceChangePct: number;
    bigPriceSpikes: number;
    successfulPurchases: number;
    failedNoGoods: number;
    failedNoMoney: number;
  };
  integrity: {
    negativeMoneyAgents: number;
    nanValues: number;
    totalMoneyAgents: number;
    totalMoneyBusinesses: number;
    governmentBudget: number;
    orphanedGoods: number;
  };
  chain?: {
    b2bSuccess: number;
    b2bFail: number;
    farmSupplyTotal: number;
    workshopSupplyTotal: number;
    foodSupplyTotal: number;
    serviceSupplyTotal: number;
  };
}

function fmt(n: number, prefix = ""): string {
  if (Math.abs(n) >= 1_000_000) return `${prefix}${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${prefix}${(n / 1_000).toFixed(1)}K`;
  return `${prefix}${n}`;
}

function Row({ label, value, accent, dimLabel }: { label: string; value: string | number; accent?: "teal" | "amber" | "crimson" | "neutral"; dimLabel?: boolean }) {
  const accentClass = {
    teal: "text-[hsl(173,80%,40%)]",
    amber: "text-[hsl(43,100%,50%)]",
    crimson: "text-[hsl(348,83%,47%)]",
    neutral: "text-foreground",
  }[accent ?? "neutral"];

  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className={cn("text-[11px] font-mono", dimLabel ? "text-muted-foreground/60" : "text-muted-foreground")}>{label}</span>
      <span className={cn("text-[11px] font-mono font-semibold tabular-nums", accentClass)}>{value}</span>
    </div>
  );
}

function Section({ title, children, color = "teal" }: { title: string; children: React.ReactNode; color?: "teal" | "amber" | "crimson" | "blue" }) {
  const borderColor = {
    teal: "border-[hsl(173,80%,40%)]/30",
    amber: "border-[hsl(43,100%,50%)]/30",
    crimson: "border-[hsl(348,83%,47%)]/30",
    blue: "border-[hsl(210,100%,56%)]/30",
  }[color];
  const textColor = {
    teal: "text-[hsl(173,80%,40%)]",
    amber: "text-[hsl(43,100%,50%)]",
    crimson: "text-[hsl(348,83%,47%)]",
    blue: "text-[hsl(210,100%,56%)]",
  }[color];

  return (
    <div className={cn("border-l-2 pl-3", borderColor)}>
      <p className={cn("text-[10px] font-mono font-bold tracking-widest uppercase mb-1.5", textColor)}>{title}</p>
      <div className="space-y-0">{children}</div>
    </div>
  );
}

export default function DebugPanel({ running }: { running: boolean }) {
  const [open, setOpen] = useState(false);

  const { data } = useQuery<TickDebugReport>({
    queryKey: ["debug-tick"],
    queryFn: async () => {
      const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const res = await fetch(`${base}/api/debug/tick`);
      if (res.status === 204) return null as unknown as TickDebugReport;
      if (!res.ok) throw new Error("Failed to fetch debug tick");
      return res.json();
    },
    refetchInterval: running && open ? 8000 : false,
    enabled: open,
  });

  const d = data;

  return (
    <div className="border border-card-border rounded bg-card">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-secondary/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Bug className="w-3.5 h-3.5 text-[hsl(173,80%,40%)]" />
          <span className="text-[11px] font-mono font-semibold text-muted-foreground tracking-wider uppercase">
            Debug Tick Report
          </span>
          {d && (
            <span className="text-[10px] font-mono text-muted-foreground/50">
              тик #{d.tick} · {d.elapsedMs}мс
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-card-border">
          {!d ? (
            <p className="text-[11px] font-mono text-muted-foreground/50 py-3 text-center">
              Ожидание первого тика...
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4 mt-3">

              <Section title="Агенты" color="teal">
                <Row label="обработано" value={d.agents.processed} accent="teal" />
                <Row label="пропущено" value={d.agents.skipped} dimLabel />
                <Row label="работа" value={d.agents.actions.work} />
                <Row label="еда" value={d.agents.actions.eat} />
                <Row label="отдых" value={d.agents.actions.rest} />
                <Row label="сон" value={d.agents.actions.sleep ?? 0} />
                <Row label="лечение" value={d.agents.actions.heal ?? 0} />
                <Row label="общение" value={d.agents.actions.socialize} />
                <Row label="учёба" value={d.agents.actions.study ?? 0} />
                <Row label="досуг" value={d.agents.actions.relax ?? 0} />
                <Row label="молитва" value={d.agents.actions.pray ?? 0} />
                <Row label="простой" value={d.agents.actions.idle} />
                <Row label="денег получено" value={`+${fmt(d.agents.moneyIn)}`} accent="teal" />
                <Row label="денег потрачено" value={`-${fmt(d.agents.moneyOut)}`} accent="crimson" />
              </Section>

              <Section title="Бизнес" color="amber">
                <Row label="всего" value={d.businesses.total} />
                <Row label="активные" value={d.businesses.active} accent="teal" />
                <Row label="убыточные" value={d.businesses.unprofitable} accent={d.businesses.unprofitable > 10 ? "crimson" : "neutral"} />
                <Row label="без сотрудников" value={d.businesses.staffless} dimLabel />
                <Row label="занято" value={d.businesses.employed} />
                <Row label="нанято" value={`+${d.businesses.hired}`} accent="teal" />
                <Row label="уволено" value={`-${d.businesses.fired}`} accent={d.businesses.fired > 0 ? "crimson" : "neutral"} />
                <Row label="баланс до" value={fmt(d.businesses.balanceBefore)} dimLabel />
                <Row label="баланс после" value={fmt(d.businesses.balanceAfter)} accent="amber" />
                <Row label="зарплаты выплачено" value={fmt(d.businesses.wagesPaid)} />
              </Section>

              <Section title="Государство" color="blue">
                <Row label="бюджет до" value={fmt(d.government.budgetBefore)} dimLabel />
                <Row label="бюджет после" value={fmt(d.government.budgetAfter)} accent={d.government.budgetAfter >= d.government.budgetBefore ? "teal" : "crimson"} />
                <Row label="налоги" value={`+${fmt(d.government.taxRevenue)}`} accent="teal" />
                <Row label="пенсии" value={`-${fmt(d.government.pensionsPaid)}`} accent="crimson" />
                <Row label="субсидии" value={`-${fmt(d.government.subsidiesPaid)}`} accent="crimson" />
                <Row
                  label="чистый поток"
                  value={`${d.government.budgetAfter - d.government.budgetBefore >= 0 ? "+" : ""}${fmt(d.government.budgetAfter - d.government.budgetBefore)}`}
                  accent={d.government.budgetAfter >= d.government.budgetBefore ? "teal" : "crimson"}
                />
                <Row label="пенсионеры" value={`${d.government.pensionRecipients} чел.`} dimLabel />
                <Row label="субсидии получили" value={`${d.government.subsidyRecipients} чел.`} dimLabel />
              </Section>

              <Section title="Рынок" color="amber">
                {(() => {
                  const ratio = d.market.totalSupply > 0 ? d.market.totalDemand / d.market.totalSupply : 0;
                  const ratioLabel = ratio > 1.1 ? "дефицит" : ratio < 0.9 ? "профицит" : "баланс";
                  const ratioAccent = ratio > 1.1 ? "crimson" : ratio < 0.9 ? "teal" : "neutral";
                  return (
                    <>
                      <Row label="спрос" value={d.market.totalDemand} />
                      <Row label="предложение" value={d.market.totalSupply} />
                      <Row label={`коэф (${ratioLabel})`} value={ratio.toFixed(2)} accent={ratioAccent} />
                      <Row label="ср. цена" value={d.market.avgPrice.toFixed(1)} />
                      <Row label="изм. цены" value={`${d.market.priceChangePct >= 0 ? "+" : ""}${d.market.priceChangePct}%`} accent={Math.abs(d.market.priceChangePct) > 5 ? "amber" : "neutral"} />
                      <Row label="скачки >20%" value={d.market.bigPriceSpikes} accent={d.market.bigPriceSpikes > 0 ? "crimson" : "neutral"} />
                      <Row label="покупок успешных" value={d.market.successfulPurchases} accent="teal" />
                      <Row label="нет товара" value={d.market.failedNoGoods} accent={d.market.failedNoGoods > 50 ? "crimson" : "neutral"} dimLabel />
                      <Row label="нет денег" value={d.market.failedNoMoney} accent={d.market.failedNoMoney > 50 ? "amber" : "neutral"} dimLabel />
                    </>
                  );
                })()}
              </Section>

              <Section title="Целостность" color="teal">
                <Row
                  label="отриц. баланс агентов"
                  value={d.integrity.negativeMoneyAgents === 0 ? "OK" : `${d.integrity.negativeMoneyAgents} агентов`}
                  accent={d.integrity.negativeMoneyAgents === 0 ? "teal" : "crimson"}
                />
                <Row
                  label="NaN / Infinity"
                  value={d.integrity.nanValues === 0 ? "OK" : `${d.integrity.nanValues}`}
                  accent={d.integrity.nanValues === 0 ? "teal" : "crimson"}
                />
                <Row
                  label="потерянных товаров"
                  value={d.integrity.orphanedGoods === 0 ? "OK" : `${d.integrity.orphanedGoods}`}
                  accent={d.integrity.orphanedGoods === 0 ? "teal" : "crimson"}
                />
                <Row label="деньги агентов Σ" value={fmt(d.integrity.totalMoneyAgents)} dimLabel />
                <Row label="деньги бизнеса Σ" value={fmt(d.integrity.totalMoneyBusinesses)} dimLabel />
                <Row label="бюджет гос-ва" value={fmt(d.integrity.governmentBudget)} dimLabel />
                <Row
                  label="сумма всего"
                  value={fmt(d.integrity.totalMoneyAgents + d.integrity.totalMoneyBusinesses + d.integrity.governmentBudget)}
                  accent="amber"
                />
              </Section>

              {d.chain && (
                <Section title="Цепочки производства" color="amber">
                  {(() => {
                    const total = d.chain.b2bSuccess + d.chain.b2bFail;
                    const effPct = total > 0 ? Math.round((d.chain.b2bSuccess / total) * 100) : 0;
                    return (
                      <>
                        <Row label="B2B успешных" value={d.chain.b2bSuccess} accent="teal" />
                        <Row label="B2B неудачных" value={d.chain.b2bFail} accent={d.chain.b2bFail > d.chain.b2bSuccess ? "crimson" : "neutral"} />
                        <Row label="эффективность" value={`${effPct}%`} accent={effPct >= 70 ? "teal" : effPct >= 40 ? "amber" : "crimson"} />
                        <Row label="запас ферм" value={d.chain.farmSupplyTotal} dimLabel />
                        <Row label="запас мастерских" value={d.chain.workshopSupplyTotal} dimLabel />
                        <Row label="запас продуктов" value={d.chain.foodSupplyTotal} dimLabel />
                        <Row label="запас услуг" value={d.chain.serviceSupplyTotal} dimLabel />
                      </>
                    );
                  })()}
                </Section>
              )}

            </div>
          )}
        </div>
      )}
    </div>
  );
}
