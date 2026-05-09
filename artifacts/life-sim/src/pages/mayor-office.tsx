import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetGovernmentQueryKey,
  getGetMayorOfficeQueryKey,
  getGetSimulationStateQueryKey,
  getListDistrictsQueryKey,
  useGetGovernment,
  useGetMayorOffice,
  useListDistricts,
  useProvideMayorOfficeService,
  usePurchaseMayorOffice,
  useSkimMayorOfficeCityBudget,
  useSkimMayorOfficeServiceBudget,
  type District,
  type DistrictServiceType,
  type MayorOfficeActionLevel,
  type MayorOfficeOperation,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  ArrowRight,
  BriefcaseBusiness,
  Car,
  Gem,
  HandCoins,
  KeyRound,
  Landmark,
  LockKeyhole,
  Shield,
  Sparkles,
  WalletCards,
} from "lucide-react";
import { toast } from "sonner";
import StatCard from "@/components/stat-card";
import { cn } from "@/lib/utils";

const CITY_LEVELS: Array<{ level: MayorOfficeActionLevel; label: string; note: string }> = [
  { level: "minimal", label: "Мягко", note: "10% резерва" },
  { level: "medium", label: "Существенно", note: "50% резерва" },
  { level: "maximum", label: "Полностью", note: "100% резерва" },
];

const ACTION_LEVELS: Array<{ level: MayorOfficeActionLevel; label: string }> = [
  { level: "minimal", label: "Малый" },
  { level: "medium", label: "Средний" },
  { level: "maximum", label: "Крупный" },
];

const SERVICE_OPTIONS: Array<{ value: DistrictServiceType; label: string }> = [
  { value: "utility", label: "Коммунальная" },
  { value: "police", label: "Полиция" },
  { value: "fire", label: "Пожарные" },
];

const CITY_SKIM_EFFECTS: Record<MayorOfficeActionLevel, {
  share: number;
  corruptionDelta: number;
  residentsReputationDelta: number;
  governmentReputationDelta: number;
}> = {
  minimal: { share: 0.1, corruptionDelta: 2, residentsReputationDelta: -0.5, governmentReputationDelta: -1 },
  medium: { share: 0.5, corruptionDelta: 8, residentsReputationDelta: -2.5, governmentReputationDelta: -4 },
  maximum: { share: 1, corruptionDelta: 15, residentsReputationDelta: -5, governmentReputationDelta: -8 },
};

const SERVICE_SKIM_EFFECTS: Record<MayorOfficeActionLevel, {
  share: number;
  corruptionDelta: number;
  efficiencyPenaltyDelta: number;
  metricPenalty: number;
}> = {
  minimal: { share: 0.1, corruptionDelta: 1.5, efficiencyPenaltyDelta: 0.08, metricPenalty: 2 },
  medium: { share: 0.5, corruptionDelta: 6, efficiencyPenaltyDelta: 0.22, metricPenalty: 6 },
  maximum: { share: 1, corruptionDelta: 12, efficiencyPenaltyDelta: 0.4, metricPenalty: 11 },
};

const DEAL_EFFECTS: Record<string, {
  baseCorruptionDelta: number;
  residentsReputationDelta: number;
  businessTrustDelta: number;
}> = {
  density_development: { baseCorruptionDelta: 2.2, residentsReputationDelta: -1.4, businessTrustDelta: 2 },
  gray_permits: { baseCorruptionDelta: 2, residentsReputationDelta: -1.2, businessTrustDelta: 2.2 },
  commercial_development: { baseCorruptionDelta: 2.1, residentsReputationDelta: -1.8, businessTrustDelta: 1.6 },
  administrative_contract: { baseCorruptionDelta: 2.4, residentsReputationDelta: -1, businessTrustDelta: 1.2 },
  hidden_optimization: { baseCorruptionDelta: 1.8, residentsReputationDelta: -1.4, businessTrustDelta: 1.1 },
};

const DEAL_LEVEL_SCALE: Record<MayorOfficeActionLevel, number> = {
  minimal: 1,
  medium: 2.4,
  maximum: 4.2,
};

function formatMoney(value: number, sign = false): string {
  const prefix = sign && value > 0 ? "+" : "";
  return `${prefix}${Math.round(value).toLocaleString("ru-RU")}`;
}

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

