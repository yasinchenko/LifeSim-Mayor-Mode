import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetConfigQueryKey,
  getGetGovernmentQueryKey,
  useGetConfig,
  useUpdateConfig,
} from "@workspace/api-client-react";
import { Save } from "lucide-react";
import { toast } from "sonner";

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
  format?: (value: number) => string;
}

const FIELDS: SettingField[] = [
  { key: "taxRate", label: "Ставка налога", description: "Доля дохода, удерживаемая с каждой зарплаты.", min: 0, max: 1, step: 0.01, format: value => `${(value * 100).toFixed(0)}%` },
  { key: "needDecayRate", label: "Убывание потребностей", description: "Сколько пунктов потребностей теряется за тик.", min: 0, max: 20, step: 0.5, format: value => `${value.toFixed(1)} пт/тик` },
  { key: "tickIntervalMs", label: "Длительность тика", description: "Реальное время одного игрового часа.", min: 10000, max: 300000, step: 5000, format: value => `${(value / 1000).toFixed(0)} сек` },
  { key: "initialAgents", label: "Начальное население", description: "Сколько жителей создается при новой партии.", min: 1000, max: 5000, step: 100, format: value => value.toFixed(0) },
  { key: "initialBusinesses", label: "Начальные бизнесы", description: "Сколько предприятий создается при новой партии.", min: 10, max: 500, step: 10, format: value => value.toFixed(0) },
  { key: "baseFoodPrice", label: "Базовая цена еды", description: "Стоимость продовольственных товаров до наценки.", min: 1, max: 100, step: 1, format: value => `${value.toFixed(0)} ед.` },
  { key: "baseSalary", label: "Базовая зарплата", description: "Сколько агент зарабатывает за тик работы до налогов.", min: 1, max: 500, step: 5, format: value => `${value.toFixed(0)} ед./тик` },
  { key: "subsidyAmount", label: "Размер субсидии", description: "Выплата агентам с нулевым балансом.", min: 0, max: 200, step: 5, format: value => `${value.toFixed(0)} ед.` },
  { key: "socialInteractionStrength", label: "Сила общения", description: "Насколько социальные взаимодействия влияют на настроение.", min: 0, max: 10, step: 0.5, format: value => `x${value.toFixed(1)}` },
  { key: "priceMarkup", label: "Наценка бизнеса", description: "Процент, который бизнес добавляет к базовой цене товара.", min: 0, max: 1, step: 0.05, format: value => `${(value * 100).toFixed(0)}%` },
  { key: "pensionRate", label: "Пенсионная ставка", description: "Доля базовой зарплаты, выплачиваемая пенсионерам за тик.", min: 0, max: 1, step: 0.05, format: value => `${(value * 100).toFixed(0)}%` },
];

export default function CitySettingsPanel() {
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, number>>({});
  const [dirty, setDirty] = useState(false);

  const { data: config, isLoading } = useGetConfig({
    query: { queryKey: getGetConfigQueryKey() },
  });

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
        qc.invalidateQueries({ queryKey: getGetGovernmentQueryKey() });
        toast.success("Параметры города применены");
        setDirty(false);
      },
      onError: err => toast.error(`Ошибка сохранения параметров: ${getApiErrorMessage(err)}`),
    },
  });

  const handleChange = (key: string, value: number) => {
    setValues(current => ({ ...current, [key]: value }));
    setDirty(true);
  };

  if (isLoading) {
    return (
      <div className="bg-card border border-card-border rounded p-4 space-y-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-16 rounded bg-muted/30 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="bg-card border border-card-border rounded p-4 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xs font-semibold text-foreground">Параметры города</h2>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Изменения применяются к живой симуляции сразу после сохранения.
          </p>
        </div>
        <button
          onClick={() => updateConfigMutation.mutate({ data: values })}
          disabled={!dirty || updateConfigMutation.isPending}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-primary-foreground rounded text-xs font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          <Save className="w-3.5 h-3.5" />
          {updateConfigMutation.isPending ? "Применяется..." : "Применить"}
        </button>
      </div>

      <div className="grid md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2 gap-3">
        {FIELDS.map(field => {
          const value = values[field.key] ?? 0;
          return (
            <div key={field.key} className="rounded border border-border/70 bg-muted/10 p-3">
              <div className="flex items-start justify-between mb-3 gap-2">
                <div className="min-w-0">
                  <label className="text-xs font-medium text-foreground">{field.label}</label>
                  <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{field.description}</p>
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
                  onChange={event => handleChange(field.key, parseFloat(event.target.value))}
                  className="flex-1 h-1 bg-muted rounded-full appearance-none cursor-pointer accent-primary"
                />
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={value}
                  onChange={event => {
                    const parsed = parseFloat(event.target.value);
                    if (!Number.isNaN(parsed)) {
                      handleChange(field.key, Math.max(field.min, Math.min(field.max, parsed)));
                    }
                  }}
                  className="w-20 text-xs text-right bg-input border border-border rounded px-2 py-1 text-foreground outline-none focus:border-primary"
                />
              </div>
            </div>
          );
        })}
      </div>

      {dirty && (
        <div className="bg-[hsl(38,78%,74%)]/10 border border-[hsl(38,78%,74%)]/30 rounded p-3 text-xs text-[hsl(38,78%,74%)]">
          Есть несохраненные изменения. Нажмите «Применить», чтобы они вступили в силу.
        </div>
      )}
    </div>
  );
}
