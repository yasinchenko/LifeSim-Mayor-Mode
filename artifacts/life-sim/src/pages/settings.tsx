import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetConfig,
  getGetConfigQueryKey,
  useUpdateConfig,
  useGetSimulationState,
  getGetSimulationStateQueryKey,
  useStartSimulation,
  useStopSimulation,
  useResetSimulation,
} from "@workspace/api-client-react";
import { toast } from "sonner";
import { Save, Lock, LogIn, LogOut, Play, Square, RotateCcw } from "lucide-react";
import { useAdmin } from "@/contexts/admin-context";
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
  displayMultiplier?: number;
}

const FIELDS: SettingField[] = [
  {
    key: "taxRate",
    label: "Ставка налога",
    description: "Доля дохода, удерживаемая государством с каждой зарплаты агента",
    min: 0,
    max: 1,
    step: 0.01,
    format: v => `${(v * 100).toFixed(0)}%`,
  },
  {
    key: "needDecayRate",
    label: "Скорость убывания потребностей",
    description: "На сколько пунктов снижается каждая потребность за один тик (0 = не убывает)",
    min: 0,
    max: 20,
    step: 0.5,
    format: v => `${v.toFixed(1)} пт/тик`,
  },
  {
    key: "tickIntervalMs",
    label: "Длительность тика (секунд)",
    description: "Реальное время одного игрового часа. По умолчанию 60 секунд = 1 минута",
    min: 10000,
    max: 300000,
    step: 5000,
    format: v => `${(v / 1000).toFixed(0)} сек`,
  },
  {
    key: "initialAgents",
    label: "Начальное число агентов",
    description: "Сколько жителей генерируется при сбросе (минимум 1000)",
    min: 1000,
    max: 5000,
    step: 100,
    format: v => v.toFixed(0),
  },
  {
    key: "initialBusinesses",
    label: "Начальное число бизнесов",
    description: "Сколько предприятий создаётся при сбросе (60% — еда, 40% — сервис)",
    min: 10,
    max: 500,
    step: 10,
    format: v => v.toFixed(0),
  },
  {
    key: "baseFoodPrice",
    label: "Базовая цена еды",
    description: "Базовая стоимость продовольственных товаров до наценки",
    min: 1,
    max: 100,
    step: 1,
    format: v => `${v.toFixed(0)} ед.`,
  },
  {
    key: "baseSalary",
    label: "Базовая зарплата",
    description: "Сколько агент зарабатывает за тик работы (до налогов)",
    min: 1,
    max: 500,
    step: 5,
    format: v => `${v.toFixed(0)} ед./тик`,
  },
  {
    key: "subsidyAmount",
    label: "Размер субсидии",
    description: "Сумма, которую государство выплачивает агентам с нулевым балансом",
    min: 0,
    max: 200,
    step: 5,
    format: v => `${v.toFixed(0)} ед.`,
  },
  {
    key: "socialInteractionStrength",
    label: "Сила социального взаимодействия",
    description: "Насколько сильно общение влияет на настроение агентов",
    min: 0,
    max: 10,
    step: 0.5,
    format: v => `×${v.toFixed(1)}`,
  },
  {
    key: "priceMarkup",
    label: "Наценка бизнеса",
    description: "Процент, который бизнес добавляет к базовой цене товара",
    min: 0,
    max: 1,
    step: 0.05,
    format: v => `${(v * 100).toFixed(0)}%`,
  },
  {
    key: "pensionRate",
    label: "Пенсионная ставка",
    description: "Доля базовой зарплаты, выплачиваемая пенсионерам от государства за каждый тик",
    min: 0,
    max: 1,
    step: 0.05,
    format: v => `${(v * 100).toFixed(0)}%`,
  },
];