function corruptionTone(value: number) {
  if (value >= 60) return { label: "Критическая сеть", accent: "crimson" as const, className: "text-[hsl(351,72%,75%)]" };
  if (value >= 35) return { label: "Опасная зона", accent: "amber" as const, className: "text-[hsl(38,78%,74%)]" };
  if (value >= 15) return { label: "Заметный след", accent: "purple" as const, className: "text-[hsl(282,52%,78%)]" };
  return { label: "Тихий фон", accent: "teal" as const, className: "text-primary" };
}

function riskTone(risk: string) {
  if (risk === "danger") return { label: "Опасность", accent: "crimson" as const, className: "text-[hsl(351,72%,75%)]" };
  if (risk === "rising") return { label: "Растёт", accent: "amber" as const, className: "text-[hsl(38,78%,74%)]" };
  return { label: "Низкий", accent: "teal" as const, className: "text-primary" };
}

function securityLabel(level: number) {
  if (level >= 3) return "усиленная охрана";
  if (level >= 2) return "профессиональная охрана";
  if (level >= 1) return "частная охрана";
  return "без охраны";
}

function securityDurationLabel(ticks: number) {
  if (ticks <= 0) return "срок не активен";
  const days = Math.floor(ticks / 24);
  const hours = ticks % 24;
  if (days > 0 && hours > 0) return `ещё ${days} дн. ${hours} ч`;
  if (days > 0) return `ещё ${days} дн.`;
  return `ещё ${hours} ч`;
}

function operationTypeLabel(type: MayorOfficeOperation["type"]) {
  if (type === "skim_city_budget") return "Казна";
  if (type === "skim_service_budget") return "Службы";
  if (type === "provide_service") return "Услуга";
  if (type === "purchase") return "Личный контур";
  return "Система";
}

function operationDisplayTitle(operation: MayorOfficeOperation) {
  if (operation.type === "skim_city_budget") return "Перенаправлен резерв города";
  if (operation.type === "skim_service_budget") return operation.title.replace("Вывод из службы:", "Закрыт вопрос со службой:");
  if (operation.type === "provide_service") return operation.title.replace("услуга:", "согласование:");
  if (operation.type === "purchase") return operation.title.replace("Покупка:", "Личный контур:");
  return operation.title;
}

function serviceBudgetEstimate(district: District | undefined, service: DistrictServiceType): number {
  if (!district) return 0;
  return district.services.expenses[service] ?? 0;
}

