import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetConfigQueryKey,
  getGetSimulationStateQueryKey,
  useGetConfig,
  useGetSimulationState,
  useNewGame,
  useResetSimulation,
  useStartSimulation,
  useStopSimulation,
  useUpdateConfig,
} from "@workspace/api-client-react";
import { toast } from "sonner";
import { Flag, Play, RotateCcw, Save, Square } from "lucide-react";
import { cn } from "@/lib/utils";

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

interface SettingField {
  key: string;
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
}

const FIELDS: SettingField[] = [
  { key: "taxRate", label: "Ставка налога", description: "Доля дохода, удерживаемая с каждой зарплаты.", min: 0, max: 1, step: 0.01, format: v => `${(v * 100).toFixed(0)}%` },
  { key: "needDecayRate", label: "Убывание потребностей", description: "Сколько пунктов потребностей теряется за тик.", min: 0, max: 20, step: 0.5, format: v => `${v.toFixed(1)} пт/тик` },
  { key: "tickIntervalMs", label: "Длительность тика", description: "Реальное время одного игрового часа.", min: 10000, max: 300000, step: 5000, format: v => `${(v / 1000).toFixed(0)} сек` },
  { key: "initialAgents", label: "Начальное население", description: "Сколько жителей создается при новой партии или сбросе.", min: 1000, max: 5000, step: 100, format: v => v.toFixed(0) },
  { key: "initialBusinesses", label: "Начальные бизнесы", description: "Сколько предприятий создается при новой партии или сбросе.", min: 10, max: 500, step: 10, format: v => v.toFixed(0) },
  { key: "baseFoodPrice", label: "Базовая цена еды", description: "Стоимость продовольственных товаров до наценки.", min: 1, max: 100, step: 1, format: v => `${v.toFixed(0)} ед.` },
  { key: "baseSalary", label: "Базовая зарплата", description: "Сколько агент зарабатывает за тик работы до налогов.", min: 1, max: 500, step: 5, format: v => `${v.toFixed(0)} ед./тик` },
  { key: "subsidyAmount", label: "Размер субсидии", description: "Выплата агентам с нулевым балансом.", min: 0, max: 200, step: 5, format: v => `${v.toFixed(0)} ед.` },
  { key: "socialInteractionStrength", label: "Сила общения", description: "Насколько социальные взаимодействия влияют на настроение.", min: 0, max: 10, step: 0.5, format: v => `x${v.toFixed(1)}` },
  { key: "priceMarkup", label: "Наценка бизнеса", description: "Процент, который бизнес добавляет к базовой цене товара.", min: 0, max: 1, step: 0.05, format: v => `${(v * 100).toFixed(0)}%` },
  { key: "pensionRate", label: "Пенсионная ставка", description: "Доля базовой зарплаты, выплачиваемая пенсионерам за тик.", min: 0, max: 1, step: 0.05, format: v => `${(v * 100).toFixed(0)}%` },
];

const SCENARIOS = [
  { value: "balanced", label: "Сбалансированный город", description: "Ровный старт с запасом бюджета и без жёсткого перекоса." },
  { value: "crisis", label: "Кризисный мандат", description: "Меньше денег в казне: нужно быстро стабилизировать город." },
  { value: "growth", label: "Экономический рывок", description: "Больше стартового капитала, но цель требует сильного роста." },
  { value: "stability", label: "Социальная устойчивость", description: "Фокус на здоровье, населении и спокойствии жителей." },
] as const;

const GOALS = [
  { value: "balanced", label: "Баланс интересов", description: "Довести жителей, бизнес и власть до поддержки 70+." },
  { value: "crisis_recovery", label: "Выход из кризиса", description: "Вернуть бюджет, занятость и настроение в устойчивую зону." },
  { value: "economic_growth", label: "Рост экономики", description: "Поднять ВВП, прибыльность бизнеса и занятость." },
  { value: "social_stability", label: "Стабильный город", description: "Удержать население, здоровье и доверие жителей." },
] as const;

