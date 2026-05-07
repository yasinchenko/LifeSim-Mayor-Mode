import { useParams, useLocation } from "wouter";
import {
  useGetAgent,
  getGetAgentQueryKey,
  type AgentDetail,
  type AgentRelation,
  type JobHistoryEntry,
} from "@workspace/api-client-react";
import { ArrowLeft, User, Heart, Coffee, Users, Briefcase, LogIn, LogOut, Sunset, Moon, ShieldPlus, BookOpen, Gamepad2, Star, TrendingUp, DoorOpen, Clock, Award, Home, Banknote, ShoppingBasket, Shield, Brain, Bolt, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Consumer preference matrix (spec v1.6) ────────────────────────────────────
// Index: 0=Санг.Инт 1=Санг.Экстр 2=Хол.Инт 3=Хол.Экстр
//        4=Флег.Инт 5=Флег.Экстр 6=Мел.Инт 7=Мел.Экстр
type PriceTier = "Низкая" | "Средняя" | "Высокая";
type QualityTier = "Низкое" | "Среднее" | "Высокое";
type TierPair = [PriceTier, QualityTier];

const CONSUMER_MATRIX: Record<string, TierPair[]> = {
  food: [
    ["Средняя", "Среднее"], ["Высокая", "Высокое"], ["Высокая", "Высокое"], ["Средняя", "Высокое"],
    ["Низкая",  "Среднее"], ["Средняя", "Среднее"], ["Высокая", "Высокое"], ["Высокая", "Среднее"],
  ],
  park: [
    ["Низкая",  "Среднее"], ["Высокая", "Среднее"], ["Низкая",  "Высокое"], ["Высокая", "Высокое"],
    ["Низкая",  "Низкое"],  ["Средняя", "Среднее"], ["Низкая",  "Среднее"], ["Средняя", "Высокое"],
  ],
  service: [
    ["Средняя", "Высокое"], ["Высокая", "Высокое"], ["Средняя", "Среднее"], ["Высокая", "Высокое"],
    ["Средняя", "Среднее"], ["Низкая",  "Среднее"], ["Средняя", "Среднее"], ["Высокая", "Высокое"],
  ],
};

function getPersonalityIndex(personality: string, socialization: number): number {
  const base: Record<string, number> = { "сангвиник": 0, "холерик": 2, "флегматик": 4, "меланхолик": 6 };
  return (base[personality] ?? 0) + (socialization >= 50 ? 1 : 0);
}

const TEMPERAMENT_COLORS: Record<string, string> = {
  "сангвиник":  "bg-[hsl(43,90%,50%)]/15  text-[hsl(43,90%,50%)]  border-[hsl(43,90%,50%)]/30",
  "холерик":    "bg-[hsl(0,80%,55%)]/15   text-[hsl(0,80%,55%)]   border-[hsl(0,80%,55%)]/30",
  "флегматик":  "bg-[hsl(173,80%,40%)]/15 text-[hsl(173,80%,40%)] border-[hsl(173,80%,40%)]/30",
  "меланхолик": "bg-[hsl(220,70%,55%)]/15 text-[hsl(220,70%,55%)] border-[hsl(220,70%,55%)]/30",
};

const PRICE_COLORS: Record<PriceTier, string> = {
  "Низкая":  "text-[hsl(120,60%,45%)]",
  "Средняя": "text-[hsl(43,100%,50%)]",
  "Высокая": "text-[hsl(0,80%,55%)]",
};

const QUALITY_COLORS: Record<QualityTier, string> = {
  "Низкое":  "text-muted-foreground",
  "Среднее": "text-[hsl(43,100%,50%)]",
  "Высокое": "text-[hsl(173,80%,40%)]",
};

const ACTION_LABELS: Record<string, string> = {
  eat: "Ест",
  rest: "Отдыхает",
  sleep: "Спит",
  heal: "Лечится",
  socialize: "Общается",
  work: "Работает",
  idle: "Простаивает",
  study: "Учится",
  relax: "Развлекается",
  pray: "Молится",
  rob: "Грабит",
  robbed: "Ограблен",
  call_police: "Вызывает полицию",
  jailed: "Под стражей",
};

const ACTION_COLORS: Record<string, string> = {
  eat: "bg-[hsl(43,100%,50%)]/10 text-[hsl(43,100%,50%)] border-[hsl(43,100%,50%)]/30",
  rest: "bg-[hsl(173,80%,40%)]/10 text-[hsl(173,80%,40%)] border-[hsl(173,80%,40%)]/30",
  socialize: "bg-[hsl(280,80%,60%)]/10 text-[hsl(280,80%,60%)] border-[hsl(280,80%,60%)]/30",
  work: "bg-[hsl(210,100%,50%)]/10 text-[hsl(210,100%,50%)] border-[hsl(210,100%,50%)]/30",
  sleep: "bg-[hsl(220,70%,55%)]/10 text-[hsl(220,70%,55%)] border-[hsl(220,70%,55%)]/30",
  heal: "bg-[hsl(0,80%,55%)]/10 text-[hsl(0,80%,55%)] border-[hsl(0,80%,55%)]/30",
  idle: "bg-muted/50 text-muted-foreground border-border",
  study: "bg-[hsl(270,70%,60%)]/10 text-[hsl(270,70%,60%)] border-[hsl(270,70%,60%)]/30",
  relax: "bg-[hsl(120,60%,45%)]/10 text-[hsl(120,60%,45%)] border-[hsl(120,60%,45%)]/30",
  pray: "bg-[hsl(35,90%,55%)]/10 text-[hsl(35,90%,55%)] border-[hsl(35,90%,55%)]/30",
  rob: "bg-[hsl(0,80%,40%)]/10 text-[hsl(0,80%,55%)] border-[hsl(0,80%,55%)]/30",
  robbed: "bg-[hsl(0,80%,40%)]/10 text-[hsl(0,80%,40%)] border-[hsl(0,80%,40%)]/30",
  call_police: "bg-[hsl(210,100%,50%)]/10 text-[hsl(210,100%,50%)] border-[hsl(210,100%,50%)]/30",
  jailed: "bg-[hsl(0,0%,40%)]/10 text-[hsl(0,0%,60%)] border-[hsl(0,0%,40%)]/30",
};

function NeedsBar({ label, value, icon: Icon, color }: { label: string; value: number; icon: LucideIcon; color: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="w-3 h-3" />
          {label}
        </div>
        <span className="font-medium tabular-nums" style={{ color }}>{value.toFixed(0)}</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${value}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const agentId = parseInt(id ?? "0", 10);

  const { data: agent, isLoading } = useGetAgent(agentId, {
    query: {
      queryKey: getGetAgentQueryKey(agentId),
      enabled: !!agentId,
      refetchInterval: 10000,
    },
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <div className="h-6 w-48 bg-muted rounded animate-pulse" />
        <div className="h-32 bg-card border border-card-border rounded animate-pulse" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Агент не найден</p>
        <button onClick={() => navigate("/agents")} className="mt-3 text-xs text-primary">Назад к списку</button>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5 max-w-2xl">
      <button
        onClick={() => navigate("/agents")}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-3 h-3" /> Назад к жителям
      </button>

      <div className="bg-card border border-card-border rounded p-5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded bg-primary/10 border border-primary/20 flex items-center justify-center">
              <User className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-foreground">{agent.name}</h1>
              <p className="text-xs text-muted-foreground">{agent.gender === "male" ? "Мужчина" : "Женщина"} · {agent.age} лет</p>
              <div className="flex items-center gap-1.5 mt-1">
                <span className={cn("px-1.5 py-0.5 text-[10px] font-medium rounded border capitalize", TEMPERAMENT_COLORS[agent.personality] ?? "bg-muted/50 text-muted-foreground border-border")}>
                  {agent.personality}
                </span>
                <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">
                  {agent.socialization >= 50 ? "Экстраверт" : "Интроверт"} ({agent.socialization.toFixed(0)})
                </span>
              </div>
            </div>
          </div>
          <span className={cn("px-2 py-1 text-[10px] font-medium rounded border", ACTION_COLORS[agent.currentAction] ?? ACTION_COLORS.idle)}>
            {ACTION_LABELS[agent.currentAction] ?? agent.currentAction}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-4 mt-5">
          <div className="text-center">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Настроение</p>
            <p className="text-xl font-bold text-[hsl(43,100%,50%)]">{agent.mood.toFixed(1)}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Деньги</p>
            <p className="text-xl font-bold text-[hsl(173,80%,40%)]">{agent.money.toFixed(0)}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Социализация</p>
            <p className="text-xl font-bold text-foreground">{agent.socialization.toFixed(0)}</p>
          </div>
        </div>
      </div>

      {(agent.strength != null || agent.intelligence != null) && (
        <div className="bg-card border border-card-border rounded p-4 space-y-3">
          <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Атрибуты</h2>
          <div className="grid grid-cols-2 gap-4">
            {agent.strength != null && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Bolt className="w-3 h-3 text-[hsl(43,100%,50%)]" />
                  <span className="text-xs text-muted-foreground">Сила</span>
                  <span className="ml-auto text-xs font-semibold text-[hsl(43,100%,50%)]">{agent.strength.toFixed(0)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-[hsl(43,100%,50%)]" style={{ width: `${agent.strength}%` }} />
                </div>
                <p className="text-[10px] text-muted-foreground/60">Влияет на ограбление и износ здоровья</p>
              </div>
            )}
            {agent.intelligence != null && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Brain className="w-3 h-3 text-[hsl(270,70%,60%)]" />
                  <span className="text-xs text-muted-foreground">Интеллект</span>
                  <span className="ml-auto text-xs font-semibold text-[hsl(270,70%,60%)]">{agent.intelligence.toFixed(0)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-[hsl(270,70%,60%)]" style={{ width: `${agent.intelligence}%` }} />
                </div>
                <p className="text-[10px] text-muted-foreground/60">Ускоряет обучение и продвижение по карьере</p>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="bg-card border border-card-border rounded p-4 space-y-4">
        <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Потребности</h2>
        <NeedsBar label="Здоровье" value={agent.needs.health} icon={ShieldPlus} color="hsl(0,80%,55%)" />
        <NeedsBar label="Сон" value={agent.needs.sleep} icon={Moon} color="hsl(220,70%,55%)" />
        <NeedsBar label="Голод" value={agent.needs.hunger} icon={Coffee} color="hsl(43,100%,50%)" />
        <NeedsBar label="Комфорт" value={agent.needs.comfort} icon={Heart} color="hsl(173,80%,40%)" />
        <NeedsBar label="Общение" value={agent.needs.social} icon={Users} color="hsl(280,80%,60%)" />
        {agent.needs.education != null && (
          <NeedsBar label="Образование" value={agent.needs.education} icon={BookOpen} color="hsl(270,70%,60%)" />
        )}
        {agent.needs.entertainment != null && (
          <NeedsBar label="Развлечения" value={agent.needs.entertainment} icon={Gamepad2} color="hsl(120,60%,45%)" />
        )}
        {agent.needs.financialSafety != null && (
          <NeedsBar label="Фин. безопасность" value={agent.needs.financialSafety} icon={Banknote} color="hsl(142,60%,45%)" />
        )}
        {agent.needs.housingSafety != null && (
          <NeedsBar label="Жилищная безопасность" value={agent.needs.housingSafety} icon={Home} color="hsl(195,80%,45%)" />
        )}
        {agent.needs.physicalSafety != null && (
          <NeedsBar label="Физ. безопасность" value={agent.needs.physicalSafety} icon={Shield} color="hsl(0,80%,55%)" />
        )}
        {agent.needs.socialRating != null && (
          <NeedsBar label="Рейтинг среди жителей" value={agent.needs.socialRating} icon={Users} color="hsl(280,80%,60%)" />
        )}
        {agent.needs.faith != null && (
          <NeedsBar label="Вера" value={agent.needs.faith} icon={Star} color="hsl(35,90%,55%)" />
        )}
        {agent.needs.wellbeing != null && (
          <NeedsBar label="Благосостояние" value={agent.needs.wellbeing} icon={TrendingUp} color="hsl(170,70%,45%)" />
        )}
      </div>

      {/* ── Consumer preference matrix ──────────────────────────────────────── */}
      {(() => {
        const pIdx = getPersonalityIndex(agent.personality, agent.socialization);
        const rows: Array<{ label: string; key: string }> = [
          { label: "Еда и напитки", key: "food" },
          { label: "Бытовые услуги", key: "service" },
          { label: "Досуг и развлечения", key: "park" },
        ];
        return (
          <div className="bg-card border border-card-border rounded p-4 space-y-3">
            <div className="flex items-center gap-2">
              <ShoppingBasket className="w-3.5 h-3.5 text-muted-foreground" />
              <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Потребительский профиль</h2>
            </div>
            <div className="space-y-2">
              {rows.map(({ label, key }) => {
                const tier = CONSUMER_MATRIX[key]?.[pIdx];
                if (!tier) return null;
                const [price, quality] = tier;
                return (
                  <div key={key} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{label}</span>
                    <div className="flex items-center gap-2">
                      <span className={cn("font-medium", PRICE_COLORS[price])}>Цена: {price}</span>
                      <span className="text-muted-foreground/40">·</span>
                      <span className={cn("font-medium", QUALITY_COLORS[quality])}>Качество: {quality}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground/60 pt-1">
              85% вероятность покупки в предпочтительной категории · 15% — случайная
            </p>
          </div>
        );
      })()}

      <div className="bg-card border border-card-border rounded p-4 space-y-3">
        <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">Карьера</h2>

        {/* Grade + ambition row */}
        {(() => {
          const GRADE_LABELS: Record<number, string> = { 1: "Рабочий", 2: "Менеджер", 3: "Бригадир", 4: "Директор", 5: "Владелец" };
          const GRADE_COLORS: Record<number, string> = { 1: "hsl(173,60%,35%)", 2: "hsl(173,70%,38%)", 3: "hsl(43,90%,45%)", 4: "hsl(43,100%,50%)", 5: "hsl(0,80%,55%)" };
          const level = agent.careerLevel ?? 1;
          const target = agent.targetCareerLevel ?? 1;
          const ambition = agent.ambition ?? 50;
          const SALARY_MULT = [1.0, 2.0, 3.5, 6.0, 10.0];
          const salaryMult = SALARY_MULT[Math.min(4, level - 1)] ?? 1.0;
          return (
            <div className="space-y-2">
              {/* Grade progress */}
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  <Award className="w-3.5 h-3.5" style={{ color: GRADE_COLORS[level] }} />
                  <span className="font-semibold" style={{ color: GRADE_COLORS[level] }}>{GRADE_LABELS[level] ?? `Грейд ${level}`}</span>
                  <span className="text-muted-foreground">· Грейд {level}</span>
                </div>
                <span className="text-muted-foreground text-[10px]">Цель: {GRADE_LABELS[target] ?? `Грейд ${target}`} ({target})</span>
              </div>
              {/* Grade bar */}
              <div className="flex gap-0.5">
                {[1,2,3,4,5].map(g => (
                  <div key={g} className="flex-1 h-1.5 rounded-sm"
                    style={{ background: g <= level ? GRADE_COLORS[g] : g <= target ? "hsl(173,30%,22%)" : "hsl(220,10%,20%)" }} />
                ))}
              </div>
              {/* Salary multiplier + ambition */}
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>Зарплатный множитель: <span className="text-foreground font-medium">×{salaryMult.toFixed(1)}</span></span>
                <span>Амбиции: <span className="text-[hsl(43,90%,50%)] font-medium">{ambition}</span>/100</span>
              </div>
            </div>
          );
        })()}

        {/* Current employment status */}
        <div className="flex items-start gap-3 pt-1 border-t border-border/30">
          {agent.isRetired ? (
            <div className="flex items-center gap-2 text-xs">
              <Sunset className="w-4 h-4 text-[hsl(43,100%,50%)] shrink-0" />
              <div>
                <span className="text-[hsl(43,100%,50%)] font-medium">На пенсии</span>
                <p className="text-muted-foreground mt-0.5">Завершил трудовую деятельность</p>
              </div>
            </div>
          ) : agent.employerId != null ? (
            <div className="flex-1">
              <div className="flex items-center gap-2 text-xs mb-2">
                <Briefcase className="w-3.5 h-3.5 text-[hsl(173,80%,40%)] shrink-0" />
                <span className="font-medium text-[hsl(173,80%,40%)]">Работает</span>
              </div>
              <p className="text-sm font-medium text-foreground">{agent.employerName ?? `Бизнес #${agent.employerId}`}</p>
              {agent.jobTenure != null && (
                <div className="flex items-center gap-1.5 mt-1 text-[10px] text-muted-foreground">
                  <Clock className="w-3 h-3" />
                  <span>Стаж: {Math.floor(agent.jobTenure / 24)} дн. {agent.jobTenure % 24} ч.</span>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs">
              <Briefcase className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">Безработный · ищет работу</span>
            </div>
          )}
        </div>

        {/* Career stats */}
        <div className="grid grid-cols-3 gap-2 pt-1 border-t border-border/30">
          <div className="text-center">
            <p className="text-lg font-bold text-foreground">{agent.totalJobs ?? 0}</p>
            <p className="text-[10px] text-muted-foreground">мест работы</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-[hsl(43,100%,50%)]">{agent.promotions ?? 0}</p>
            <p className="text-[10px] text-muted-foreground">повышений</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-foreground">{agent.jobHistory?.filter((e: JobHistoryEntry) => e.event === "quit").length ?? 0}</p>
            <p className="text-[10px] text-muted-foreground">уволился сам</p>
          </div>
        </div>
      </div>

      {agent.recentActions && agent.recentActions.length > 0 && (
        <div className="bg-card border border-card-border rounded p-4">
          <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground mb-3">
            Последние действия
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {[...agent.recentActions].reverse().map((action, i) => (
              <span
                key={i}
                className={cn(
                  "px-2 py-0.5 text-[10px] rounded border",
                  i === 0
                    ? ACTION_COLORS[action] ?? "bg-muted/50 text-muted-foreground border-border"
                    : "bg-muted/30 text-muted-foreground border-border/50"
                )}
              >
                {ACTION_LABELS[action] ?? action}
              </span>
            ))}
          </div>
        </div>
      )}

      {agent.jobHistory && agent.jobHistory.length > 0 && (
        <div className="bg-card border border-card-border rounded p-4">
          <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground mb-3">
            Карьерный путь ({agent.jobHistory.length})
          </h2>
          <div className="space-y-0">
            {agent.jobHistory.map((entry: JobHistoryEntry, i: number) => {
              const isHired      = entry.event === "hired";
              const isFired      = entry.event === "fired";
              const isRetiredEvt = entry.event === "retired";
              const isQuit       = entry.event === "quit";
              const isPromoted   = entry.event === "promoted";
              const gameDay = Math.floor(entry.tick / 24) + 1;
              const durationDays = entry.duration != null ? Math.floor(entry.duration / 24) : null;
              return (
                <div key={i} className="flex items-start gap-3 py-2 border-b border-border/30 last:border-0">
                  <div className="mt-0.5 shrink-0">
                    {isHired      && <LogIn      className="w-3.5 h-3.5 text-[hsl(173,80%,40%)]" />}
                    {isFired      && <LogOut     className="w-3.5 h-3.5 text-destructive" />}
                    {isRetiredEvt && <Sunset     className="w-3.5 h-3.5 text-[hsl(43,100%,50%)]" />}
                    {isQuit       && <DoorOpen   className="w-3.5 h-3.5 text-[hsl(280,80%,60%)]" />}
                    {isPromoted   && <TrendingUp className="w-3.5 h-3.5 text-[hsl(120,60%,45%)]" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn(
                        "text-xs font-medium",
                        isHired      && "text-[hsl(173,80%,40%)]",
                        isFired      && "text-destructive",
                        isRetiredEvt && "text-[hsl(43,100%,50%)]",
                        isQuit       && "text-[hsl(280,80%,60%)]",
                        isPromoted   && "text-[hsl(120,60%,45%)]",
                      )}>
                        {isHired ? "Принят на работу" : isFired ? "Уволен" : isRetiredEvt ? "Вышел на пенсию" : isQuit ? "Уволился сам" : "Повышен"}
                      </span>
                      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">День {gameDay}</span>
                    </div>
                    {entry.businessName && (
                      <p className="text-[10px] text-muted-foreground truncate mt-0.5">{entry.businessName}</p>
                    )}
                    {durationDays != null && durationDays > 0 && (
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                        проработал {durationDays} дн.
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {agent.relations && agent.relations.length > 0 && (
        <div className="bg-card border border-card-border rounded p-4">
          <h2 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground mb-3">
            Связи ({agent.relations.length})
          </h2>
          <div className="space-y-2">
            {agent.relations.map((rel: AgentRelation) => (
              <div key={rel.otherId} className="flex items-center justify-between text-xs py-1 border-b border-border/50 last:border-0">
                <span className="text-foreground">{rel.otherName}</span>
                <div className="flex items-center gap-2">
                  <div className="w-20 h-1 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[hsl(173,80%,40%)] rounded-full"
                      style={{ width: `${rel.friendshipLevel}%` }}
                    />
                  </div>
                  <span className="text-muted-foreground tabular-nums w-8 text-right">{rel.friendshipLevel.toFixed(0)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