function formatDelta(value: number, digits = 0): string {
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString("ru-RU", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })}`;
}

export default function MayorOfficePage() {
  const qc = useQueryClient();
  const [serviceDistrictId, setServiceDistrictId] = useState("");
  const [service, setService] = useState<DistrictServiceType>("utility");
  const [selectedDealId, setSelectedDealId] = useState("");

  const { data: office, isLoading } = useGetMayorOffice({
    query: { queryKey: getGetMayorOfficeQueryKey(), refetchInterval: 10000 },
  });
  const { data: gov } = useGetGovernment({
    query: { queryKey: getGetGovernmentQueryKey(), refetchInterval: 15000 },
  });
  const { data: districts } = useListDistricts({
    query: { queryKey: getListDistrictsQueryKey(), refetchInterval: 15000 },
  });

  const districtById = useMemo(() => {
    return new Map((districts ?? []).map(district => [district.id, district]));
  }, [districts]);
  const selectedDistrictId = serviceDistrictId || districts?.[0]?.id || "";

  const invalidateOffice = () => {
    qc.invalidateQueries({ queryKey: getGetMayorOfficeQueryKey() });
    qc.invalidateQueries({ queryKey: getGetGovernmentQueryKey() });
    qc.invalidateQueries({ queryKey: getGetSimulationStateQueryKey() });
    qc.invalidateQueries({ queryKey: getListDistrictsQueryKey() });
  };

  const skimCity = useSkimMayorOfficeCityBudget({
    mutation: {
      onSuccess: () => {
        invalidateOffice();
        toast.success("Оффшор пополнен из свободного бюджета");
      },
      onError: err => toast.error(`Не удалось пополнить оффшор: ${getApiErrorMessage(err)}`),
    },
  });

  const skimService = useSkimMayorOfficeServiceBudget({
    mutation: {
      onSuccess: () => {
        invalidateOffice();
        toast.success("Средства выведены через районную службу");
      },
      onError: err => toast.error(`Не удалось вывести средства: ${getApiErrorMessage(err)}`),
    },
  });

  const provideService = useProvideMayorOfficeService({
    mutation: {
      onSuccess: () => {
        invalidateOffice();
        toast.success("Услуга проведена");
      },
      onError: err => toast.error(`Не удалось оказать услугу: ${getApiErrorMessage(err)}`),
    },
  });

  const purchase = usePurchaseMayorOffice({
    mutation: {
      onSuccess: () => {
        invalidateOffice();
        toast.success("Покупка оформлена");
      },
      onError: err => toast.error(`Не удалось купить: ${getApiErrorMessage(err)}`),
    },
  });

  const isBusy = skimCity.isPending || skimService.isPending || provideService.isPending || purchase.isPending;
  const corruption = office ? corruptionTone(office.corruption) : corruptionTone(0);
  const risk = office ? riskTone(office.riskLevel) : riskTone("low");
  const freeManagementBudget = Math.max(0, gov?.forecast.freeManagementBudget ?? 0);
  const selectedDistrict = districtById.get(selectedDistrictId);
  const selectedServiceBudget = serviceBudgetEstimate(selectedDistrict, service);
  const selectedDeal = office?.deals.find(deal => deal.id === selectedDealId) ?? office?.deals[0];
  const selectedDealDistrict = selectedDeal ? districtById.get(selectedDeal.districtId) : undefined;

  return (
    <div className="mx-auto w-full max-w-6xl p-4 xl:p-6 space-y-4 min-h-[calc(100vh-58px)] overflow-y-auto">
      <div>
        <h1 className="text-base font-semibold text-foreground">Кабинет мэра</h1>
        <p className="text-xs text-muted-foreground mt-0.5">Частный капитал, сделки, риск и личная защита</p>
      </div>

      {isLoading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-24 bg-card border border-card-border rounded animate-pulse" />
          ))}
        </div>
      ) : office ? (
        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Оффшор" value={formatMoney(office.offshoreBalance)} sub="личный резерв" icon={WalletCards} accent="teal" />
            <StatCard label="Коррупция" value={corruption.label} sub={`${Math.round(office.corruption)} скрытых пунктов`} icon={KeyRound} accent={corruption.accent} />
            <StatCard
              label="Риск мэру"
              value={risk.label}
              sub={office.riskLevel === "danger" ? "активна вероятность покушения" : "публично видимый статус"}
              icon={AlertTriangle}
              accent={risk.accent}
            />
            <StatCard
              label="Охрана"
              value={office.securityLevel}
              sub={office.securityLevel > 0 ? `${securityLabel(office.securityLevel)}, ${securityDurationLabel(office.securityTicksRemaining)}` : securityLabel(office.securityLevel)}
              icon={Shield}
              accent="blue"
            />
          </div>

          <div className="grid xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-4">
            <section className="bg-card border border-card-border rounded p-4 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Перенаправить резерв</h2>
                  <p className="text-xs text-muted-foreground mt-1">
                    Свободный бюджет: <span className="text-primary tabular-nums">{formatMoney(freeManagementBudget)}</span>
                  </p>
                </div>
                <HandCoins className="w-4 h-4 text-primary" />
              </div>

              <div className="grid gap-2">
                {CITY_LEVELS.map(option => {
                  const effect = CITY_SKIM_EFFECTS[option.level];
                  const amount = Math.round(freeManagementBudget * effect.share);
                  return (
                    <button
                      key={option.level}
                      type="button"
                      disabled={isBusy}
                      onClick={() => skimCity.mutate({ data: { level: option.level } })}
                      className="grid gap-2 rounded border border-primary/35 bg-primary/10 px-3 py-2 text-left text-xs hover:bg-primary/16 disabled:opacity-45 sm:grid-cols-[120px_1fr] sm:items-center"
                    >
                      <span>
                        <span className="block font-semibold text-primary">{option.label}</span>
                        <span className="text-[10px] text-muted-foreground">{option.note}</span>
                      </span>
                      <span className="block text-[10px] leading-snug text-muted-foreground">
                        оффшор <b className="font-semibold text-primary">{formatMoney(amount, true)}</b> · жители {formatDelta(effect.residentsReputationDelta, 1)} · власть {formatDelta(effect.governmentReputationDelta, 1)} · риск {formatDelta(effect.corruptionDelta, 1)}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="rounded border border-border/70 bg-muted/10 p-3 space-y-3">
                <div className="flex items-center gap-2 text-xs font-medium">
                  <LockKeyhole className="w-3.5 h-3.5 text-[hsl(282,52%,78%)]" />
                  Закрыть вопрос со службой
                </div>
                <div className="grid sm:grid-cols-2 gap-2">
                  <select
                    value={selectedDistrictId}
                    onChange={event => setServiceDistrictId(event.target.value)}
                    className="rounded border border-border bg-input px-2 py-2 text-xs text-foreground outline-none focus:border-primary"
                  >
                    {(districts ?? []).map(district => (
                      <option key={district.id} value={district.id}>{district.name}</option>
                    ))}
                  </select>
                  <select
                    value={service}
                    onChange={event => setService(event.target.value as DistrictServiceType)}
                    className="rounded border border-border bg-input px-2 py-2 text-xs text-foreground outline-none focus:border-primary"
                  >
                    {SERVICE_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  {ACTION_LEVELS.map(option => {
                    const effect = SERVICE_SKIM_EFFECTS[option.level];
                    const amount = Math.round(selectedServiceBudget * effect.share);
                    return (
                      <button
                        key={option.level}
                        type="button"
                        disabled={isBusy || !selectedDistrictId}
                        onClick={() => skimService.mutate({ data: { districtId: selectedDistrictId, service, level: option.level } })}
                        className="grid gap-2 rounded border border-[hsla(282,52%,78%,0.38)] bg-[hsla(282,52%,78%,0.10)] px-3 py-2 text-left text-[10px] hover:bg-[hsla(282,52%,78%,0.16)] disabled:opacity-45 sm:grid-cols-[100px_1fr] sm:items-center"
                      >
                        <span className="block text-xs font-medium text-[hsl(282,52%,78%)]">{option.label}</span>
                        <span className="block text-muted-foreground">
                          оффшор <b className="font-semibold text-[hsl(282,52%,78%)]">{formatMoney(amount, true)}</b> · готовность {formatDelta(-effect.efficiencyPenaltyDelta * 100)}% · риск {formatDelta(effect.corruptionDelta, 1)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            <section className="bg-card border border-card-border rounded p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Согласовать интересы</h2>
                <BriefcaseBusiness className="w-4 h-4 text-[hsl(38,78%,74%)]" />
              </div>
              <div className="signals-scrollbar overflow-x-auto pb-1">
                <div className="flex w-max min-w-full gap-2">
                  {office.deals.map(deal => {
                    const district = districtById.get(deal.districtId);
                    const active = selectedDeal?.id === deal.id;
                    return (
                      <button
                        key={deal.id}
                        type="button"
                        onClick={() => setSelectedDealId(deal.id)}
                        className={cn(
                          "w-44 shrink-0 rounded border px-3 py-2 text-left transition-colors",
                          active
                            ? "border-[hsla(38,78%,74%,0.72)] bg-[hsla(38,78%,74%,0.16)]"
                            : "border-[hsla(38,78%,74%,0.28)] bg-background/30 hover:bg-[hsla(38,78%,74%,0.10)]",
                        )}
                      >
                        <span className="block truncate text-xs font-semibold text-foreground">{deal.title}</span>
                        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{district?.name ?? deal.districtId}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {selectedDeal && (
                <div className="rounded border border-[hsla(38,78%,74%,0.38)] bg-[hsla(38,78%,74%,0.08)] p-3 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{selectedDeal.title}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{selectedDealDistrict?.name ?? selectedDeal.districtId}</p>
                    </div>
                    <span className="rounded border border-[hsla(38,78%,74%,0.32)] px-2 py-1 text-[10px] text-[hsl(38,78%,74%)]">
                      {office.deals.length} вариантов
                    </span>
                  </div>
                  <div className="grid gap-2">
                    {ACTION_LEVELS.map(option => {
                      const scale = DEAL_LEVEL_SCALE[option.level];
                      const effect = DEAL_EFFECTS[selectedDeal.id] ?? { baseCorruptionDelta: 0, residentsReputationDelta: 0, businessTrustDelta: 0 };
                      return (
                        <button
                          key={option.level}
                          type="button"
                          disabled={isBusy}
                          onClick={() => provideService.mutate({ data: { districtId: selectedDeal.districtId, dealId: selectedDeal.id, level: option.level } })}
                          className="grid gap-2 rounded border border-[hsla(38,78%,74%,0.36)] bg-background/35 px-3 py-2 text-left text-[10px] hover:bg-[hsla(38,78%,74%,0.14)] disabled:opacity-45 sm:grid-cols-[100px_1fr_auto] sm:items-center"
                        >
                          <span className="font-semibold text-[hsl(38,78%,74%)]">{option.label}</span>
                          <span className="text-muted-foreground">
                            жители {formatDelta(effect.residentsReputationDelta * scale, 1)} · бизнес {formatDelta(effect.businessTrustDelta * scale, 1)} · риск {formatDelta(effect.baseCorruptionDelta * scale, 1)}
                          </span>
                          <span className="tabular-nums text-primary">оффшор {formatMoney(selectedDeal.levels[option.level], true)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>
          </div>

          <section className="bg-card border border-card-border rounded p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Личный контур</h2>
              <Gem className="w-4 h-4 text-[hsl(282,52%,78%)]" />
            </div>
            <div className="signals-scrollbar overflow-x-auto pb-1">
              <div className="flex w-max min-w-full gap-2">
                {office.purchases.map(item => {
                  const enoughMoney = office.offshoreBalance >= item.cost;
                  return (
                    <div key={item.item} className="flex h-[154px] w-56 shrink-0 flex-col gap-2 rounded border border-border/70 bg-muted/10 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold">{item.title}</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">{formatMoney(item.cost)} из оффшора</p>
                      </div>
                      {item.item === "expensive_car" ? (
                        <Car className="w-4 h-4 text-[hsl(38,78%,74%)] shrink-0" />
                      ) : item.securityDelta > 0 ? (
                        <Shield className="w-4 h-4 text-[hsl(232,67%,79%)] shrink-0" />
                      ) : (
                        <Sparkles className="w-4 h-4 text-[hsl(282,52%,78%)] shrink-0" />
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-snug">
                      {item.securityDelta > 0 && `+${item.securityDelta} охрана `}
                      {item.securityDurationDays > 0 && `на ${item.securityDurationDays} дня `}
                      {item.luxuryDelta > 0 && `+${item.luxuryDelta} роскошь `}
                      {item.statusDelta > 0 && `+${item.statusDelta} статус `}
                      {item.corruptionDelta > 0 && `риск ${formatDelta(item.corruptionDelta, 1)}`}
                      {item.povertyBacklash && " · возможен общественный резонанс"}
                    </p>
                    <button
                      type="button"
                      disabled={isBusy || !enoughMoney}
                      onClick={() => purchase.mutate({ data: { item: item.item } })}
                      className={cn(
                        "mt-auto inline-flex items-center justify-center gap-1.5 rounded px-3 py-2 text-xs font-medium transition-opacity",
                        enoughMoney ? "bg-primary text-primary-foreground hover:opacity-90" : "bg-muted text-muted-foreground opacity-60"
                      )}
                    >
                      {item.securityDelta > 0 ? "Усилить контур" : "Закрепить статус"}
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="bg-card border border-card-border rounded p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">История операций</h2>
              <Landmark className="w-4 h-4 text-muted-foreground" />
            </div>
            {office.operations.length > 0 ? (
              <div className="space-y-2">
                {office.operations.map(operation => (
                  <div key={operation.id} className="grid gap-2 rounded border border-border/60 bg-background/30 p-3 text-xs md:grid-cols-[1fr_auto_auto] md:items-center">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">{operationDisplayTitle(operation)}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {operationTypeLabel(operation.type)} · день {operation.day}, тик {operation.tick}
                      </p>
                    </div>
                    <span className={cn("tabular-nums", operation.offshoreDelta >= 0 ? "text-primary" : "text-[hsl(351,72%,75%)]")}>
                      {formatMoney(operation.offshoreDelta, true)}
                    </span>
                    <span className={cn("tabular-nums", operation.corruptionDelta > 0 ? "text-[hsl(38,78%,74%)]" : "text-muted-foreground")}>
                      коррупция {formatMoney(operation.corruptionDelta, true)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded border border-border/60 bg-muted/10 p-4 text-sm text-muted-foreground">
                Операций пока нет.
              </div>
            )}
          </section>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Нет данных кабинета.</p>
      )}
    </div>
  );
}