function AdminLoginGate({ onSuccess }: { onSuccess: () => void }) {
  const { login } = useAdmin();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const result = await login(password);
    setLoading(false);
    if (result.success) {
      onSuccess();
    } else {
      setError(result.error ?? "Ошибка входа");
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">
      <div className="w-full max-w-sm bg-card border border-card-border rounded-lg p-8 space-y-6">
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Lock className="w-6 h-6 text-primary" />
          </div>
          <div className="text-center">
            <h2 className="text-sm font-semibold text-foreground">Панель администратора</h2>
            <p className="text-xs text-muted-foreground mt-1">Введите пароль для доступа к настройкам и управлению симуляцией</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Пароль</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoFocus
              className="w-full bg-input border border-border rounded px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors"
            />
          </div>

          {error && (
            <p className="text-xs text-[hsl(348,83%,47%)]">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded text-xs font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
          >
            <LogIn className="w-3.5 h-3.5" />
            {loading ? "Вход..." : "Войти"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { isAdmin, logout } = useAdmin();
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const [showLogin, setShowLogin] = useState(false);

  const { data: config, isLoading: configLoading } = useGetConfig({
    query: { queryKey: getGetConfigQueryKey() },
  });

  const { data: state } = useGetSimulationState({
    query: {
      queryKey: getGetSimulationStateQueryKey(),
      refetchInterval: isAdmin ? 5000 : false,
    },
  });

  const running = state?.running ?? false;

  const [values, setValues] = useState<Record<string, number>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (config) {
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
    }
  }, [config]);

  const mutation = useUpdateConfig({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetConfigQueryKey() });
        toast.success("Настройки применены");
        setDirty(false);
      },
      onError: (err) => {
        const msg = getApiErrorMessage(err);
        toast.error(`Ошибка при сохранении настроек: ${msg}`);
      },
    },
  });

  const startMutation = useStartSimulation({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetSimulationStateQueryKey() });
        toast.success("Симуляция запущена");
      },
      onError: (err) => {
        const msg = getApiErrorMessage(err);
        toast.error(`Ошибка запуска симуляции: ${msg}`);
      },
    },
  });

  const stopMutation = useStopSimulation({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetSimulationStateQueryKey() });
        toast.info("Симуляция остановлена");
      },
      onError: (err) => {
        const msg = getApiErrorMessage(err);
        toast.error(`Ошибка остановки симуляции: ${msg}`);
      },
    },
  });

  const resetMutation = useResetSimulation({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries();
        toast.success("Симуляция сброшена — переход на дашборд");
        setTimeout(() => setLocation("/"), 1500);
      },
      onError: (err) => {
        const msg = getApiErrorMessage(err);
        toast.error(`Ошибка сброса симуляции: ${msg}`);
      },
    },
  });

  const handleChange = (key: string, value: number) => {
    setValues(v => ({ ...v, [key]: value }));
    setDirty(true);
  };

  const handleApply = () => {
    mutation.mutate({ data: values });
  };

  if (!isAdmin) {
    return <AdminLoginGate onSuccess={() => setShowLogin(false)} />;
  }

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
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-foreground">Панель администратора</h1>
            <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold tracking-wider bg-primary/15 text-primary border border-primary/25">ADMIN</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">Управление симуляцией и параметры</p>
        </div>
        <button
          onClick={logout}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary text-secondary-foreground rounded text-xs font-medium hover:opacity-90 transition-opacity"
        >
          <LogOut className="w-3.5 h-3.5" />
          Выйти
        </button>
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
            {running ? "РАБОТАЕТ" : "ОСТАНОВЛЕНА"}
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
          <h2 className="text-xs font-semibold text-foreground">Настройки симуляции</h2>
          <p className="text-[10px] text-muted-foreground mt-0.5">Параметры применяются к живой симуляции немедленно</p>
        </div>
        <button
          onClick={handleApply}
          disabled={!dirty || mutation.isPending}
          className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded text-xs font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          <Save className="w-3.5 h-3.5" />
          {mutation.isPending ? "Применяется..." : "Применить"}
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
                <span className="text-[10px] text-muted-foreground w-10 text-right tabular-nums shrink-0 hidden sm:block">
                  {field.format ? field.format(field.min) : field.min}
                </span>
                <input
                  type="range"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={value}
                  onChange={e => handleChange(field.key, parseFloat(e.target.value))}
                  className="flex-1 h-1 bg-muted rounded-full appearance-none cursor-pointer accent-primary"
                />
                <span className="text-[10px] text-muted-foreground w-10 tabular-nums shrink-0 hidden sm:block">
                  {field.format ? field.format(field.max) : field.max}
                </span>
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={value}
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) handleChange(field.key, Math.max(field.min, Math.min(field.max, v)));
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
          Есть несохранённые изменения. Нажмите «Применить» для вступления в силу.
        </div>
      )}
    </div>
  );
}