export default function SettingsPage() {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const [values, setValues] = useState<Record<string, number>>({});
  const [dirty, setDirty] = useState(false);
  const [scenarioType, setScenarioType] = useState<(typeof SCENARIOS)[number]["value"]>("balanced");
  const [goalType, setGoalType] = useState<(typeof GOALS)[number]["value"]>("balanced");
  const [dayLimit, setDayLimit] = useState(30);

  const { data: config, isLoading: configLoading } = useGetConfig({
    query: { queryKey: getGetConfigQueryKey() },
  });

  const { data: state } = useGetSimulationState({
    query: {
      queryKey: getGetSimulationStateQueryKey(),
      refetchInterval: 5000,
    },
  });

  const running = state?.running ?? false;

  useEffect(() => {
    if (!config) return;
    setValues({
      taxRate: config.taxRate,
      needDecayRate: config.needDecayRate,
      tickIntervalMs: config.tickIntervalMs,
      initialAgents: config.initialAgents,
      initialBusinesses: config.initialBusinesses,
      baseFoodPrice: config.baseFoodPrice,
      baseSalary: config.baseSalary,
      subsidyAmount: config.subsidyAmount,
      socialInteractionStrength: config.socialInteractionStrength,
      priceMarkup: config.priceMarkup,
      pensionRate: config.pensionRate,
    });
    setDirty(false);
  }, [config]);

  const updateConfigMutation = useUpdateConfig({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetConfigQueryKey() });
        toast.success("Настройки применены");
        setDirty(false);
      },
      onError: err => toast.error(`Ошибка сохранения настроек: ${getApiErrorMessage(err)}`),
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
        toast.info("Симуляция остановлена");
      },
      onError: err => toast.error(`Ошибка остановки: ${getApiErrorMessage(err)}`),
    },
  });

  const resetMutation = useResetSimulation({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries();
        toast.success("Симуляция сброшена");
        setTimeout(() => setLocation("/"), 1000);
      },
      onError: err => toast.error(`Ошибка сброса: ${getApiErrorMessage(err)}`),
    },
  });

  const newGameMutation = useNewGame({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries();
        toast.success("Новая партия запущена");
        setTimeout(() => setLocation("/"), 800);
      },
      onError: err => toast.error(`Не удалось запустить новую партию: ${getApiErrorMessage(err)}`),
    },
  });

  const handleChange = (key: string, value: number) => {
    setValues(v => ({ ...v, [key]: value }));
    setDirty(true);
  };

  if (configLoading) {
    return (
      <div className="p-4 sm:p-6 space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-20 bg-card border border-card-border rounded animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-2xl">
      <div>
        <h1 className="text-base font-semibold text-foreground">Управление игрой</h1>
        <p className="text-xs text-muted-foreground mt-0.5">Настройки симуляции, запуск и новая партия</p>
      </div>

      <div className="bg-card border border-card-border rounded p-4 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Новая партия</h2>
            <p className="text-xs text-muted-foreground mt-1">Выберите сценарий, цель и лимит игровых дней. Запуск очистит текущую симуляцию.</p>
          </div>
          <button
            onClick={() => {
              if (confirm("Запустить новую партию? Текущий город будет сброшен.")) {
                newGameMutation.mutate({ data: { scenarioType, goalType, dayLimit } });
              }
            }}
            disabled={newGameMutation.isPending}
            className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded text-xs font-medium hover:opacity-90 disabled:opacity-50"
          >
            <Flag className="w-3.5 h-3.5" />
            {newGameMutation.isPending ? "Запуск..." : "Начать партию"}
          </button>
        </div>

        <div className="grid gap-3">
          <OptionGrid title="Сценарий" items={SCENARIOS} value={scenarioType} onChange={value => setScenarioType(value)} />
          <OptionGrid title="Цель партии" items={GOALS} value={goalType} onChange={value => setGoalType(value)} />

          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Лимит дней</p>
              <span className="text-xs font-bold text-primary tabular-nums">{dayLimit}</span>
            </div>
            <input
              type="range"
              min={7}
              max={120}
              step={1}
              value={dayLimit}
              onChange={e => setDayLimit(parseInt(e.target.value, 10))}
              className="w-full h-1 bg-muted rounded-full appearance-none cursor-pointer accent-primary"
            />
          </div>
        </div>
      </div>

      <div className="bg-card border border-card-border rounded p-4 space-y-3">
        <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Управление симуляцией</h2>
        <div className="flex items-center gap-3 flex-wrap">
          <div className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border",
            running
              ? "bg-[hsl(173,80%,40%)]/10 border-[hsl(173,80%,40%)]/30 text-[hsl(173,80%,40%)]"
              : "bg-[hsl(348,83%,47%)]/10 border-[hsl(348,83%,47%)]/30 text-[hsl(348,83%,47%)]"
          )}>
            <span className={cn("w-1.5 h-1.5 rounded-full", running ? "bg-[hsl(173,80%,40%)] animate-pulse" : "bg-[hsl(348,83%,47%)]")} />
            {running ? "Работает" : "Остановлена"}
          </div>

          {!running ? (
            <button
              onClick={() => startMutation.mutate()}
              disabled={startMutation.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs font-medium hover:opacity-90 disabled:opacity-50"
            >
              <Play className="w-3 h-3" />
              Запустить
            </button>
          ) : (
            <button
              onClick={() => stopMutation.mutate()}
              disabled={stopMutation.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary text-secondary-foreground rounded text-xs font-medium hover:opacity-90 disabled:opacity-50"
            >
              <Square className="w-3 h-3" />
              Остановить
            </button>
          )}

          <button
            onClick={() => {
              if (confirm("Сбросить симуляцию? Все данные будут очищены.")) {
                resetMutation.mutate();
              }
            }}
            disabled={resetMutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary text-secondary-foreground rounded text-xs font-medium hover:opacity-90 disabled:opacity-50"
          >
            <RotateCcw className="w-3 h-3" />
            Сброс
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xs font-semibold text-foreground">Параметры симуляции</h2>
          <p className="text-[10px] text-muted-foreground mt-0.5">Изменения применяются к живой симуляции сразу после сохранения</p>
        </div>
        <button
          onClick={() => updateConfigMutation.mutate({ data: values })}
          disabled={!dirty || updateConfigMutation.isPending}
          className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded text-xs font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          <Save className="w-3.5 h-3.5" />
          {updateConfigMutation.isPending ? "Применяется..." : "Применить"}
        </button>
      </div>

      <div className="space-y-3">
        {FIELDS.map(field => {
          const value = values[field.key] ?? 0;
          return (
            <div key={field.key} className="bg-card border border-card-border rounded p-4">
              <div className="flex items-start justify-between mb-3 gap-2">
                <div className="min-w-0">
                  <label className="text-xs font-medium text-foreground">{field.label}</label>
                  <p className="text-[10px] text-muted-foreground mt-0.5 max-w-xs">{field.description}</p>
                </div>
                <span className="text-xs font-bold text-primary tabular-nums shrink-0">
                  {field.format ? field.format(value) : value}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={value}
                  onChange={e => handleChange(field.key, parseFloat(e.target.value))}
                  className="flex-1 h-1 bg-muted rounded-full appearance-none cursor-pointer accent-primary"
                />
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={value}
                  onChange={e => {
                    const parsed = parseFloat(e.target.value);
                    if (!Number.isNaN(parsed)) {
                      handleChange(field.key, Math.max(field.min, Math.min(field.max, parsed)));
                    }
                  }}
                  className="w-18 sm:w-20 text-xs text-right bg-input border border-border rounded px-2 py-1 text-foreground outline-none focus:border-primary"
                />
              </div>
            </div>
          );
        })}
      </div>

      {dirty && (
        <div className="bg-[hsl(43,100%,50%)]/10 border border-[hsl(43,100%,50%)]/30 rounded p-3 text-xs text-[hsl(43,100%,50%)]">
          Есть несохранённые изменения. Нажмите «Применить», чтобы они вступили в силу.
        </div>
      )}
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
              value === item.value
                ? "border-primary bg-primary/10"
                : "border-border bg-muted/10 hover:bg-muted/20"
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
