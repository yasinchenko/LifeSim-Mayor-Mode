import { db, sqlite } from "@workspace/db";
import {
  agentsTable,
  needsTable,
  relationsTable,
  businessesTable,
  goodsTable,
  simStateTable,
  simConfigTable,
  dailyDecreesTable,
  statsHistoryTable,
  agentStatHistoryTable,
  type Agent,
  type Needs,
  type Business,
  type Good,
} from "@workspace/db";
import { and, eq, inArray, or } from "drizzle-orm";
import { logger } from "./logger";

export interface SimulationConfig {
  taxRate: number;
  needDecayRate: number;
  tickIntervalMs: number;
  initialAgents: number;
  initialBusinesses: number;
  baseFoodPrice: number;
  baseSalary: number;
  subsidyAmount: number;
  socialInteractionStrength: number;
  priceMarkup: number;
  pensionRate: number;
}

const DEFAULT_CONFIG: SimulationConfig = {
  taxRate: 0.15,
  needDecayRate: 5,
  tickIntervalMs: 60000,
  initialAgents: 1000,
  initialBusinesses: 80,
  baseFoodPrice: 10,
  baseSalary: 50,
  subsidyAmount: 15,
  socialInteractionStrength: 2,
  priceMarkup: 0.2,
  pensionRate: 0.15,
};

const AGENT_SORT_KEYS = ["name", "age", "mood", "money", "currentAction"] as const;
type AgentSortKey = typeof AGENT_SORT_KEYS[number];

interface JobHistoryEntry {
  tick: number;
  event: "hired" | "fired" | "retired" | "quit" | "promoted";
  businessId: number | null;
  businessName: string | null;
  duration?: number;
}

interface AgentState extends Omit<Agent, "jobHistory"> {
  needs: { hunger: number; comfort: number; social: number; health: number; sleep: number; education: number; entertainment: number; faith: number; housingSafety: number; financialSafety: number; physicalSafety: number; socialRating: number; wellbeing: number };
  needsId: number;
  recentActions: string[];
  jobHistory: JobHistoryEntry[];
  jobStartTick: number | null;
  // careerLevel and ambition come from Agent (DB schema)
  jailedUntilTick: number | null; // in-memory only — resets on restart
}

interface BusinessState extends Business {
  employeeCount: number;
  maxEmployees: number;      // computed from type, not stored in DB
  firedThisTick: number;
  hiredThisTick: number;
  ticksUnprofitable: number; // how many consecutive ticks with negative balance
  hasReceivedBailout: boolean; // one-time survival grant — never paid twice
}

// Max hiring capacity per business type — derived from the design spec table
// (grades Рабочий/Менеджер/Бригадир/Директор/Владелец per business type).
// Each value = sum of all role caps in the corresponding table column.
// Column mapping: food≈col1(64), service≈col5(39), hospital≈col3(27),
//   park≈col4(63), temple≈col2(22), farm≈col6(95), school≈col7(31), workshop≈col8(30)
// Public-sector caps are intentionally small so the total government subsidy
// bill stays within the tax-revenue budget.  With baseSalary=50, taxRate=15%,
// and ~1000 agents the sustainable per-business headcount is roughly:
//   maxEmp * baseSalary * subsidyMult ≤ (avg_wage * employed * taxRate) / numPublicBiz
// Commercial (food/service) caps set the market size for consumer goods.
// Staffing table: максимальное кол-во мест по каждому грейду на тип бизнеса.
// Повышение в грейд возможно ТОЛЬКО если есть вакантное место на этом грейде.
// Источник: штатное расписание (изображение пользователя + адаптация для госсектора).
const STAFFING_TABLE: Record<string, Record<number, number>> = {
  workshop: { 1: 4,  2: 1,  3: 1, 4: 0, 5: 0 },  // Производственный кластер  (итого 6)
  farm:     { 1: 3,  2: 1,  3: 0, 4: 0, 5: 0 },  // Фермерский кластер        (итого 4)
  food:     { 1: 4,  2: 1,  3: 1, 4: 0, 5: 0 },  // Фабрика пищи              (итого 6)
  service:  { 1: 7,  2: 2,  3: 1, 4: 0, 5: 0 },  // Фабрика бытовых товаров   (итого 10)
  hospital: { 1: 3,  2: 6,  3: 2, 4: 1, 5: 0 },  // Больница (адм. модель)    (итого 12)
  park:     { 1: 4,  2: 8,  3: 2, 4: 1, 5: 0 },  // Парк (адм. модель)        (итого 15)
  school:   { 1: 3,  2: 6,  3: 2, 4: 1, 5: 0 },  // Школа (адм. модель)       (итого 12)
  temple:   { 1: 3,  2: 3,  3: 1, 4: 1, 5: 0 },  // Храм (малая орг.)         (итого 8)
};

// MAX_EMPLOYEES автоматически выводится как сумма всех слотов штатного расписания.
const MAX_EMPLOYEES_BY_TYPE: Record<string, number> = Object.fromEntries(
  Object.entries(STAFFING_TABLE).map(([type, slots]) => [
    type, Object.values(slots).reduce((s, n) => s + n, 0),
  ])
);

// Business types funded by government subsidy.  Grade caps are enforced through
// the STAFFING_TABLE (e.g. hospital grade-5 slots = 0, grade-4 = 1 Director).
const PUBLIC_SECTOR_TYPES = new Set(["school", "park", "hospital", "temple"]);

// Fixed one-time costs to open a new business (paid from agent savings or government grant).
// Raw producers cost more (land, equipment) while service businesses are cheapest to start.
const BUSINESS_LAUNCH_COSTS: Record<string, number> = {
  farm:     1800,
  workshop: 2200,
  food:     2000,
  service:  1500,
};

interface GoodState extends Good {}

interface SimState {
  tick: number;
  running: boolean;
  gameHour: number;
  gameDay: number;
  scenarioType: ScenarioType;
  goalType: GoalType;
  dayLimit: number;
  gameStatus: GameStatus;
  gameOutcomeReason: string | null;
  actionPointsRemaining: number;
  actionPointsMax: number;
  governmentBudget: number;
  totalTaxCollected: number;
  totalSubsidiesPaid: number;
  totalPensionPaid: number;
  totalPublicServicesPaid: number;
}

type ScenarioType = "balanced" | "crisis" | "growth" | "stability";
type GoalType =
  | "balanced"
  | "crisis_recovery"
  | "economic_growth"
  | "market_growth"
  | "social_stability"
  | "force_order"
  | "corruption_network";
type GameStatus = "active" | "victory" | "defeat";

interface NewGameOptions {
  scenarioType: ScenarioType;
  goalType: GoalType;
  dayLimit: number;
}

interface SaveSlotSummary {
  tick: number;
  gameDay: number;
  gameHour: number;
  scenarioType: ScenarioType;
  goalType: GoalType;
  gameStatus: GameStatus;
  goalProgress: number;
  population: number;
  governmentBudget: number;
}

interface GoalEvaluation {
  status: GameStatus;
  reason: string | null;
  progress: number;
  residentsScore: number;
  businessScore: number;
  governmentScore: number;
}

type DailyDecreeStatus = "pending" | "active" | "expired";
type DailyDecisionSide = "residents" | "business" | "government";
type DailyEventTone = "critical" | "warning" | "opportunity";
type DailyDecisionActivity =
  | "resident_requests"
  | "budget_session"
  | "crisis_staff"
  | "business_talks"
  | "city_news";
type DecisionEffectKind =
  | "need_decay_multiplier"
  | "social_multiplier"
  | "tax_delta"
  | "subsidy_multiplier"
  | "daily_need_delta"
  | "daily_business_delta"
  | "budget_delta"
  | "public_quality_delta"
  | "food_supply_delta";

interface DecisionEffect {
  kind: DecisionEffectKind;
  label: string;
  value: number;
  need?: keyof AgentState["needs"];
  businessType?: string;
}

interface DailyDecisionDefinition {
  id: string;
  title: string;
  side: DailyDecisionSide;
  sideLabel: string;
  category: "social" | "economy" | "safety" | "infrastructure";
  activity: DailyDecisionActivity;
  responseLabel: string;
  description: string;
  impactSummary: string;
  tradeoff: string;
  actionPointCost: number;
  budgetCost: number;
  cooldownDays: number;
  delayDays: number;
  durationDays: number;
  effects: DecisionEffect[];
  sideEffects?: DailyDecisionSideEffect[];
}

interface DailyEventCard {
  id: DailyDecisionSide;
  side: DailyDecisionSide;
  sideLabel: string;
  title: string;
  eventText: string;
  daySummary: string;
  tone: DailyEventTone;
  activity: DailyDecisionActivity;
  decisionIds: string[];
}

interface DailyDecisionSideEffect {
  title: string;
  description: string;
  delayDays: number;
  durationDays: number;
  effects: DecisionEffect[];
}

type FactionDemandStatus = "active" | "completed" | "ignored";

interface FactionDemandOutcome {
  label: string;
  budgetDelta: number;
  effects: DecisionEffect[];
  pressureDelta: number;
}

interface FactionDemandRecord {
  id: string;
  side: DailyDecisionSide;
  sideLabel: string;
  title: string;
  description: string;
  requirement: string;
  pressure: number;
  createdDay: number;
  deadlineDay: number;
  status: FactionDemandStatus;
  resolvedDay: number | null;
  resolutionLabel: string | null;
  reward: FactionDemandOutcome;
  penalty: FactionDemandOutcome;
}

interface DailyDecreeRecord {
  id: number;
  decisionId: string;
  title: string;
  description: string;
  status: DailyDecreeStatus;
  issuedDay: number;
  startDay: number;
  endDay: number;
  actionPointCost: number;
  budgetCost: number;
  cooldownDays: number;
  effects: DecisionEffect[];
}

type ResidentRequestCategory = "finance" | "work" | "food" | "health" | "comfort" | "safety";
type ResidentRequestAction = "help" | "decline";

interface ResidentRequestRecord {
  id: string;
  agentId: number;
  residentName: string;
  residentAge: number;
  district: string;
  category: ResidentRequestCategory;
  categoryLabel: string;
  problem: string;
  need?: keyof AgentState["needs"];
  helpCost: number;
  createdTick: number;
  createdDay: number;
}

interface DecisionModifiers {
  needDecayMultiplier: number;
  socialMultiplier: number;
  taxDelta: number;
  subsidyMultiplier: number;
}

const DAILY_ACTION_POINTS_MAX = 1;
const RESIDENT_REQUEST_BUFFER_MAX = 30;
const RESIDENT_REQUEST_DISTRICTS = [
  "Северный квартал",
  "Старый центр",
  "Рабочая слобода",
  "Южные дома",
  "Прибрежный район",
  "Новый массив",
];
const RESIDENT_REQUEST_CATEGORY_LABELS: Record<ResidentRequestCategory, string> = {
  finance: "Финансы",
  work: "Работа",
  food: "Еда",
  health: "Здоровье",
  comfort: "Комфорт",
  safety: "Безопасность",
};

const DAILY_DECISION_CATALOG: DailyDecisionDefinition[] = [
  {
    id: "residents_targeted_aid",
    title: "Адресная помощь",
    side: "residents",
    sideLabel: "Жители",
    category: "social",
    activity: "resident_requests",
    responseLabel: "Принять обращения в работу",
    description: "Мэрия быстро закрывает самые острые бытовые обращения и помогает семьям, которые просели сильнее остальных.",
    impactSummary: "+жители, +благополучие, -бюджет",
    tradeoff: "Бизнес не получает поддержки сегодня, а часть спроса на еду может вырасти.",
    actionPointCost: 1,
    budgetCost: 1400,
    cooldownDays: 2,
    delayDays: 0,
    durationDays: 2,
    effects: [
      { kind: "daily_need_delta", need: "wellbeing", label: "Благополучие жителей ежедневно растет", value: 0.8 },
      { kind: "daily_need_delta", need: "financialSafety", label: "Финансовая безопасность немного восстанавливается", value: 0.7 },
    ],
    sideEffects: [
      {
        title: "Усталость бюджета после адресной помощи",
        description: "Через несколько дней финансовый отдел ужесточает мелкие программы, чтобы компенсировать срочные выплаты.",
        delayDays: 3,
        durationDays: 4,
        effects: [
          { kind: "subsidy_multiplier", label: "Компенсационная экономия снижает гибкость субсидий", value: 0.96 },
          { kind: "daily_need_delta", need: "socialRating", label: "Часть жителей замечает, что помощь дошла не до всех", value: -0.18 },
        ],
      },
    ],
  },
  {
    id: "residents_food_subsidy",
    title: "Временные субсидии на еду",
    side: "residents",
    sideLabel: "Жители",
    category: "social",
    activity: "budget_session",
    responseLabel: "Выделить короткую субсидию",
    description: "На два дня усиливается продовольственная поддержка, чтобы сгладить рост цен и нехватку доступной еды.",
    impactSummary: "+жители, +еда, -бюджет",
    tradeoff: "Расходы растут сразу, а бизнес может привыкнуть к повышенному спросу.",
    actionPointCost: 1,
    budgetCost: 1100,
    cooldownDays: 3,
    delayDays: 0,
    durationDays: 2,
    effects: [
      { kind: "need_decay_multiplier", label: "Базовые потребности проседают медленнее", value: 0.94 },
      { kind: "subsidy_multiplier", label: "Ежедневные субсидии временно усилены", value: 1.12 },
    ],
    sideEffects: [
      {
        title: "Привыкание рынка к продовольственной поддержке",
        description: "После всплеска спроса магазины осторожнее снижают цены и часть семей снова чувствует давление бюджета.",
        delayDays: 4,
        durationDays: 4,
        effects: [
          { kind: "daily_need_delta", need: "financialSafety", label: "Расходы семей на еду снова давят на кошельки", value: -0.22 },
          { kind: "tax_delta", label: "Город временно компенсирует расходы сбором", value: 0.008 },
        ],
      },
    ],
  },
  {
    id: "residents_public_promise",
    title: "Публичное обещание",
    side: "residents",
    sideLabel: "Жители",
    category: "social",
    activity: "city_news",
    responseLabel: "Выступить с публичной реакцией",
    description: "Мэр признает проблему и обещает адресный план. Это дешевле прямой помощи, но эффект в основном репутационный.",
    impactSummary: "+настроение, +доверие, слабый эффект",
    tradeoff: "Без реальных расходов проблема может вернуться через пару дней.",
    actionPointCost: 1,
    budgetCost: 0,
    cooldownDays: 2,
    delayDays: 0,
    durationDays: 1,
    effects: [
      { kind: "daily_need_delta", need: "socialRating", label: "Социальная оценка власти немного растет", value: 0.8 },
      { kind: "daily_need_delta", need: "wellbeing", label: "Настроение стабилизируется за счет коммуникации", value: 0.4 },
    ],
    sideEffects: [
      {
        title: "Проверка обещаний",
        description: "Если за словами не последуют заметные изменения, общественная оценка понемногу откатывается.",
        delayDays: 3,
        durationDays: 3,
        effects: [
          { kind: "daily_need_delta", need: "socialRating", label: "Невыполненные ожидания давят на доверие", value: -0.25 },
        ],
      },
    ],
  },
  {
    id: "residents_mobile_clinics",
    title: "Мобильные медбригады",
    side: "residents",
    sideLabel: "Жители",
    category: "social",
    activity: "crisis_staff",
    responseLabel: "Отправить врачей в районы",
    description: "Временные бригады закрывают самые слабые точки по здоровью и разгружают больницы.",
    impactSummary: "+здоровье, +доверие, -бюджет",
    tradeoff: "После кампании останется нагрузка на расписание больниц и закупки.",
    actionPointCost: 1,
    budgetCost: 1300,
    cooldownDays: 4,
    delayDays: 0,
    durationDays: 3,
    effects: [
      { kind: "daily_need_delta", need: "health", label: "Здоровье жителей ежедневно улучшается", value: 0.75 },
      { kind: "daily_need_delta", need: "wellbeing", label: "Люди спокойнее относятся к медицинским рискам", value: 0.35 },
    ],
    sideEffects: [
      {
        title: "Медицинская очередь после рейдов",
        description: "Выявленные проблемы создают хвост обращений, и больницы несколько дней работают напряженнее.",
        delayDays: 3,
        durationDays: 5,
        effects: [
          { kind: "public_quality_delta", businessType: "hospital", label: "Больницы временно теряют качество из-за перегруза", value: -0.22 },
          { kind: "daily_need_delta", need: "sleep", label: "Персонал и семьи хуже восстанавливаются", value: -0.12 },
        ],
      },
    ],
  },
  {
    id: "residents_housing_repairs",
    title: "Аварийный ремонт дворов",
    side: "residents",
    sideLabel: "Жители",
    category: "infrastructure",
    activity: "resident_requests",
    responseLabel: "Закрыть опасные адреса",
    description: "Город быстро чинит подъезды, освещение и дворы там, где безопасность жилья просела сильнее всего.",
    impactSummary: "+жилье, +комфорт, эффект завтра",
    tradeoff: "Работы создают шум и временно поднимают коммунальное раздражение.",
    actionPointCost: 1,
    budgetCost: 1700,
    cooldownDays: 5,
    delayDays: 1,
    durationDays: 4,
    effects: [
      { kind: "daily_need_delta", need: "housingSafety", label: "Безопасность жилья заметно растет", value: 0.85 },
      { kind: "daily_need_delta", need: "comfort", label: "Комфорт дворов и домов восстанавливается", value: 0.35 },
    ],
    sideEffects: [
      {
        title: "Ремонтная усталость районов",
        description: "Пока подрядчики заканчивают хвосты, жители жалуются на шум и перекрытые проходы.",
        delayDays: 2,
        durationDays: 3,
        effects: [
          { kind: "daily_need_delta", need: "sleep", label: "Шум ремонта немного ухудшает сон", value: -0.22 },
          { kind: "daily_need_delta", need: "wellbeing", label: "Бытовое раздражение временно растет", value: -0.18 },
        ],
      },
    ],
  },
  {
    id: "residents_quiet_evenings",
    title: "Тихие вечера",
    side: "residents",
    sideLabel: "Жители",
    category: "safety",
    activity: "city_news",
    responseLabel: "Ограничить ночной шум",
    description: "Мэрия вводит короткий режим тишины и усиливает работу с конфликтными точками вечером.",
    impactSummary: "+сон, +безопасность, -сервисы",
    tradeoff: "Сервисный бизнес теряет часть вечерней выручки и может отложить найм.",
    actionPointCost: 1,
    budgetCost: 400,
    cooldownDays: 4,
    delayDays: 0,
    durationDays: 3,
    effects: [
      { kind: "daily_need_delta", need: "sleep", label: "Сон жителей восстанавливается быстрее", value: 0.7 },
      { kind: "daily_need_delta", need: "physicalSafety", label: "Вечерняя безопасность немного улучшается", value: 0.35 },
      { kind: "daily_business_delta", businessType: "service", label: "Сервисные компании теряют вечерний оборот", value: -35 },
    ],
    sideEffects: [
      {
        title: "Сервисный отскок после режима тишины",
        description: "После ограничений часть сервисных компаний несколько дней осторожничает с расписанием.",
        delayDays: 3,
        durationDays: 4,
        effects: [
          { kind: "daily_business_delta", businessType: "service", label: "Сервисный бизнес медленнее возвращает оборот", value: -25 },
        ],
      },
    ],
  },
  {
    id: "business_micro_grants",
    title: "Малые гранты бизнесу",
    side: "business",
    sideLabel: "Бизнес",
    category: "economy",
    activity: "business_talks",
    responseLabel: "Поддержать закрывающиеся компании",
    description: "Мэрия выдает короткие гранты компаниям с кассовыми разрывами, чтобы снизить риск увольнений и закрытий.",
    impactSummary: "+бизнес, +занятость, -бюджет",
    tradeoff: "Жители не получают прямой помощи сегодня.",
    actionPointCost: 1,
    budgetCost: 1600,
    cooldownDays: 3,
    delayDays: 0,
    durationDays: 2,
    effects: [
      { kind: "daily_business_delta", businessType: "service", label: "Сервисные компании получают стабилизационные выплаты", value: 80 },
      { kind: "daily_business_delta", businessType: "food", label: "Пищевые бизнесы получают малую поддержку", value: 60 },
    ],
    sideEffects: [
      {
        title: "Зависимость от грантов",
        description: "Компании, привыкшие к быстрым выплатам, слабее режут расходы после завершения поддержки.",
        delayDays: 3,
        durationDays: 5,
        effects: [
          { kind: "daily_business_delta", businessType: "service", label: "Сервисные компании медленнее перестраиваются без грантов", value: -22 },
          { kind: "daily_business_delta", businessType: "food", label: "Пищевой бизнес осторожнее держит запас денег", value: -18 },
        ],
      },
    ],
  },
  {
    id: "business_tax_relief",
    title: "Снижение налоговой нагрузки",
    side: "business",
    sideLabel: "Бизнес",
    category: "economy",
    activity: "business_talks",
    responseLabel: "Дать рынку передышку",
    description: "На пару дней налоговая нагрузка становится ниже, чтобы бизнес быстрее восстановил оборот.",
    impactSummary: "+бизнес, +производство, -доходы бюджета",
    tradeoff: "Бюджет будет собирать меньше налогов, а жители могут воспринять меру как подарок предпринимателям.",
    actionPointCost: 1,
    budgetCost: 0,
    cooldownDays: 4,
    delayDays: 0,
    durationDays: 2,
    effects: [
      { kind: "tax_delta", label: "Налоговая ставка временно ниже", value: -0.03 },
      { kind: "daily_business_delta", businessType: "workshop", label: "Производственные мастерские получают больше оборотных средств", value: 70 },
    ],
    sideEffects: [
      {
        title: "Недобор после налоговой передышки",
        description: "Бюджет несколько дней догоняет выпавшие доходы и хуже покрывает мягкие программы.",
        delayDays: 3,
        durationDays: 4,
        effects: [
          { kind: "subsidy_multiplier", label: "Компенсация недобора снижает субсидии", value: 0.95 },
          { kind: "daily_need_delta", need: "financialSafety", label: "Жители слабее чувствуют бюджетную защиту", value: -0.16 },
        ],
      },
    ],
  },
  {
    id: "business_supply_chain",
    title: "Поддержка цепочек поставок",
    side: "business",
    sideLabel: "Бизнес",
    category: "infrastructure",
    activity: "crisis_staff",
    responseLabel: "Собрать штаб по поставкам",
    description: "Город помогает фермам, мастерским и магазинам быстрее закрыть разрывы между спросом и предложением.",
    impactSummary: "+рынок, +еда, эффект завтра",
    tradeoff: "Эффект медленнее прямых грантов, а бюджет все равно платит за координацию.",
    actionPointCost: 1,
    budgetCost: 900,
    cooldownDays: 3,
    delayDays: 1,
    durationDays: 3,
    effects: [
      { kind: "food_supply_delta", label: "Запасы еды растут каждый день", value: 4 },
      { kind: "daily_business_delta", businessType: "farm", label: "Фермы получают логистическую поддержку", value: 55 },
      { kind: "daily_business_delta", businessType: "workshop", label: "Мастерские закрывают часть заказов", value: 45 },
    ],
    sideEffects: [
      {
        title: "Логистический хвост",
        description: "После ручного штаба поставщики несколько дней ждут координации сверху и хуже реагируют сами.",
        delayDays: 4,
        durationDays: 4,
        effects: [
          { kind: "food_supply_delta", label: "Запасы еды растут медленнее после ручного управления", value: -1.5 },
          { kind: "daily_business_delta", businessType: "farm", label: "Фермы теряют часть темпа без штаба", value: -18 },
        ],
      },
    ],
  },
  {
    id: "business_hiring_vouchers",
    title: "Ваучеры на найм",
    side: "business",
    sideLabel: "Бизнес",
    category: "economy",
    activity: "business_talks",
    responseLabel: "Компенсировать первые смены",
    description: "Город частично компенсирует первые дни найма, чтобы компании открывали вакансии быстрее.",
    impactSummary: "+занятость, +бизнес, -бюджет",
    tradeoff: "После окончания ваучеров слабые компании могут снова заморозить вакансии.",
    actionPointCost: 1,
    budgetCost: 1400,
    cooldownDays: 4,
    delayDays: 0,
    durationDays: 3,
    effects: [
      { kind: "daily_business_delta", businessType: "service", label: "Сервис получает деньги на первые смены", value: 55 },
      { kind: "daily_business_delta", businessType: "workshop", label: "Мастерские охотнее берут работников", value: 50 },
      { kind: "daily_need_delta", need: "financialSafety", label: "Перспектива работы снижает тревожность семей", value: 0.25 },
    ],
    sideEffects: [
      {
        title: "Проверка рабочих мест рынком",
        description: "Когда ваучеры заканчиваются, часть найма оказывается временной и настроение работников проседает.",
        delayDays: 4,
        durationDays: 4,
        effects: [
          { kind: "daily_need_delta", need: "financialSafety", label: "Неустойчивые вакансии снова тревожат работников", value: -0.25 },
          { kind: "daily_business_delta", businessType: "service", label: "Сервис пересматривает раздутые смены", value: -20 },
        ],
      },
    ],
  },
  {
    id: "business_fast_permits",
    title: "Быстрые разрешения",
    side: "business",
    sideLabel: "Бизнес",
    category: "infrastructure",
    activity: "budget_session",
    responseLabel: "Упростить согласования",
    description: "Мэрия на несколько дней ускоряет разрешения для расширения производств и сервисных точек.",
    impactSummary: "+оборот, +рынок, риск контроля",
    tradeoff: "Часть проверок переносится на потом, поэтому безопасность может получить отложенный удар.",
    actionPointCost: 1,
    budgetCost: 250,
    cooldownDays: 5,
    delayDays: 0,
    durationDays: 3,
    effects: [
      { kind: "daily_business_delta", businessType: "workshop", label: "Мастерские быстрее запускают заказы", value: 65 },
      { kind: "daily_business_delta", businessType: "service", label: "Сервис открывает дополнительные смены", value: 45 },
    ],
    sideEffects: [
      {
        title: "Долг проверок",
        description: "Перенесенные проверки возвращаются в виде замечаний и напряжения вокруг безопасности.",
        delayDays: 3,
        durationDays: 5,
        effects: [
          { kind: "daily_need_delta", need: "physicalSafety", label: "Ускоренные разрешения создают вопросы к безопасности", value: -0.22 },
          { kind: "daily_need_delta", need: "housingSafety", label: "Жители осторожнее оценивают среду", value: -0.12 },
        ],
      },
    ],
  },
  {
    id: "business_food_contracts",
    title: "Контракты на еду",
    side: "business",
    sideLabel: "Бизнес",
    category: "economy",
    activity: "crisis_staff",
    responseLabel: "Закупить у местных поставщиков",
    description: "Город заключает короткие контракты с фермами и пищевыми компаниями, чтобы выровнять полки.",
    impactSummary: "+еда, +фермы, -бюджет",
    tradeoff: "Закупки поднимают ожидания поставщиков и могут сделать рынок менее гибким.",
    actionPointCost: 1,
    budgetCost: 1000,
    cooldownDays: 4,
    delayDays: 0,
    durationDays: 3,
    effects: [
      { kind: "food_supply_delta", label: "Поставки еды в город растут", value: 5 },
      { kind: "daily_business_delta", businessType: "farm", label: "Фермы получают гарантированный спрос", value: 60 },
      { kind: "daily_business_delta", businessType: "food", label: "Пищевые компании быстрее пополняют оборот", value: 45 },
    ],
    sideEffects: [
      {
        title: "Жесткие ожидания поставщиков",
        description: "После контрактов поставщики несколько дней хуже идут на рыночные уступки.",
        delayDays: 4,
        durationDays: 4,
        effects: [
          { kind: "food_supply_delta", label: "Гибкость поставок временно падает", value: -1.25 },
          { kind: "daily_need_delta", need: "financialSafety", label: "Цены на еду снова давят на семьи", value: -0.15 },
        ],
      },
    ],
  },
  {
    id: "government_spending_audit",
    title: "Аудит расходов",
    side: "government",
    sideLabel: "Государство",
    category: "infrastructure",
    activity: "budget_session",
    responseLabel: "Проверить эффективность программ",
    description: "Финансовый отдел быстро пересматривает расходы и убирает лишние траты без резкого удара по службам.",
    impactSummary: "+устойчивость, ниже расходы",
    tradeoff: "Социальные программы получают меньше гибкости на время проверки.",
    actionPointCost: 1,
    budgetCost: 300,
    cooldownDays: 3,
    delayDays: 0,
    durationDays: 2,
    effects: [
      { kind: "subsidy_multiplier", label: "Субсидии расходуются строже", value: 0.93 },
      { kind: "public_quality_delta", businessType: "school", label: "Публичные службы работают собраннее", value: 0.35 },
    ],
    sideEffects: [
      {
        title: "Бумажная инерция аудита",
        description: "После проверки отделы несколько дней тратят силы на отчетность вместо гибкой реакции.",
        delayDays: 3,
        durationDays: 4,
        effects: [
          { kind: "public_quality_delta", businessType: "school", label: "Публичные службы временно устают от отчетности", value: -0.16 },
          { kind: "daily_need_delta", need: "socialRating", label: "Жители слабее видят быстрые решения", value: -0.12 },
        ],
      },
    ],
  },
  {
    id: "government_security_push",
    title: "Усиление безопасности",
    side: "government",
    sideLabel: "Государство",
    category: "safety",
    activity: "crisis_staff",
    responseLabel: "Усилить контроль в районах",
    description: "Город направляет дополнительные смены на безопасность и профилактику конфликтов.",
    impactSummary: "+безопасность, +стабильность, -бюджет",
    tradeoff: "Жители поддержат меру не все, а бизнес сегодня остается без стимулов.",
    actionPointCost: 1,
    budgetCost: 1200,
    cooldownDays: 3,
    delayDays: 0,
    durationDays: 2,
    effects: [
      { kind: "daily_need_delta", need: "physicalSafety", label: "Физическая безопасность жителей растет", value: 0.9 },
      { kind: "daily_need_delta", need: "housingSafety", label: "Безопасность жилья и дворов немного улучшается", value: 0.7 },
    ],
    sideEffects: [
      {
        title: "Усталость от контроля",
        description: "После усиленных смен часть жителей воспринимает контроль как давление.",
        delayDays: 3,
        durationDays: 4,
        effects: [
          { kind: "daily_need_delta", need: "socialRating", label: "Оценка власти немного проседает из-за жесткого контроля", value: -0.22 },
          { kind: "daily_need_delta", need: "wellbeing", label: "Тревожность после усиления остается выше нормы", value: -0.12 },
        ],
      },
    ],
  },
  {
    id: "government_tax_surcharge",
    title: "Временный налоговый сбор",
    side: "government",
    sideLabel: "Государство",
    category: "economy",
    activity: "budget_session",
    responseLabel: "Закрыть бюджетный риск",
    description: "На короткий срок город повышает сборы, чтобы пережить напряженный день без долговой спирали.",
    impactSummary: "+бюджет, +управляемость, -жители",
    tradeoff: "Финансовая безопасность жителей проседает, а бизнес осторожнее нанимает.",
    actionPointCost: 1,
    budgetCost: 0,
    cooldownDays: 5,
    delayDays: 0,
    durationDays: 2,
    effects: [
      { kind: "tax_delta", label: "Налоговая ставка временно выше", value: 0.025 },
      { kind: "daily_need_delta", need: "financialSafety", label: "Финансовая безопасность жителей снижается", value: -0.6 },
    ],
    sideEffects: [
      {
        title: "Похмелье налогового сбора",
        description: "Даже после отмены сбора семьи и бизнес несколько дней осторожнее тратят деньги.",
        delayDays: 2,
        durationDays: 5,
        effects: [
          { kind: "daily_need_delta", need: "financialSafety", label: "Финансовое доверие восстанавливается медленно", value: -0.18 },
          { kind: "daily_business_delta", businessType: "service", label: "Сервисный спрос проседает после сбора", value: -18 },
        ],
      },
    ],
  },
  {
    id: "government_emergency_reserve",
    title: "Чрезвычайный резерв",
    side: "government",
    sideLabel: "Государство",
    category: "economy",
    activity: "budget_session",
    responseLabel: "Заморозить часть расходов",
    description: "Мэрия временно создает резерв и замедляет несрочные выплаты, чтобы пережить нестабильную неделю.",
    impactSummary: "+резерв, +управляемость, -доверие",
    tradeoff: "Жители и бизнес чувствуют паузу в поддержке не сразу, но эффект тянется дольше решения.",
    actionPointCost: 1,
    budgetCost: 0,
    cooldownDays: 5,
    delayDays: 0,
    durationDays: 3,
    effects: [
      { kind: "subsidy_multiplier", label: "Несрочные субсидии временно заморожены", value: 0.88 },
      { kind: "social_multiplier", label: "Управленческая дисциплина снижает социальный шум", value: 1.02 },
    ],
    sideEffects: [
      {
        title: "Отложенные просьбы о поддержке",
        description: "После заморозки накопленные обращения возвращаются и бьют по ощущению защищенности.",
        delayDays: 3,
        durationDays: 5,
        effects: [
          { kind: "daily_need_delta", need: "wellbeing", label: "Накопленные просьбы ухудшают самочувствие города", value: -0.24 },
          { kind: "daily_need_delta", need: "financialSafety", label: "Семьи чувствуют паузу в поддержке", value: -0.2 },
        ],
      },
    ],
  },
  {
    id: "government_service_overtime",
    title: "Сверхсмены служб",
    side: "government",
    sideLabel: "Государство",
    category: "infrastructure",
    activity: "crisis_staff",
    responseLabel: "Оплатить усиленные смены",
    description: "Городские службы берут дополнительные смены, чтобы быстрее закрыть сбои в школах, больницах и районах.",
    impactSummary: "+качество служб, +здоровье, -бюджет",
    tradeoff: "Персонал устает, и часть усталости проявится уже после видимого улучшения.",
    actionPointCost: 1,
    budgetCost: 1500,
    cooldownDays: 4,
    delayDays: 0,
    durationDays: 2,
    effects: [
      { kind: "public_quality_delta", businessType: "school", label: "Школы и службы работают качественнее", value: 0.45 },
      { kind: "public_quality_delta", businessType: "hospital", label: "Больницы быстрее обслуживают поток", value: 0.4 },
      { kind: "daily_need_delta", need: "health", label: "Здоровье жителей получает быстрый импульс", value: 0.25 },
    ],
    sideEffects: [
      {
        title: "Выгорание городских служб",
        description: "После сверхсмен качество публичных услуг несколько дней восстанавливается.",
        delayDays: 2,
        durationDays: 5,
        effects: [
          { kind: "public_quality_delta", businessType: "school", label: "Школы теряют темп после сверхсмен", value: -0.18 },
          { kind: "public_quality_delta", businessType: "hospital", label: "Больницы работают уставшими сменами", value: -0.18 },
          { kind: "daily_need_delta", need: "sleep", label: "Город хуже восстанавливается после перегруза", value: -0.1 },
        ],
      },
    ],
  },
  {
    id: "government_data_inspection",
    title: "Инспекция данных",
    side: "government",
    sideLabel: "Государство",
    category: "infrastructure",
    activity: "budget_session",
    responseLabel: "Найти скрытые перекосы",
    description: "Аналитики мэрии ищут районы и отрасли, где небольшая корректировка даст самый заметный эффект.",
    impactSummary: "+точность политики, эффект завтра",
    tradeoff: "Проверки раздражают часть бизнеса и создают административный хвост.",
    actionPointCost: 1,
    budgetCost: 600,
    cooldownDays: 4,
    delayDays: 1,
    durationDays: 4,
    effects: [
      { kind: "social_multiplier", label: "Решения лучше попадают в проблемные зоны", value: 1.05 },
      { kind: "public_quality_delta", businessType: "school", label: "Публичные данные улучшают качество служб", value: 0.22 },
    ],
    sideEffects: [
      {
        title: "Административный след инспекции",
        description: "После проверок бизнес несколько дней отвлекается на документы.",
        delayDays: 3,
        durationDays: 4,
        effects: [
          { kind: "daily_business_delta", businessType: "service", label: "Сервис тратит оборот на документы", value: -18 },
          { kind: "daily_business_delta", businessType: "food", label: "Пищевые компании осторожнее планируют поставки", value: -14 },
        ],
      },
    ],
  },
  {
    id: "government_hardline_patrols",
    title: "Жесткий порядок",
    side: "government",
    sideLabel: "Государство",
    category: "safety",
    activity: "crisis_staff",
    responseLabel: "Развернуть силовые патрули",
    description: "Мэрия резко усиливает патрули, комендантские обходы и быстрые проверки опасных точек.",
    impactSummary: "+безопасность, +управляемость, -доверие",
    tradeoff: "Порядок приходит быстро, но часть жителей воспринимает контроль как давление, а сервис теряет вечерний спрос.",
    actionPointCost: 1,
    budgetCost: 900,
    cooldownDays: 3,
    delayDays: 0,
    durationDays: 3,
    effects: [
      { kind: "daily_need_delta", need: "physicalSafety", label: "Физическая безопасность заметно растет", value: 1.15 },
      { kind: "daily_need_delta", need: "housingSafety", label: "Дворы и подъезды контролируются плотнее", value: 0.9 },
      { kind: "social_multiplier", label: "Конфликты гасятся быстрее", value: 1.03 },
      { kind: "daily_business_delta", businessType: "service", label: "Сервис теряет часть вечернего оборота", value: -28 },
    ],
    sideEffects: [
      {
        title: "Усталость от жесткого контроля",
        description: "После силовых мер жители несколько дней хуже оценивают власть и осторожнее тратят деньги.",
        delayDays: 3,
        durationDays: 4,
        effects: [
          { kind: "daily_need_delta", need: "socialRating", label: "Доверие проседает после жестких патрулей", value: -0.32 },
          { kind: "daily_need_delta", need: "wellbeing", label: "Общее напряжение остается выше нормы", value: -0.18 },
          { kind: "daily_business_delta", businessType: "service", label: "Вечерний спрос восстанавливается медленно", value: -16 },
        ],
      },
    ],
  },
  {
    id: "government_shadow_contracts",
    title: "Серые подрядчики",
    side: "government",
    sideLabel: "Государство",
    category: "economy",
    activity: "budget_session",
    responseLabel: "Провести непубличные контракты",
    description: "Мэрия быстро привлекает лояльных подрядчиков и закрывает кассовый разрыв вне прозрачных процедур.",
    impactSummary: "+бюджет, +бизнес, -доверие, риск качества",
    tradeoff: "Коррупционный путь дает быстрые деньги и оборот, но накапливает репутационный и сервисный долг.",
    actionPointCost: 1,
    budgetCost: 0,
    cooldownDays: 4,
    delayDays: 0,
    durationDays: 2,
    effects: [
      { kind: "budget_delta", label: "Непубличные контракты пополняют бюджет", value: 5200 },
      { kind: "daily_business_delta", businessType: "workshop", label: "Лояльные мастерские получают срочные заказы", value: 95 },
      { kind: "daily_business_delta", businessType: "service", label: "Сервис получает быстрый оборот от подрядов", value: 65 },
      { kind: "daily_need_delta", need: "socialRating", label: "Доверие к власти снижается из-за слухов", value: -0.65 },
    ],
    sideEffects: [
      {
        title: "Цена серых контрактов",
        description: "После непубличных подрядов качество услуг и общественное доверие несколько дней проседают.",
        delayDays: 2,
        durationDays: 5,
        effects: [
          { kind: "public_quality_delta", businessType: "school", label: "Публичные службы теряют качество из-за мутных закупок", value: -0.2 },
          { kind: "public_quality_delta", businessType: "hospital", label: "Больницы получают менее надежные поставки", value: -0.2 },
          { kind: "daily_need_delta", need: "socialRating", label: "Разговоры о коррупции давят на доверие", value: -0.28 },
        ],
      },
    ],
  },
];

const DAILY_DECISION_MAP = new Map(DAILY_DECISION_CATALOG.map((decision) => [decision.id, decision]));

const DEFAULT_GAME_OPTIONS: NewGameOptions = {
  scenarioType: "balanced",
  goalType: "balanced",
  dayLimit: 32,
};

const SAVE_SNAPSHOT_TABLES = [
  "sim_config",
  "sim_state",
  "businesses",
  "goods",
  "agents",
  "needs",
  "relations",
  "daily_decrees",
  "stats_history",
  "agent_stat_history",
] as const;

const SAVE_DELETE_TABLES = [
  "stats_history",
  "agent_stat_history",
  "daily_decrees",
  "relations",
  "needs",
  "agents",
  "goods",
  "businesses",
  "sim_state",
  "sim_config",
] as const;

function normalizeScenarioType(value: unknown): ScenarioType {
  return value === "crisis" || value === "growth" || value === "stability" ? value : "balanced";
}

function normalizeGoalType(value: unknown): GoalType {
  if (
    value === "crisis_recovery" ||
    value === "economic_growth" ||
    value === "market_growth" ||
    value === "social_stability" ||
    value === "force_order" ||
    value === "corruption_network"
  ) return value;
  return "balanced";
}

function normalizeGameStatus(value: unknown): GameStatus {
  return value === "victory" || value === "defeat" ? value : "active";
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

const MALE_NAMES = [
  "Александр", "Дмитрий", "Михаил", "Иван", "Сергей", "Андрей", "Алексей",
  "Владимир", "Артём", "Николай", "Павел", "Антон", "Максим", "Денис",
  "Роман", "Пётр", "Игорь", "Виктор", "Тимур", "Даниил", "Константин",
];
const FEMALE_NAMES = [
  "Мария", "Анна", "Елена", "Ольга", "Наталья", "Ирина", "Татьяна",
  "Светлана", "Юлия", "Екатерина", "Алина", "Дарья", "Ксения", "Валерия",
  "Виктория", "Людмила", "Нина", "Алёна", "Марина", "Вера",
];
const PERSONALITIES = ["сангвиник", "холерик", "флегматик", "меланхолик"];

// Career grade salary multipliers: grade 1..5 (Рабочий → Владелец)
// Steep ladder so high-grade specialists earn meaningfully more.
//   Grade 1 (Рабочий):   ×1.0  → baseSalary × 1.0  = 50 /day
//   Grade 2 (Менеджер):  ×2.0  → baseSalary × 2.0  = 100/day
//   Grade 3 (Бригадир):  ×3.5  → baseSalary × 3.5  = 175/day
//   Grade 4 (Директор):  ×6.0  → baseSalary × 6.0  = 300/day
//   Grade 5 (Владелец):  ×10.0 → baseSalary × 10.0 = 500/day
const CAREER_SALARY_MULT = [1.0, 2.0, 3.5, 6.0, 10.0] as const;

// Grade name labels used in UI / job history
const GRADE_LABELS: Record<number, string> = {
  1: "Рабочий",
  2: "Менеджер",
  3: "Бригадир",
  4: "Директор",
  5: "Владелец",
};

/** Target career grade derived from ambition (20–100) */
function targetGrade(ambition: number): number {
  if (ambition >= 80) return 5;
  if (ambition >= 65) return 4;
  if (ambition >= 50) return 3;
  if (ambition >= 35) return 2;
  return 1;
}

/** Salary for one tick of work considering career level */
function calcSalary(baseSalary: number, careerLevel: number): number {
  const mult = CAREER_SALARY_MULT[Math.min(4, Math.max(0, careerLevel - 1))] ?? 1.0;
  return baseSalary * mult * rand(0.9, 1.1);
}

// Consumer preference matrix per spec v1.6 (Потребительская матрица)
// Index: 0=Санг.Интр  1=Санг.Экстр  2=Хол.Интр  3=Хол.Экстр
//        4=Флег.Интр  5=Флег.Экстр  6=Мел.Интр  7=Мел.Экстр
// Tier: [priceLevel, qualityLevel] where each is "low"|"medium"|"high"
type PriceQualityTier = ["low" | "medium" | "high", "low" | "medium" | "high"];
const CONSUMER_MATRIX: Record<string, PriceQualityTier[]> = {
  food: [
    ["medium", "medium"], // 0 Санг Инт
    ["high",   "high"],   // 1 Санг Экстр
    ["high",   "high"],   // 2 Хол Инт
    ["medium", "high"],   // 3 Хол Экстр
    ["low",    "medium"], // 4 Флег Инт
    ["medium", "medium"], // 5 Флег Экстр
    ["high",   "high"],   // 6 Мел Инт
    ["high",   "medium"], // 7 Мел Экстр
  ],
  park: [ // Развлекательные услуги
    ["low",    "medium"], // 0 Санг Инт
    ["high",   "medium"], // 1 Санг Экстр
    ["low",    "high"],   // 2 Хол Инт
    ["high",   "high"],   // 3 Хол Экстр
    ["low",    "low"],    // 4 Флег Инт
    ["medium", "medium"], // 5 Флег Экстр
    ["low",    "medium"], // 6 Мел Инт
    ["medium", "high"],   // 7 Мел Экстр
  ],
  service: [ // Бытовые товары / услуги
    ["medium", "high"],   // 0 Санг Инт
    ["high",   "high"],   // 1 Санг Экстр
    ["medium", "medium"], // 2 Хол Инт
    ["high",   "high"],   // 3 Хол Экстр
    ["medium", "medium"], // 4 Флег Инт
    ["low",    "medium"], // 5 Флег Экстр
    ["medium", "medium"], // 6 Мел Инт
    ["high",   "high"],   // 7 Мел Экстр
  ],
};

/** Map (personality, socialization) → 0-7 index for CONSUMER_MATRIX */
function getPersonalityIndex(personality: string, socialization: number): number {
  const base: Record<string, number> = { "сангвиник": 0, "холерик": 2, "флегматик": 4, "меланхолик": 6 };
  const b = base[personality] ?? 0;
  return b + (socialization >= 50 ? 1 : 0); // extrovert = +1
}

/** Classify a good into price/quality tier relative to peers of the same type */
function classifyGood(good: GoodState, peers: GoodState[]): PriceQualityTier {
  const prices = peers.map(g => g.currentPrice).sort((a, b) => a - b);
  const pIdx = prices.filter(p => p <= good.currentPrice).length / prices.length;
  const priceLevel: "low" | "medium" | "high" = pIdx < 0.35 ? "low" : pIdx < 0.70 ? "medium" : "high";
  const qualityLevel: "low" | "medium" | "high" = good.quality > 70 ? "high" : good.quality > 40 ? "medium" : "low";
  return [priceLevel, qualityLevel];
}
const FOOD_BUSINESS_NAMES = ["Пекарня", "Кафе", "Столовая", "Ресторан", "Супермаркет", "Закусочная", "Продуктовый"];
const SERVICE_BUSINESS_NAMES = ["Парикмахерская", "Магазин", "Сервисный центр", "Прачечная", "Ателье", "Аптека", "Химчистка"];
const HOSPITAL_BUSINESS_NAMES = ["Городская больница", "Поликлиника", "Медицинский центр", "Амбулатория", "Клиника здоровья", "Медпункт"];
const FARM_BUSINESS_NAMES = ["Агроферма", "Молочная ферма", "Птицефабрика", "Зерновое хозяйство", "Овощная ферма", "Животноводческий комплекс", "Тепличный комбинат"];
const WORKSHOP_BUSINESS_NAMES = ["Производственный цех", "Фабрика материалов", "Завод комплектующих", "Цех упаковки", "Текстильная фабрика", "Химический завод"];
const FOOD_GOOD_NAMES = ["Хлеб", "Молоко", "Мясо", "Овощи", "Фрукты", "Рыба", "Крупа"];
const SERVICE_GOOD_NAMES = ["Одежда", "Инструменты", "Бытовая химия", "Электроника", "Мебель"];
const HOSPITAL_GOOD_NAMES = ["Лечение", "Медосмотр", "Операция", "Консультация врача", "Физиотерапия"];
const RAW_FOOD_GOOD_NAMES = ["Зерно", "Сырое молоко", "Овощи с поля", "Яйца", "Мясо сырое", "Мука", "Корм"];
const RAW_MATERIAL_GOOD_NAMES = ["Детали", "Запчасти", "Сырьё", "Химикаты", "Ткань", "Металл"];
const SCHOOL_BUSINESS_NAMES = ["Школа", "Гимназия", "Лицей", "Колледж", "Университет", "Учебный центр", "Библиотека"];
const PARK_BUSINESS_NAMES = ["Городской парк", "Кинотеатр", "Спортивный клуб", "Торговый центр", "Театр", "Боулинг", "Аквапарк"];
const TEMPLE_BUSINESS_NAMES = ["Церковь", "Мечеть", "Часовня", "Монастырь", "Собор", "Молельный дом"];
const SCHOOL_GOOD_NAMES = ["Урок", "Курс обучения", "Лекция", "Тренинг", "Семинар"];
const PARK_GOOD_NAMES = ["Прогулка", "Сеанс кино", "Тренировка", "Развлечение", "Экскурсия"];
const TEMPLE_GOOD_NAMES = ["Молебен", "Богослужение", "Исповедь", "Медитация", "Обряд"];
const ACTIONS = ["eat", "rest", "sleep", "socialize", "work", "idle", "heal", "study", "relax", "pray"];

// ─── Dialog mood matrix (точно по спецификации v1.6) ───────────────────────
//
// Тиры настроения (шкала настроения 0-100, нейтраль = 50):
//   Счастливый (high)  ≥ 60  ↔ спек +20..+100 на -100..+100
//   Нейтральный (med)  40-59 ↔ спек -20..+20
//   Грустный (low)     < 40  ↔ спек ниже -20
//
// Формат строки: [dInitMood, dRespMood, dFriend]
// Если в строке 2 варианта — это «Рандом» из спека (50/50 выбор).
//
// Источник: лист «Таблица эффектов диалогов жителей» файла v1.6
const MOOD_TIER_HIGH = 60;
const MOOD_TIER_LOW  = 40;
type MoodTier = "high" | "med" | "low";
type DialogOutcome = [dInit: number, dResp: number, dFriend: number];

function getMoodTier(mood: number): MoodTier {
  if (mood >= MOOD_TIER_HIGH) return "high";
  if (mood >= MOOD_TIER_LOW)  return "med";
  return "low";
}

const DIALOG_MATRIX: Record<MoodTier, Record<MoodTier, DialogOutcome[]>> = {
  //          dInit  dResp  dFriend
  high: {
    high: [[ 2,  2,  3]],                     // счастливый×счастливый — позитивный
    med:  [[ 1,  0,  1]],                     // счастливый×нейтральный
    low:  [[ 1,  0,  1], [ 0, -1, -1]],       // счастливый×грустный — РАНДОМ (нейтральный или негативный ответ)
  },
  med: {
    high: [[ 1,  1,  2]],                     // нейтральный×счастливый
    med:  [[ 0,  0,  1]],                     // нейтральный×нейтральный
    low:  [[ 0,  0,  1], [-1, -1, -2]],       // нейтральный×грустный — РАНДОМ
  },
  low: {
    high: [[ 1,  1,  1], [ 0,  0, -1]],       // грустный×счастливый — РАНДОМ (позитивный или нейтральный ответ)
    med:  [[ 0,  0, -1]],                     // грустный×нейтральный
    low:  [[-2, -2, -3]],                     // грустный×грустный — негативный
  },
};
// ───────────────────────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function clamp(val: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, val));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const AGENT_STAT_HISTORY_MAX = 20;

interface AgentStatSnapshot {
  tick: number;
  money: number;
  mood: number;
  age: number;
  socialization: number;
}

export interface TickDebugReport {
  tick: number;
  elapsedMs: number;
  computedAt: number;
  agents: {
    processed: number;
    skipped: number;
    actions: { work: number; eat: number; rest: number; socialize: number; idle: number; sleep?: number; heal?: number; study?: number; relax?: number; pray?: number };
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
    publicServiceSpend: number;
    pensionRecipients: number;
    subsidyRecipients: number;
    inheritanceRecycled: number;
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
  chain: {
    b2bSuccess: number;
    b2bFail: number;
    farmSupplyTotal: number;
    workshopSupplyTotal: number;
    foodSupplyTotal: number;
    serviceSupplyTotal: number;
  };
}

// ── Система мировых событий ──────────────────────────────────────────────────
// Случайные события происходят раз в 5-10 дней и оказывают заметное влияние
// на экономику, демографию и потребности жителей.

type WorldEventType =
  | "good_harvest"       // +урожай: фермы производят вдвое больше (3 дня)
  | "bad_harvest"        // -неурожай: фермы производят вдвое меньше (3 дня)
  | "wealthy_migration"  // мгновенно: 100 богатых мигрантов
  | "epidemic"           // -эпидемия: здоровье тает втрое быстрее (5 дней)
  | "economic_boom"      // +подъём: бизнесы получают ежедневный бонус (4 дня)
  | "government_subsidy" // мгновенно: внешний грант в бюджет города
  | "auto";              // автоматические заметные события (банкротства, волны и т.п.)

interface WorldEvent {
  id: string;
  type: WorldEventType;
  name: string;
  description: string;
  icon: string;
  startDay: number;
  endDay: number; // -1 для мгновенных событий
  severity: "positive" | "negative" | "neutral";
}

interface EventLogEntry {
  id: string;
  day: number;
  tick: number;
  type: WorldEventType;
  name: string;
  description: string;
  icon: string;
  severity: "positive" | "negative" | "neutral";
}

const WORLD_EVENT_CATALOG: Array<{
  type: Exclude<WorldEventType, "auto">;
  name: string;
  description: string;
  icon: string;
  duration: number; // -1 = мгновенно
  weight: number;
  severity: "positive" | "negative" | "neutral";
}> = [
  {
    type: "good_harvest",
    name: "Богатый урожай",
    description: "Благоприятная погода дала рекордный урожай. Фермы работают на полную мощность.",
    icon: "🌾",
    duration: 3,
    weight: 20,
    severity: "positive",
  },
  {
    type: "bad_harvest",
    name: "Неурожай",
    description: "Засуха и болезни растений подкосили урожай. Фермы производят вдвое меньше.",
    icon: "🌵",
    duration: 3,
    weight: 18,
    severity: "negative",
  },
  {
    type: "wealthy_migration",
    name: "Приток богатых мигрантов",
    description: "100 зажиточных семей переехали в город, привезя значительные накопления.",
    icon: "💰",
    duration: -1,
    weight: 12,
    severity: "positive",
  },
  {
    type: "epidemic",
    name: "Эпидемия",
    description: "Вспышка болезни охватила город. Здоровье жителей деградирует втрое быстрее.",
    icon: "🦠",
    duration: 5,
    weight: 18,
    severity: "negative",
  },
  {
    type: "economic_boom",
    name: "Экономический подъём",
    description: "Торговая активность резко выросла. Все предприятия ежедневно получают дополнительный доход.",
    icon: "📈",
    duration: 4,
    weight: 15,
    severity: "positive",
  },
  {
    type: "government_subsidy",
    name: "Внешние инвестиции",
    description: "Регион выделил городу крупный грант на развитие инфраструктуры.",
    icon: "🏛️",
    duration: -1,
    weight: 17,
    severity: "positive",
  },
];

class SimulationEngine {
  private agents: Map<number, AgentState> = new Map();
  private businesses: Map<number, BusinessState> = new Map();
  private goods: Map<number, GoodState> = new Map();
  /** agentIdA → Map<agentIdB, friendshipLevel> */
  private relations: Map<number, Map<number, number>> = new Map();
  private dirtyRelations: Set<string> = new Set();
  /** Tracks "agentIdA:agentIdB" pairs that already have a DB row (safe to UPDATE) */
  private persistedRelations: Set<string> = new Set();
  /** Per-agent stat history: last N snapshots keyed by agent id */
  private agentStatHistory: Map<number, AgentStatSnapshot[]> = new Map();
  private state: SimState = {
    tick: 0,
    running: false,
    gameHour: 0,
    gameDay: 1,
    scenarioType: DEFAULT_GAME_OPTIONS.scenarioType,
    goalType: DEFAULT_GAME_OPTIONS.goalType,
    dayLimit: DEFAULT_GAME_OPTIONS.dayLimit,
    gameStatus: "active",
    gameOutcomeReason: null,
    actionPointsRemaining: DAILY_ACTION_POINTS_MAX,
    actionPointsMax: DAILY_ACTION_POINTS_MAX,
    governmentBudget: 10000,
    totalTaxCollected: 0,
    totalSubsidiesPaid: 0,
    totalPensionPaid: 0,
    totalPublicServicesPaid: 0,
  };
  private config: SimulationConfig = { ...DEFAULT_CONFIG };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isTicking = false;
  private syncCounter = 0;
  private lastTickReport: TickDebugReport | null = null;
  private prevAvgPrice = 0;
  private lastBirths = 0;
  private lastDeaths = 0;
  private lastImmigrants = 0;
  private lastEmigrants = 0;
  private totalGrantsPaid = 0;
  private lastGrantsIssued = 0;
  private activeEvents: WorldEvent[] = [];
  private eventLog: EventLogEntry[] = [];
  private lastEventDay = 0; // last day a world event was triggered
  private dailyDecrees: DailyDecreeRecord[] = [];
  private residentRequests: ResidentRequestRecord[] = [];
  private residentRequestSeq = 1;
  private residentRequestReputationDelta = 0;
  private factionDemands: FactionDemandRecord[] = [];
  private factionDemandSeq = 1;

  async initialize(): Promise<void> {
    logger.info("Initializing simulation engine...");
    await this.loadConfig();
    await this.loadState();
    await this.loadAgents();
    await this.loadBusinesses();
    await this.loadGoods();
    await this.loadRelations();
    await this.loadAgentStatHistory();
    await this.loadDailyDecrees();

    if (this.agents.size === 0) {
      logger.info("No agents found, generating initial population...");
      await this.generatePopulation();
      logger.info("Auto-starting simulation after initial population generation");
      await this.start();
    } else {
      await this.ensureHospitals();
      await this.ensureFarms();
      await this.ensurePublicServices();
      if (this.state.running) {
        logger.info("Resuming simulation from saved state");
        this.startTimer();
      }
    }

    logger.info({ agentCount: this.agents.size, businessCount: this.businesses.size }, "Simulation engine initialized");
  }

  private async loadConfig(): Promise<void> {
    const rows = await db.select().from(simConfigTable);
    if (rows.length === 0) {
      await this.saveConfig();
      return;
    }
    const configMap: Record<string, string> = {};
    for (const row of rows) {
      configMap[row.key] = row.value;
    }
    this.config = {
      taxRate: parseFloat(configMap.taxRate ?? String(DEFAULT_CONFIG.taxRate)),
      needDecayRate: parseFloat(configMap.needDecayRate ?? String(DEFAULT_CONFIG.needDecayRate)),
      tickIntervalMs: parseInt(configMap.tickIntervalMs ?? String(DEFAULT_CONFIG.tickIntervalMs)),
      initialAgents: parseInt(configMap.initialAgents ?? String(DEFAULT_CONFIG.initialAgents)),
      initialBusinesses: parseInt(configMap.initialBusinesses ?? String(DEFAULT_CONFIG.initialBusinesses)),
      baseFoodPrice: parseFloat(configMap.baseFoodPrice ?? String(DEFAULT_CONFIG.baseFoodPrice)),
      baseSalary: parseFloat(configMap.baseSalary ?? String(DEFAULT_CONFIG.baseSalary)),
      subsidyAmount: parseFloat(configMap.subsidyAmount ?? String(DEFAULT_CONFIG.subsidyAmount)),
      socialInteractionStrength: parseFloat(configMap.socialInteractionStrength ?? String(DEFAULT_CONFIG.socialInteractionStrength)),
      priceMarkup: parseFloat(configMap.priceMarkup ?? String(DEFAULT_CONFIG.priceMarkup)),
      pensionRate: parseFloat(configMap.pensionRate ?? String(DEFAULT_CONFIG.pensionRate)),
    };
  }

  private async saveConfig(): Promise<void> {
    for (const [key, value] of Object.entries(this.config)) {
      await db
        .insert(simConfigTable)
        .values({ key, value: String(value) })
        .onConflictDoUpdate({ target: simConfigTable.key, set: { value: String(value) } });
    }
  }

  private async loadState(): Promise<void> {
    const [row] = await db.select().from(simStateTable).limit(1);
    if (row) {
      this.state = {
        tick: row.tick,
        running: row.running,
        gameHour: row.gameHour,
        gameDay: row.gameDay,
        // Floor at 0 — negative budgets from old buggy code are reset on restart
        scenarioType: normalizeScenarioType(row.scenarioType),
        goalType: normalizeGoalType(row.goalType),
        dayLimit: row.dayLimit ?? DEFAULT_GAME_OPTIONS.dayLimit,
        gameStatus: normalizeGameStatus(row.gameStatus),
        gameOutcomeReason: row.gameOutcomeReason ?? null,
        actionPointsRemaining: Math.min(row.actionPointsRemaining ?? DAILY_ACTION_POINTS_MAX, DAILY_ACTION_POINTS_MAX),
        actionPointsMax: DAILY_ACTION_POINTS_MAX,
        governmentBudget: row.governmentBudget,
        totalTaxCollected: row.totalTaxCollected ?? 0,
        totalSubsidiesPaid: row.totalSubsidiesPaid ?? 0,
        totalPensionPaid: row.totalPensionPaid ?? 0,
        totalPublicServicesPaid: row.totalPublicServicesPaid ?? 0,
      };
    } else {
      await db.insert(simStateTable).values({
        tick: 0,
        running: false,
        gameHour: 0,
        gameDay: 1,
        scenarioType: DEFAULT_GAME_OPTIONS.scenarioType,
        goalType: DEFAULT_GAME_OPTIONS.goalType,
        dayLimit: DEFAULT_GAME_OPTIONS.dayLimit,
        gameStatus: "active",
        gameOutcomeReason: null,
        actionPointsRemaining: DAILY_ACTION_POINTS_MAX,
        actionPointsMax: DAILY_ACTION_POINTS_MAX,
        governmentBudget: 10000,
        totalTaxCollected: 0,
        totalSubsidiesPaid: 0,
        totalPensionPaid: 0,
        totalPublicServicesPaid: 0,
      });
    }
  }

  private async loadAgents(): Promise<void> {
    const agentRows = await db.select().from(agentsTable).limit(5000);
    const needsRows = await db.select().from(needsTable);
    const needsMap = new Map<number, { hunger: number; comfort: number; social: number; health: number; sleep: number; education: number; entertainment: number; faith: number; housingSafety: number; financialSafety: number; physicalSafety: number; socialRating: number; wellbeing: number; id: number }>();
    for (const n of needsRows) {
      needsMap.set(n.agentId, {
        hunger: n.hunger, comfort: n.comfort, social: n.social,
        health: n.health ?? 80, sleep: n.sleep ?? 80,
        education: n.education ?? 70, entertainment: n.entertainment ?? 70, faith: n.faith ?? 60,
        housingSafety: n.housingSafety ?? 80,
        financialSafety: n.financialSafety ?? 80,
        physicalSafety: n.physicalSafety ?? 80,
        socialRating: n.socialRating ?? 50,
        wellbeing: n.wellbeing ?? 70,
        id: n.id,
      });
    }
    this.agents.clear();
    for (const agent of agentRows) {
      const needs = needsMap.get(agent.id) ?? { hunger: 80, comfort: 80, social: 80, health: 80, sleep: 80, education: 70, entertainment: 70, faith: 60, housingSafety: 80, financialSafety: 80, physicalSafety: 80, socialRating: 50, wellbeing: 70, id: 0 };
      let jobHistory: JobHistoryEntry[] = [];
      try { jobHistory = JSON.parse(agent.jobHistory ?? "[]"); } catch { jobHistory = []; }
      // Derive jobStartTick from last "hired" entry in job history
      const lastHired = [...jobHistory].reverse().find(e => e.event === "hired");
      this.agents.set(agent.id, {
        ...agent,
        needs: { hunger: needs.hunger, comfort: needs.comfort, social: needs.social, health: needs.health, sleep: needs.sleep, education: needs.education, entertainment: needs.entertainment, faith: needs.faith, housingSafety: needs.housingSafety, financialSafety: needs.financialSafety, physicalSafety: needs.physicalSafety, socialRating: needs.socialRating, wellbeing: needs.wellbeing ?? 70 },
        needsId: needs.id, recentActions: [], jobHistory,
        jobStartTick: agent.employerId ? (lastHired?.tick ?? 0) : null,
        jailedUntilTick: null,
      });
    }
  }

  private async loadRelations(): Promise<void> {
    const rows = await db.select().from(relationsTable);
    this.relations.clear();
    this.dirtyRelations.clear();
    this.persistedRelations.clear();
    for (const r of rows) {
      let relMap = this.relations.get(r.agentIdA);
      if (!relMap) {
        relMap = new Map();
        this.relations.set(r.agentIdA, relMap);
      }
      relMap.set(r.agentIdB, r.friendshipLevel);
      this.persistedRelations.add(`${r.agentIdA}:${r.agentIdB}`);
    }
  }

  private async loadAgentStatHistory(): Promise<void> {
    this.agentStatHistory.clear();
    const rows = sqlite.prepare(`
      SELECT agent_id, tick, money, mood, age, socialization
      FROM (
        SELECT agent_id, tick, money, mood, age, socialization,
               ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY tick DESC) AS rn
        FROM agent_stat_history
      )
      WHERE rn <= ?
      ORDER BY agent_id, tick ASC
    `).all(AGENT_STAT_HISTORY_MAX) as Array<{
      agent_id: number;
      tick: number;
      money: number;
      mood: number;
      age: number;
      socialization: number;
    }>;
    for (const row of rows) {
      const agentId = Number(row.agent_id);
      const snapshot: AgentStatSnapshot = {
        tick: Number(row.tick),
        money: Number(row.money),
        mood: Number(row.mood),
        age: Number(row.age),
        socialization: Number(row.socialization),
      };
      const history = this.agentStatHistory.get(agentId) ?? [];
      history.push(snapshot);
      this.agentStatHistory.set(agentId, history);
    }
    logger.info({ agentCount: this.agentStatHistory.size }, "Loaded agent stat history from DB");

    // Очистка старых записей — запускается в фоне, не блокирует старт
    try {
      sqlite.prepare(`
        DELETE FROM agent_stat_history
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY tick DESC) AS rn
            FROM agent_stat_history
          )
          WHERE rn <= ?
        )
      `).run(AGENT_STAT_HISTORY_MAX);
    } catch (err) {
      logger.warn({ err }, "Background agent_stat_history cleanup failed");
    }
  }

  private async loadDailyDecrees(): Promise<void> {
    const rows = await db.select().from(dailyDecreesTable);
    this.dailyDecrees = rows.map(row => ({
      id: row.id,
      decisionId: row.decisionId,
      title: row.title,
      description: row.description,
      status: this.normalizeDecreeStatus(row.status),
      issuedDay: row.issuedDay,
      startDay: row.startDay,
      endDay: row.endDay,
      actionPointCost: row.actionPointCost,
      budgetCost: row.budgetCost,
      cooldownDays: row.cooldownDays,
      effects: this.parseDecisionEffects(row.effectsJson),
    }));
    this.refreshDailyDecreeStatuses();
  }

  private parseDecisionEffects(raw: string): DecisionEffect[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed as DecisionEffect[] : [];
    } catch {
      return [];
    }
  }

  private normalizeDecreeStatus(value: string): DailyDecreeStatus {
    if (value === "active" || value === "expired") return value;
    return "pending";
  }

  private async loadBusinesses(): Promise<void> {
    const rows = await db.select().from(businessesTable);
    this.businesses.clear();
    const employeeCounts = new Map<number, number>();
    for (const agent of this.agents.values()) {
      if (agent.employerId != null) {
        employeeCounts.set(agent.employerId, (employeeCounts.get(agent.employerId) ?? 0) + 1);
      }
    }
    for (const b of rows) {
      this.businesses.set(b.id, { ...b, employeeCount: employeeCounts.get(b.id) ?? 0, maxEmployees: MAX_EMPLOYEES_BY_TYPE[b.type] ?? 5, firedThisTick: 0, hiredThisTick: 0, ticksUnprofitable: 0, hasReceivedBailout: false });
    }

    // Startup cleanup: fire excess employees beyond maxEmployees cap.
    // Needed after parameter changes that reduce capacity limits.
    for (const biz of this.businesses.values()) {
      if (biz.employeeCount <= biz.maxEmployees) continue;
      // Find agents employed at this business and fire the excess
      let excess = biz.employeeCount - biz.maxEmployees;
      for (const agent of this.agents.values()) {
        if (excess <= 0) break;
        if (agent.employerId === biz.id) {
          agent.employerId = null;
          agent.jobStartTick = null;
          biz.employeeCount--;
          excess--;
        }
      }
    }

  }

  private async loadGoods(): Promise<void> {
    const rows = await db.select().from(goodsTable);
    this.goods.clear();
    for (const g of rows) {
      this.goods.set(g.id, { ...g });
    }

    // ── Price migration for raw producers ─────────────────────────────────
    // Old code priced farm goods at baseFoodPrice×0.5 and workshop goods at
    // baseFoodPrice×0.8, making them too cheap to sustain payroll from B2B
    // revenue.  If we detect the old prices, upgrade them in-place so that
    // existing simulations benefit immediately without a reset.
    const { baseFoodPrice } = this.config;
    // Target prices for raw-producer goods
    const FARM_TARGET_PRICE     = baseFoodPrice * 1.2;
    const WORKSHOP_TARGET_PRICE = baseFoodPrice * 1.2;
    const toUpdate: Array<{ id: number; basePrice: number; currentPrice: number }> = [];

    for (const good of this.goods.values()) {
      const biz = good.businessId != null ? this.businesses.get(good.businessId) : null;
      if (!biz) continue;
      const target = biz.type === "farm" ? FARM_TARGET_PRICE
                   : biz.type === "workshop" ? WORKSHOP_TARGET_PRICE
                   : null;
      if (target == null) continue;
      if (Math.abs(good.basePrice - target) < 0.01) continue; // already correct
      good.basePrice    = target;
      good.currentPrice = Math.max(target, good.currentPrice);
      toUpdate.push({ id: good.id, basePrice: good.basePrice, currentPrice: good.currentPrice });
    }

    for (const { id, basePrice, currentPrice } of toUpdate) {
      await db.update(goodsTable)
        .set({ basePrice, currentPrice })
        .where(eq(goodsTable.id, id))
        .catch(() => {});
    }
    if (toUpdate.length > 0) {
      logger.info({ count: toUpdate.length }, "Migrated raw-producer good prices to new B2B formula");
    }
  }

  private async ensureHospitals(): Promise<void> {
    const existingHospitals = Array.from(this.businesses.values()).filter(b => b.type === "hospital");
    if (existingHospitals.length > 0) {
      logger.info({ count: existingHospitals.length }, "Hospitals already present, skipping creation");
      return;
    }

    const { baseFoodPrice } = this.config;
    const hospitalCount = Math.max(5, Math.floor(this.businesses.size * 0.12));
    logger.info({ hospitalCount }, "No hospitals found — spawning hospitals for existing world");

    const businessInserts = [];
    for (let i = 0; i < hospitalCount; i++) {
      businessInserts.push({
        name: `${pick(HOSPITAL_BUSINESS_NAMES)} №${i + 1}`,
        type: "hospital",
        balance: rand(2000, 8000),
        productionRate: rand(2, 10),
        ownerId: null,
      });
    }

    const savedBiz = await db.insert(businessesTable).values(businessInserts).returning();
    for (const b of savedBiz) {
      this.businesses.set(b.id, { ...b, employeeCount: 0, maxEmployees: MAX_EMPLOYEES_BY_TYPE[b.type] ?? 5, firedThisTick: 0, hiredThisTick: 0, ticksUnprofitable: 0, hasReceivedBailout: false });
    }

    const goodInserts = savedBiz.map(b => ({
      name: pick(HOSPITAL_GOOD_NAMES),
      businessId: b.id,
      basePrice: baseFoodPrice * 3,
      currentPrice: baseFoodPrice * 3 * (1 + this.config.priceMarkup),
      quality: rand(50, 95),
      demand: rand(20, 50),
      supply: rand(30, 60),
    }));

    const savedGoods = await db.insert(goodsTable).values(goodInserts).returning();
    for (const g of savedGoods) {
      this.goods.set(g.id, { ...g });
    }

    logger.info({ hospitalCount, goodsCount: savedGoods.length }, "Hospitals spawned successfully");
  }

  private async ensureFarms(): Promise<void> {
    const existingFarms = Array.from(this.businesses.values()).filter(b => b.type === "farm");
    const existingWorkshops = Array.from(this.businesses.values()).filter(b => b.type === "workshop");
    if (existingFarms.length > 0 && existingWorkshops.length > 0) {
      logger.info({ farmCount: existingFarms.length, workshopCount: existingWorkshops.length }, "Raw producers already present, skipping");
      return;
    }

    const { baseFoodPrice } = this.config;
    const farmCount = Math.max(6, Math.floor(this.businesses.size * 0.08));
    const workshopCount = Math.max(4, Math.floor(this.businesses.size * 0.06));
    logger.info({ farmCount, workshopCount }, "Spawning raw producers for production chains");

    const bizInserts = [];
    for (let i = 0; i < farmCount; i++) {
      bizInserts.push({
        name: `${pick(FARM_BUSINESS_NAMES)} №${i + 1}`,
        type: "farm",
        balance: rand(3000, 9000),
        productionRate: rand(8, 20),
        ownerId: null,
      });
    }
    for (let i = 0; i < workshopCount; i++) {
      bizInserts.push({
        name: `${pick(WORKSHOP_BUSINESS_NAMES)} №${i + 1}`,
        type: "workshop",
        balance: rand(2000, 7000),
        productionRate: rand(6, 15),
        ownerId: null,
      });
    }

    const savedBiz = await db.insert(businessesTable).values(bizInserts).returning();
    for (const b of savedBiz) {
      this.businesses.set(b.id, { ...b, employeeCount: 0, maxEmployees: MAX_EMPLOYEES_BY_TYPE[b.type] ?? 5, firedThisTick: 0, hiredThisTick: 0, ticksUnprofitable: 0, hasReceivedBailout: false });
    }

    const goodInserts = savedBiz.map(b => {
      const isF = b.type === "farm";
      return {
        name: isF ? pick(RAW_FOOD_GOOD_NAMES) : pick(RAW_MATERIAL_GOOD_NAMES),
        businessId: b.id,
        basePrice: baseFoodPrice * 1.2,
        currentPrice: baseFoodPrice * 1.2,
        quality: rand(isF ? 60 : 50, 90),
        demand: rand(30, 60),
        supply: rand(60, 100),
      };
    });

    const savedGoods = await db.insert(goodsTable).values(goodInserts).returning();
    for (const g of savedGoods) this.goods.set(g.id, { ...g });

    logger.info({ farmCount, workshopCount, goodsCount: savedGoods.length }, "Raw producers spawned for production chains");
  }

  private async ensurePublicServices(): Promise<void> {
    const existingSchools = Array.from(this.businesses.values()).filter(b => b.type === "school");
    const existingParks = Array.from(this.businesses.values()).filter(b => b.type === "park");
    const existingTemples = Array.from(this.businesses.values()).filter(b => b.type === "temple");
    if (existingSchools.length > 0 && existingParks.length > 0 && existingTemples.length > 0) {
      logger.info({ schools: existingSchools.length, parks: existingParks.length, temples: existingTemples.length }, "Public services already present, skipping");
      return;
    }

    const { baseFoodPrice } = this.config;
    const schoolCount = Math.max(4, Math.floor(this.businesses.size * 0.05));
    const parkCount = Math.max(5, Math.floor(this.businesses.size * 0.06));
    const templeCount = Math.max(3, Math.floor(this.businesses.size * 0.04));

    const bizInserts: Array<{ name: string; type: string; balance: number; productionRate: number; ownerId: null }> = [];
    for (let i = 0; i < schoolCount; i++) {
      bizInserts.push({ name: `${pick(SCHOOL_BUSINESS_NAMES)} №${i + 1}`, type: "school", balance: rand(1500, 5000), productionRate: rand(3, 8), ownerId: null });
    }
    for (let i = 0; i < parkCount; i++) {
      bizInserts.push({ name: `${pick(PARK_BUSINESS_NAMES)} №${i + 1}`, type: "park", balance: rand(1000, 4000), productionRate: rand(4, 10), ownerId: null });
    }
    for (let i = 0; i < templeCount; i++) {
      bizInserts.push({ name: `${pick(TEMPLE_BUSINESS_NAMES)} №${i + 1}`, type: "temple", balance: rand(500, 2000), productionRate: rand(2, 6), ownerId: null });
    }

    const savedBiz = await db.insert(businessesTable).values(bizInserts).returning();
    for (const b of savedBiz) {
      this.businesses.set(b.id, { ...b, employeeCount: 0, maxEmployees: MAX_EMPLOYEES_BY_TYPE[b.type] ?? 5, firedThisTick: 0, hiredThisTick: 0, ticksUnprofitable: 0, hasReceivedBailout: false });
    }

    const goodInserts = savedBiz.map(b => {
      const typeMap: Record<string, { names: string[]; price: number }> = {
        school: { names: SCHOOL_GOOD_NAMES, price: baseFoodPrice * 1.5 },
        park: { names: PARK_GOOD_NAMES, price: baseFoodPrice * 1.2 },
        temple: { names: TEMPLE_GOOD_NAMES, price: baseFoodPrice * 0.4 },
      };
      const cfg = typeMap[b.type] ?? { names: ["Услуга"], price: baseFoodPrice };
      return {
        name: pick(cfg.names),
        businessId: b.id,
        basePrice: cfg.price,
        currentPrice: cfg.price * (1 + this.config.priceMarkup),
        quality: rand(55, 90),
        demand: rand(20, 50),
        supply: rand(40, 80),
      };
    });

    const savedGoods = await db.insert(goodsTable).values(goodInserts).returning();
    for (const g of savedGoods) this.goods.set(g.id, { ...g });

    logger.info({ schoolCount, parkCount, templeCount, goodsCount: savedGoods.length }, "Public services spawned");
  }

  private async generatePopulation(): Promise<void> {
    const { initialAgents, initialBusinesses, baseFoodPrice, baseSalary } = this.config;
    logger.info({ initialAgents, initialBusinesses }, "Generating population");

    const hospitalBusinessCount = Math.max(5, Math.floor(initialBusinesses * 0.08));
    const farmBusinessCount = Math.max(6, Math.floor(initialBusinesses * 0.08));
    const workshopBusinessCount = Math.max(4, Math.floor(initialBusinesses * 0.06));
    const schoolBusinessCount = Math.max(4, Math.floor(initialBusinesses * 0.05));
    const parkBusinessCount = Math.max(5, Math.floor(initialBusinesses * 0.06));
    const templeBusinessCount = Math.max(3, Math.floor(initialBusinesses * 0.04));
    const remaining = initialBusinesses - hospitalBusinessCount - farmBusinessCount - workshopBusinessCount - schoolBusinessCount - parkBusinessCount - templeBusinessCount;
    const foodBusinessCount = Math.floor(remaining * 0.60);
    const serviceBusinessCount = remaining - foodBusinessCount;

    const businessInserts = [];
    for (let i = 0; i < farmBusinessCount; i++) {
      businessInserts.push({
        name: `${pick(FARM_BUSINESS_NAMES)} №${i + 1}`,
        type: "farm",
        balance: rand(3000, 9000),
        productionRate: rand(8, 20),
        ownerId: null,
      });
    }
    for (let i = 0; i < workshopBusinessCount; i++) {
      businessInserts.push({
        name: `${pick(WORKSHOP_BUSINESS_NAMES)} №${i + 1}`,
        type: "workshop",
        balance: rand(2000, 7000),
        productionRate: rand(6, 15),
        ownerId: null,
      });
    }
    for (let i = 0; i < foodBusinessCount; i++) {
      businessInserts.push({
        name: `${pick(FOOD_BUSINESS_NAMES)} №${i + 1}`,
        type: "food",
        balance: rand(1000, 5000),
        productionRate: rand(5, 20),
        ownerId: null,
      });
    }
    for (let i = 0; i < serviceBusinessCount; i++) {
      businessInserts.push({
        name: `${pick(SERVICE_BUSINESS_NAMES)} №${i + 1}`,
        type: "service",
        balance: rand(800, 4000),
        productionRate: rand(3, 15),
        ownerId: null,
      });
    }
    for (let i = 0; i < hospitalBusinessCount; i++) {
      businessInserts.push({
        name: `${pick(HOSPITAL_BUSINESS_NAMES)} №${i + 1}`,
        type: "hospital",
        balance: rand(2000, 8000),
        productionRate: rand(2, 10),
        ownerId: null,
      });
    }
    for (let i = 0; i < schoolBusinessCount; i++) {
      businessInserts.push({ name: `${pick(SCHOOL_BUSINESS_NAMES)} №${i + 1}`, type: "school", balance: rand(1500, 5000), productionRate: rand(3, 8), ownerId: null });
    }
    for (let i = 0; i < parkBusinessCount; i++) {
      businessInserts.push({ name: `${pick(PARK_BUSINESS_NAMES)} №${i + 1}`, type: "park", balance: rand(1000, 4000), productionRate: rand(4, 10), ownerId: null });
    }
    for (let i = 0; i < templeBusinessCount; i++) {
      businessInserts.push({ name: `${pick(TEMPLE_BUSINESS_NAMES)} №${i + 1}`, type: "temple", balance: rand(500, 2000), productionRate: rand(2, 6), ownerId: null });
    }

    const savedBusinesses = await db.insert(businessesTable).values(businessInserts).returning();
    for (const b of savedBusinesses) {
      this.businesses.set(b.id, { ...b, employeeCount: 0, maxEmployees: MAX_EMPLOYEES_BY_TYPE[b.type] ?? 5, firedThisTick: 0, hiredThisTick: 0, ticksUnprofitable: 0, hasReceivedBailout: false });
    }

    const foodBusinessIds = savedBusinesses.filter(b => b.type === "food").map(b => b.id);
    const serviceBusinessIds = savedBusinesses.filter(b => b.type === "service").map(b => b.id);
    const hospitalBusinessIds = savedBusinesses.filter(b => b.type === "hospital").map(b => b.id);
    const farmBusinessIds = savedBusinesses.filter(b => b.type === "farm").map(b => b.id);
    const workshopBusinessIds = savedBusinesses.filter(b => b.type === "workshop").map(b => b.id);

    const goodInserts = [];
    for (const bId of farmBusinessIds) {
      goodInserts.push({
        name: pick(RAW_FOOD_GOOD_NAMES),
        businessId: bId,
        basePrice: baseFoodPrice * 1.2,
        currentPrice: baseFoodPrice * 1.2,
        quality: rand(60, 90),
        demand: rand(30, 60),
        supply: rand(60, 100),
      });
    }
    for (const bId of workshopBusinessIds) {
      goodInserts.push({
        name: pick(RAW_MATERIAL_GOOD_NAMES),
        businessId: bId,
        basePrice: baseFoodPrice * 1.2,
        currentPrice: baseFoodPrice * 1.2,
        quality: rand(50, 85),
        demand: rand(25, 55),
        supply: rand(50, 90),
      });
    }
    for (const bId of foodBusinessIds) {
      goodInserts.push({
        name: pick(FOOD_GOOD_NAMES),
        businessId: bId,
        basePrice: baseFoodPrice,
        currentPrice: baseFoodPrice * (1 + this.config.priceMarkup),
        quality: rand(30, 90),
        demand: rand(40, 80),
        supply: rand(40, 80),
      });
    }
    for (const bId of serviceBusinessIds) {
      goodInserts.push({
        name: pick(SERVICE_GOOD_NAMES),
        businessId: bId,
        basePrice: baseFoodPrice * 2,
        currentPrice: baseFoodPrice * 2 * (1 + this.config.priceMarkup),
        quality: rand(30, 90),
        demand: rand(30, 70),
        supply: rand(30, 70),
      });
    }
    for (const bId of hospitalBusinessIds) {
      goodInserts.push({
        name: pick(HOSPITAL_GOOD_NAMES),
        businessId: bId,
        basePrice: baseFoodPrice * 3,
        currentPrice: baseFoodPrice * 3 * (1 + this.config.priceMarkup),
        quality: rand(50, 95),
        demand: rand(20, 50),
        supply: rand(30, 60),
      });
    }
    const schoolBusinessIds = savedBusinesses.filter(b => b.type === "school").map(b => b.id);
    const parkBusinessIds = savedBusinesses.filter(b => b.type === "park").map(b => b.id);
    const templeBusinessIds = savedBusinesses.filter(b => b.type === "temple").map(b => b.id);
    for (const bId of schoolBusinessIds) {
      goodInserts.push({ name: pick(SCHOOL_GOOD_NAMES), businessId: bId, basePrice: baseFoodPrice * 1.5, currentPrice: baseFoodPrice * 1.5 * (1 + this.config.priceMarkup), quality: rand(55, 90), demand: rand(20, 50), supply: rand(40, 80) });
    }
    for (const bId of parkBusinessIds) {
      goodInserts.push({ name: pick(PARK_GOOD_NAMES), businessId: bId, basePrice: baseFoodPrice * 1.2, currentPrice: baseFoodPrice * 1.2 * (1 + this.config.priceMarkup), quality: rand(50, 85), demand: rand(25, 55), supply: rand(40, 75) });
    }
    for (const bId of templeBusinessIds) {
      goodInserts.push({ name: pick(TEMPLE_GOOD_NAMES), businessId: bId, basePrice: baseFoodPrice * 0.4, currentPrice: baseFoodPrice * 0.4 * (1 + this.config.priceMarkup), quality: rand(60, 95), demand: rand(15, 40), supply: rand(50, 90) });
    }

    const savedGoods = await db.insert(goodsTable).values(goodInserts).returning();
    for (const g of savedGoods) {
      this.goods.set(g.id, g);
    }

    const BATCH_SIZE = 200;
    const allBizIds = savedBusinesses.map(b => b.id);
    const agentInserts = [];
    for (let i = 0; i < initialAgents; i++) {
      const gender = Math.random() < 0.5 ? "male" : "female";
      const name = gender === "male" ? pick(MALE_NAMES) : pick(FEMALE_NAMES);
      const employerId = Math.random() < 0.7 ? pick(allBizIds) : null;
      agentInserts.push({
        name,
        gender,
        age: randInt(18, 70),
        mood: rand(40, 80),
        money: rand(50, 500),
        personality: pick(PERSONALITIES),
        socialization: rand(30, 80),
        currentAction: "idle",
        employerId,
        locationX: rand(0, 1000),
        locationY: rand(0, 1000),
        careerLevel: 1,
        ambition: randInt(20, 100),
        strength: rand(30, 90),
        intelligence: rand(30, 90),
      });
    }

    for (let i = 0; i < agentInserts.length; i += BATCH_SIZE) {
      const batch = agentInserts.slice(i, i + BATCH_SIZE);
      const saved = await db.insert(agentsTable).values(batch).returning();

      const needsInserts = saved.map(a => ({
        agentId: a.id,
        hunger: rand(50, 95),
        comfort: rand(50, 95),
        social: rand(50, 95),
        health: rand(60, 90),
        sleep: rand(50, 90),
        education: rand(40, 80),
        entertainment: rand(40, 80),
        faith: rand(30, 70),
        housingSafety: rand(60, 95),
        financialSafety: rand(60, 95),
        physicalSafety: rand(70, 95),
        socialRating: 50,
      }));

      const savedNeeds = await db.insert(needsTable).values(needsInserts).returning();
      const needsMap = new Map<number, typeof savedNeeds[0]>();
      for (const n of savedNeeds) needsMap.set(n.agentId, n);

      for (const agent of saved) {
        const needs = needsMap.get(agent.id);
        if (!needs) continue;
        this.agents.set(agent.id, {
          ...agent,
          needs: { hunger: needs.hunger, comfort: needs.comfort, social: needs.social, health: needs.health ?? 80, sleep: needs.sleep ?? 80, education: needs.education ?? 70, entertainment: needs.entertainment ?? 70, faith: needs.faith ?? 60, housingSafety: needs.housingSafety ?? 80, financialSafety: needs.financialSafety ?? 80, physicalSafety: needs.physicalSafety ?? 80, socialRating: needs.socialRating ?? 50, wellbeing: needs.wellbeing ?? 70 },
          needsId: needs.id,
          recentActions: [],
          jobHistory: agent.employerId ? [{ tick: 0, event: "hired", businessId: agent.employerId, businessName: this.businesses.get(agent.employerId)?.name ?? null }] : [],
          jobStartTick: agent.employerId ? 0 : null,
          jailedUntilTick: null,
        });
        if (agent.employerId) {
          const biz = this.businesses.get(agent.employerId);
          if (biz) biz.employeeCount++;
        }
      }
    }

    const allAgentIds = Array.from(this.agents.keys());
    const relationInserts = [];
    const relCount = Math.min(initialAgents * 3, 5000);
    for (let i = 0; i < relCount; i++) {
      const idA = pick(allAgentIds);
      let idB = pick(allAgentIds);
      while (idB === idA) idB = pick(allAgentIds);
      const level = rand(10, 70);
      relationInserts.push({ agentIdA: idA, agentIdB: idB, friendshipLevel: level });
    }
    if (relationInserts.length > 0) {
      await db.insert(relationsTable).values(relationInserts);
      for (const r of relationInserts) {
        let relMap = this.relations.get(r.agentIdA);
        if (!relMap) { relMap = new Map(); this.relations.set(r.agentIdA, relMap); }
        relMap.set(r.agentIdB, r.friendshipLevel);
        this.persistedRelations.add(`${r.agentIdA}:${r.agentIdB}`);
      }
    }

    logger.info({ agents: this.agents.size, businesses: this.businesses.size, goods: this.goods.size }, "Population generated");
  }

  async start(): Promise<void> {
    if (this.state.running) return;
    if (this.state.gameStatus !== "active") return;
    this.state.running = true;
    await this.persistState();
    this.startTimer();
    logger.info("Simulation started");
  }

  async stop(): Promise<void> {
    if (!this.state.running) return;
    this.state.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.persistState();
    logger.info("Simulation stopped");
  }

  private async waitForTickComplete(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (this.isTicking && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async reset(options: Partial<NewGameOptions> = {}): Promise<void> {
    const gameOptions = this.normalizeNewGameOptions(options);
    await this.stop();
    await this.waitForTickComplete();
    logger.info({ gameOptions }, "Resetting simulation...");

    // SQLite reset: delete dependent rows first and clear autoincrement counters.
    sqlite.transaction(() => {
      sqlite.prepare("DELETE FROM stats_history").run();
      sqlite.prepare("DELETE FROM agent_stat_history").run();
      sqlite.prepare("DELETE FROM daily_decrees").run();
      sqlite.prepare("DELETE FROM relations").run();
      sqlite.prepare("DELETE FROM needs").run();
      sqlite.prepare("DELETE FROM agents").run();
      sqlite.prepare("DELETE FROM goods").run();
      sqlite.prepare("DELETE FROM businesses").run();
      sqlite
        .prepare("DELETE FROM sqlite_sequence WHERE name IN ('stats_history','agent_stat_history','daily_decrees','relations','needs','agents','goods','businesses')")
        .run();
    })();

    this.agents.clear();
    this.businesses.clear();
    this.goods.clear();
    this.relations.clear();
    this.dirtyRelations.clear();
    this.persistedRelations.clear();
    this.agentStatHistory.clear();
    this.dailyDecrees = [];
    this.residentRequests = [];
    this.residentRequestSeq = 1;
    this.residentRequestReputationDelta = 0;
    this.factionDemands = [];
    this.factionDemandSeq = 1;

    this.state = {
      tick: 0,
      running: false,
      gameHour: 0,
      gameDay: 1,
      scenarioType: gameOptions.scenarioType,
      goalType: gameOptions.goalType,
      dayLimit: gameOptions.dayLimit,
      gameStatus: "active",
      gameOutcomeReason: null,
      actionPointsRemaining: DAILY_ACTION_POINTS_MAX,
      actionPointsMax: DAILY_ACTION_POINTS_MAX,
      governmentBudget: this.getScenarioBudget(gameOptions.scenarioType),
      totalTaxCollected: 0,
      totalSubsidiesPaid: 0,
      totalPensionPaid: 0,
      totalPublicServicesPaid: 0,
    };
    await this.persistState();
    await this.generatePopulation();
    await this.start();
    logger.info("Simulation reset complete");
  }

  async newGame(options: Partial<NewGameOptions>): Promise<void> {
    await this.reset(options);
  }

  private quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  private readRows(table: string): Record<string, unknown>[] {
    return sqlite.prepare(`SELECT * FROM ${this.quoteIdentifier(table)}`).all() as Record<string, unknown>[];
  }

  private insertRows(table: string, rows: Record<string, unknown>[]): void {
    if (rows.length === 0) return;
    const columns = Object.keys(rows[0]);
    if (columns.length === 0) return;
    const columnList = columns.map(column => this.quoteIdentifier(column)).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const insert = sqlite.prepare(`INSERT INTO ${this.quoteIdentifier(table)} (${columnList}) VALUES (${placeholders})`);
    for (const row of rows) {
      insert.run(...columns.map(column => row[column] ?? null));
    }
  }

  private buildSaveSummary(): SaveSlotSummary {
    const state = this.getSimulationState();
    return {
      tick: state.tick,
      gameDay: state.gameDay,
      gameHour: state.gameHour,
      scenarioType: state.scenarioType,
      goalType: state.goalType,
      gameStatus: state.gameStatus,
      goalProgress: state.goalProgress,
      population: state.population,
      governmentBudget: state.governmentBudget,
    };
  }

  private normalizeSaveSlotId(value: unknown): string {
    const raw = String(value ?? "").trim().toLowerCase();
    const normalized = raw.replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!normalized) {
      throw new Error("INVALID_SAVE_SLOT");
    }
    return normalized.slice(0, 48);
  }

  private normalizeSaveName(value: unknown, fallback: string): string {
    const name = String(value ?? "").trim();
    return (name || fallback).slice(0, 80);
  }

  listGameSaves() {
    const rows = sqlite.prepare(`
      SELECT id, name, summary, created_at, updated_at
      FROM save_slots
      ORDER BY updated_at DESC
    `).all() as Array<{ id: string; name: string; summary: string; created_at: number; updated_at: number }>;

    return rows.map(row => {
      let summary: SaveSlotSummary | null = null;
      try {
        summary = JSON.parse(row.summary) as SaveSlotSummary;
      } catch {
        summary = null;
      }
      return {
        id: row.id,
        name: row.name,
        summary,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    });
  }

  async saveGame(slotIdValue: unknown, nameValue?: unknown) {
    const slotId = this.normalizeSaveSlotId(slotIdValue);
    const name = this.normalizeSaveName(nameValue, `Save ${slotId}`);
    const hadTimer = this.timer !== null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      await this.waitForTickComplete();
      await this.persistState();

      const snapshot: Record<string, Record<string, unknown>[]> = {};
      for (const table of SAVE_SNAPSHOT_TABLES) {
        snapshot[table] = this.readRows(table);
      }
      const summary = this.buildSaveSummary();
      const now = Date.now();

      sqlite.prepare(`
        INSERT INTO save_slots (id, name, summary, snapshot_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          summary = excluded.summary,
          snapshot_json = excluded.snapshot_json,
          updated_at = excluded.updated_at
      `).run(slotId, name, JSON.stringify(summary), JSON.stringify(snapshot), now, now);

      return {
        id: slotId,
        name,
        summary,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
    } finally {
      if (hadTimer && this.state.running && this.timer === null) {
        this.startTimer();
      }
    }
  }

  async loadGameSave(slotIdValue: unknown) {
    const slotId = this.normalizeSaveSlotId(slotIdValue);
    const [row] = sqlite.prepare("SELECT snapshot_json FROM save_slots WHERE id = ?").all(slotId) as Array<{ snapshot_json: string }>;
    if (!row) {
      throw new Error("SAVE_SLOT_NOT_FOUND");
    }

    const snapshot = JSON.parse(row.snapshot_json) as Record<string, Record<string, unknown>[]>;
    await this.stop();
    await this.waitForTickComplete();

    sqlite.transaction(() => {
      for (const table of SAVE_DELETE_TABLES) {
        sqlite.prepare(`DELETE FROM ${this.quoteIdentifier(table)}`).run();
      }
      sqlite
        .prepare(`DELETE FROM sqlite_sequence WHERE name IN (${SAVE_DELETE_TABLES.map(() => "?").join(",")})`)
        .run(...SAVE_DELETE_TABLES);
      for (const table of SAVE_SNAPSHOT_TABLES) {
        this.insertRows(table, snapshot[table] ?? []);
      }
    })();

    this.agents.clear();
    this.businesses.clear();
    this.goods.clear();
    this.relations.clear();
    this.dirtyRelations.clear();
    this.persistedRelations.clear();
    this.agentStatHistory.clear();
    this.dailyDecrees = [];
    this.residentRequests = [];
    this.residentRequestSeq = 1;
    this.residentRequestReputationDelta = 0;
    this.factionDemands = [];
    this.factionDemandSeq = 1;

    await this.loadConfig();
    await this.loadState();
    await this.loadAgents();
    await this.loadBusinesses();
    await this.loadGoods();
    await this.loadRelations();
    await this.loadAgentStatHistory();
    await this.loadDailyDecrees();
    if (this.state.running) {
      this.startTimer();
    }
    return this.getSimulationState();
  }

  deleteGameSave(slotIdValue: unknown) {
    const slotId = this.normalizeSaveSlotId(slotIdValue);
    const result = sqlite.prepare("DELETE FROM save_slots WHERE id = ?").run(slotId) as { changes?: number };
    return { deleted: (result.changes ?? 0) > 0 };
  }

  private normalizeNewGameOptions(options: Partial<NewGameOptions>): NewGameOptions {
    const dayLimit = Math.round(Number(options.dayLimit ?? DEFAULT_GAME_OPTIONS.dayLimit));
    return {
      scenarioType: normalizeScenarioType(options.scenarioType),
      goalType: normalizeGoalType(options.goalType),
      dayLimit: Math.max(7, Math.min(120, Number.isFinite(dayLimit) ? dayLimit : DEFAULT_GAME_OPTIONS.dayLimit)),
    };
  }

  private getScenarioBudget(scenarioType: ScenarioType): number {
    switch (scenarioType) {
      case "crisis":
        return 25000;
      case "growth":
        return 260000;
      case "stability":
        return 140000;
      case "balanced":
      default:
        return 200000;
    }
  }

  private startTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    if (!this.state.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.isTicking) {
        this.scheduleNextTick();
        return;
      }
      this.isTicking = true;
      this.tick()
        .catch(err => { logger.error({ err }, "Tick error"); })
        .finally(() => {
          this.isTicking = false;
          this.scheduleNextTick();
        });
    }, this.config.tickIntervalMs);
  }

  private async tick(): Promise<void> {
    if (!this.state.running) return;
    const startTime = Date.now();

    this.state.tick++;
    this.state.gameHour = (this.state.gameHour + 1) % 24;
    if (this.state.gameHour === 0) this.state.gameDay++;

    const isNewDay = this.state.gameHour === 0;
    if (isNewDay) {
      this.state.actionPointsMax = DAILY_ACTION_POINTS_MAX;
      this.state.actionPointsRemaining = this.state.actionPointsMax;
      this.resolveExpiredFactionDemands();
    }
    this.refreshDailyDecreeStatuses();
    if (isNewDay) {
      this.applyDailyDecisionEffects();
      this.generateFactionDemands();
    }
    this.residentRequestReputationDelta = clamp(this.residentRequestReputationDelta * 0.995, -5, 5);
    this.generateResidentRequests();

    const decisionModifiers = this.getDecisionModifiers();
    const taxRate = clamp(this.config.taxRate + decisionModifiers.taxDelta, 0, 0.6);
    const needDecayRate = this.config.needDecayRate * decisionModifiers.needDecayMultiplier;
    const subsidyAmount = this.config.subsidyAmount * decisionModifiers.subsidyMultiplier;
    const baseSalary = this.config.baseSalary;
    const socialInteractionStrength = this.config.socialInteractionStrength * decisionModifiers.socialMultiplier;
    const pensionRate = this.config.pensionRate;

    // Динамический расчёт maxEmployees для частного сектора каждый тик.
    // Правило: бизнес может нанимать, пока общий ФОТ не превышает 60% баланса.
    // dynamicMax = floor(0.6 × balance / baseSalary)
    // Итого: max(STAFFING_TABLE_min, dynamicMax) — таблица задаёт минимум, баланс — потолок.
    // Государственный сектор (hospital/park/school/temple) финансируется из бюджета
    // и не зависит от собственного баланса — для него применяется фиксированный лимит.
    const PRIVATE_SECTOR_TYPES = new Set(["farm", "workshop", "food", "service"]);
    for (const biz of this.businesses.values()) {
      biz.firedThisTick = 0;
      biz.hiredThisTick = 0;
      if (PRIVATE_SECTOR_TYPES.has(biz.type)) {
        const staffingMin = MAX_EMPLOYEES_BY_TYPE[biz.type] ?? 1;
        // Коэффициент зависит от типа бизнеса:
        // - Производители (farm/workshop): низкий коэффициент 0.08 — их доход только B2B (~480/день),
        //   на 7 сотрудников при зарплате 61 нужно 480/7 ≈ 68, баланс 68/0.08 = 850 минимум.
        //   При балансе 5000 → max=6 (устойчиво). При 50000 → max=65 (если сверхприбыльны).
        // - Торговля (food/service): высокий коэффициент 0.6 — высокий оборот от агентов каждый тик,
        //   доход намного выше зарплатного фонда при любом разумном числе работников.
        const coef = (biz.type === "farm" || biz.type === "workshop") ? 0.08 : 0.6;
        const dynamicMax = biz.balance > 0
          ? Math.floor(coef * biz.balance / baseSalary)
          : 0;
        biz.maxEmployees = Math.max(staffingMin, dynamicMax);
      }
      // Public sector: зафиксировано таблицей штатного расписания (не пересчитывается)
    }

    const dailyDeaths: number[] = [];

    // ── Индекс экономического благосостояния ─────────────────────────────
    // Рассчитывается один раз в начале тика; используется для рождаемости
    // и миграции. Три компонента (0..1 каждый):
    //   • занятость (40%)  — доля работающих среди трудоспособных (18-65)
    //   • базовые нужды (40%) — среднее по голоду + здоровью + сну
    //   • богатство (20%)  — среднее богатство агента, нормализованное к 40
    //
    // wellbeingScore = 0 (полный кризис) .. 1 (процветание)
    const _pop = this.agents.size;
    let _sumHunger = 0, _sumHealth = 0, _sumSleep = 0, _sumWealth = 0;
    let _workingCount = 0, _employedCount = 0;
    for (const a of this.agents.values()) {
      _sumHunger += a.needs.hunger;
      _sumHealth += a.needs.health;
      _sumSleep  += a.needs.sleep;
      _sumWealth += a.money;
      if (!a.isRetired && a.age >= 18 && a.age <= 65) {
        _workingCount++;
        if (a.employerId != null) _employedCount++;
      }
    }
    const _avgFundNeeds = _pop > 0
      ? (_sumHunger + _sumHealth + _sumSleep) / (_pop * 3 * 100)
      : 0.5;
    const _empRate     = _workingCount > 0 ? _employedCount / _workingCount : 0.5;
    const _wealthFactor = Math.min(_pop > 0 ? (_sumWealth / _pop) / 40 : 0, 1);
    const wellbeingScore = _empRate * 0.4 + _avgFundNeeds * 0.4 + _wealthFactor * 0.2;

    // ── Рождаемость привязана к благосостоянию (нет жёсткого предела) ────
    // При кризисе (wellbeing≈0) рождаемость ≈ 0.2%/день — биологический минимум.
    // При процветании (wellbeing≈1) — до 1.2%/день.
    // Нет потолка по числу жителей: город растёт пока экономика справляется,
    // и сжимается при кризисе через эмиграцию и смертность.
    const birthRate = 0.002 + wellbeingScore * 0.01; // 0.2%..1.2%/день
    const plannedBirths = isNewDay ? Math.max(1, Math.round(_pop * birthRate)) : 0;

    // ── Иммиграция: сколько человек прибудет сегодня (если isNewDay) ─────
    // Люди приезжают из «других городов» когда здесь лучше, чем в среднем.
    // Порог привлекательности: wellbeing > 0.55.
    // Поток масштабируется с ростом привлекательности, лимит 2% в день.
    const plannedImmigrants = (isNewDay && wellbeingScore > 0.55)
      ? Math.min(
          Math.round(_pop * 0.02),
          Math.round(_pop * (wellbeingScore - 0.55) * 0.05)
        )
      : 0;

    // ── Daily productivity investments ─────────────────────────────────────────
    // Profitable commercial businesses (food/service/retail) auto-invest when
    // balance exceeds threshold: costs 5000 coins per level gained, cap at 20.
    if (isNewDay) {
      const INVEST_COST = 5000;
      const INVEST_TYPES = new Set(["food", "service", "retail"]);
      for (const biz of this.businesses.values()) {
        if (!INVEST_TYPES.has(biz.type)) continue;
        if (biz.balance <= 0) continue;
        const currentLevel = biz.productivityLevel ?? 0;
        if (currentLevel >= 20) continue;
        const threshold = INVEST_COST * (currentLevel + 1) * 1.5;
        if (biz.balance >= threshold) {
          biz.balance -= INVEST_COST;
          biz.productivityLevel = currentLevel + 1;
        }
      }
    }

    let gdp = 0;
    let taxRevenue = 0;
    let subsidiesPaid = 0;
    let pensionPaid = 0;
    let publicServiceSpend = 0;
    let runningBudget = this.state.governmentBudget;
    let inheritanceRecycled = 0; // total estate money returned to economy

    const dbgBudgetBefore = runningBudget;
    const dbgBizBalanceBefore = Array.from(this.businesses.values()).reduce((s, b) => s + b.balance, 0);
    let dbgActWork = 0, dbgActEat = 0, dbgActRest = 0, dbgActSocialize = 0, dbgActIdle = 0, dbgActSleep = 0, dbgActHeal = 0, dbgActStudy = 0, dbgActRelax = 0, dbgActPray = 0;
    let dbgMoneyIn = 0, dbgMoneyOut = 0, dbgWagesPaid = 0;
    let dbgSuccessful = 0, dbgFailedNoGoods = 0, dbgFailedNoMoney = 0;
    let dbgPensionRecipients = 0, dbgSubsidyRecipients = 0;
    let dbgSkipped = 0;

    const agentIds = Array.from(this.agents.keys());

    // ── Социальный рейтинг: пересчёт раз в игровой день ────────────────────
    // socialRating = среднее всех шкал дружбы, где агент участвует (A или B)
    if (isNewDay) {
      const ratingAcc = new Map<number, { sum: number; count: number }>();
      for (const [agentIdA, relMap] of this.relations) {
        for (const [agentIdB, level] of relMap) {
          for (const id of [agentIdA, agentIdB]) {
            const acc = ratingAcc.get(id) ?? { sum: 0, count: 0 };
            acc.sum += level;
            acc.count++;
            ratingAcc.set(id, acc);
          }
        }
      }
      for (const [id, acc] of ratingAcc) {
        const agent = this.agents.get(id);
        if (agent) {
          agent.needs.socialRating = clamp(acc.count > 0 ? acc.sum / acc.count : 50);
        }
      }
    }

    // Public-sector businesses (schools, parks, hospitals, temples) get government
    // subsidies and must be allowed to hire even when their balance is negative —
    // otherwise they fire all staff, receive only the minimum floor subsidy (≈0),
    // and can never recover.  Commercial businesses (food/service) must self-fund,
    // so they are excluded once their balance drops too low.
    // Raw-producer businesses (farms, workshops) are the backbone of the supply chain.
    // They are allowed to hire as long as they are not catastrophically bankrupt —
    // B2B revenue will recover them once workers start boosting output.
    const availableBusinessIds = Array.from(this.businesses.values())
      .filter(b => {
        // Raw producers: allow hiring as long as they can still earn B2B revenue.
        // B2B income with even 1 employee exceeds daily wage, so allow hiring
        // until deeply distressed.
        if (b.type === "farm" || b.type === "workshop") {
          if (b.balance <= -1500) return false;
          if (b.employeeCount >= b.maxEmployees) return false;
          return true;
        }
        // Commercial: only hire if not deeply in debt
        if (!PUBLIC_SECTOR_TYPES.has(b.type) && b.balance <= -200) return false;
        // Public sector: allow hiring as long as balance is not catastrophically low
        if (PUBLIC_SECTOR_TYPES.has(b.type) && b.balance <= -80_000) return false;
        // Use maxEmployees as the single source of truth for hiring capacity
        if (b.employeeCount >= b.maxEmployees) return false;
        return true;
      })
      .map(b => b.id);

    // Предварительно строим карту «бизнес → грейд → кол-во сотрудников».
    // Используется в vacancy-check при повышениях: O(N) один раз вместо O(N²).
    const bizGradeCount = new Map<number, Map<number, number>>();
    for (const agent of this.agents.values()) {
      if (!agent.employerId || agent.isRetired) continue;
      if (!bizGradeCount.has(agent.employerId)) bizGradeCount.set(agent.employerId, new Map());
      const m = bizGradeCount.get(agent.employerId)!;
      m.set(agent.careerLevel, (m.get(agent.careerLevel) ?? 0) + 1);
    }

    for (const agentId of agentIds) {
      const agent = this.agents.get(agentId);
      if (!agent) continue;

      // Age progression + retirement + death: once per game day
      if (isNewDay) {
        agent.age++;

        // Retirement: agents at or above 65 who aren't yet retired
        if (!agent.isRetired && agent.age >= 65) {
          if (agent.employerId != null) {
            const oldBiz = this.businesses.get(agent.employerId);
            if (oldBiz) oldBiz.employeeCount = Math.max(0, oldBiz.employeeCount - 1);
            const tenure = agent.jobStartTick != null ? this.state.tick - agent.jobStartTick : undefined;
            agent.jobHistory = [...agent.jobHistory, { tick: this.state.tick, event: "retired", businessId: agent.employerId, businessName: oldBiz?.name ?? null, duration: tenure }];
            agent.employerId = null;
            agent.jobStartTick = null;
          } else {
            agent.jobHistory = [...agent.jobHistory, { tick: this.state.tick, event: "retired", businessId: null, businessName: null }];
          }
          agent.isRetired = true;
        }

        // Death: retired agents have an age-based daily mortality chance
        if (agent.isRetired) {
          const deathChance = Math.min((agent.age - 64) * 0.005, 0.5);
          if (Math.random() < deathChance) {
            dailyDeaths.push(agentId);
            dbgSkipped++;
            continue; // skip all further processing for this agent
          }
        }
      }

      // Death from health reaching zero (any agent, any tick)
      if (agent.needs.health <= 0) {
        dailyDeaths.push(agentId);
        dbgSkipped++;
        continue;
      }

      // Pension: once per game day only (not every tick)
      if (isNewDay && agent.isRetired) {
        const pensionAmount = baseSalary * pensionRate;
        if (runningBudget >= pensionAmount) {
          agent.money += pensionAmount;
          pensionPaid += pensionAmount;
          runningBudget -= pensionAmount;
          dbgPensionRecipients++;
          dbgMoneyIn += pensionAmount;
        }
      }

      // ── Daily payroll ─────────────────────────────────────────────────────
      // Salary is paid ONCE per game day (not every tick). This keeps business
      // wage costs predictable: 1 employee costs baseSalary per day, not per tick.
      if (isNewDay && !agent.isRetired && agent.employerId != null) {
        const payBiz = this.businesses.get(agent.employerId);
        if (payBiz) {
          const salary = calcSalary(baseSalary, agent.careerLevel);
          const tax = salary * taxRate;
          const netPay = salary - tax;
          agent.money += netPay;
          payBiz.balance -= salary;
          taxRevenue += tax;
          runningBudget += tax;
          gdp += salary;
          dbgMoneyIn += netPay;
          dbgWagesPaid += salary;
        }
      }

      // Firing: проверяем два условия.
      // 1) Баланс ниже порога (50% шанс в тике, чтобы не увольнять всех разом).
      //    Фермы/мастерские терпят небольшой дефицит — их B2B-доход поступает нечасто.
      // 2) Компания переполнена (employeeCount > maxEmployees) — шанс 70% в тике,
      //    чтобы быстро скорректировать штат при падении динамического потолка.
      if (!agent.isRetired && agent.employerId != null) {
        const employer = this.businesses.get(agent.employerId);
        if (employer) {
          // Farm/workshop: fire at -1500 (B2B income is slow, need buffer)
          // Food/service: fire at -400 (need small buffer to weather demand slumps)
          const fireThreshold = (employer.type === "farm" || employer.type === "workshop") ? -1500 : -400;
          const overCapacity = employer.maxEmployees != null && employer.employeeCount > employer.maxEmployees;
          const shouldFire =
            (employer.balance < fireThreshold && Math.random() < 0.5) ||
            (overCapacity && Math.random() < 0.7);
          if (shouldFire) {
            employer.employeeCount = Math.max(0, employer.employeeCount - 1);
            employer.firedThisTick++;
            const tenure = agent.jobStartTick != null ? this.state.tick - agent.jobStartTick : undefined;
            agent.jobHistory = [...agent.jobHistory, { tick: this.state.tick, event: "fired", businessId: agent.employerId, businessName: employer.name, duration: tenure }];
            agent.employerId = null;
            agent.jobStartTick = null;
          }
        }
      }

      // Voluntary job switching: unhappy employed agents quit to seek better work (3% chance when mood < 35 or money < 30)
      if (!agent.isRetired && agent.employerId != null && Math.random() < 0.03) {
        const isUnhappy = agent.mood < 35 || (agent.money < 30 && agent.needs.hunger < 35);
        if (isUnhappy) {
          const currentBiz = this.businesses.get(agent.employerId);
          if (currentBiz) {
            currentBiz.employeeCount = Math.max(0, currentBiz.employeeCount - 1);
            currentBiz.firedThisTick++;
            const tenure = agent.jobStartTick != null ? this.state.tick - agent.jobStartTick : undefined;
            agent.jobHistory = [...agent.jobHistory, { tick: this.state.tick, event: "quit", businessId: agent.employerId, businessName: currentBiz.name, duration: tenure }];
            agent.employerId = null;
            agent.jobStartTick = null;
          }
        }
      }

      // ── Career advancement (grades 1–5) ─────────────────────────────────
      if (!agent.isRetired) {
        const careerTarget = targetGrade(agent.ambition);
        const tenure = agent.jobStartTick != null ? this.state.tick - agent.jobStartTick : 0;
        const employerBiz = agent.employerId ? this.businesses.get(agent.employerId) : null;

        // Проверка вакансии по штатному расписанию:
        // повышение разрешено только если на целевом грейде есть свободное место.
        const hasVacancy = (bizId: number, bizType: string, toGrade: number): boolean => {
          const slots = STAFFING_TABLE[bizType]?.[toGrade] ?? 0;
          if (slots <= 0) return false;
          const occupied = bizGradeCount.get(bizId)?.get(toGrade) ?? 0;
          return occupied < slots;
        };

        // Обновляем карту грейдов: агент переходит с fromGrade на toGrade в данном бизнесе.
        const recordPromotion = (bizId: number, fromGrade: number, toGrade: number): void => {
          if (!bizGradeCount.has(bizId)) bizGradeCount.set(bizId, new Map());
          const m = bizGradeCount.get(bizId)!;
          m.set(fromGrade, Math.max(0, (m.get(fromGrade) ?? 0) - 1));
          m.set(toGrade, (m.get(toGrade) ?? 0) + 1);
        };

        if (agent.careerLevel < careerTarget && agent.employerId != null && employerBiz != null && tenure >= 120) {
          const toGrade = agent.careerLevel + 1;
          const canPromote = hasVacancy(agent.employerId, employerBiz.type, toGrade);

          if (canPromote) {
            // Ambition-driven promotion attempt.
            // Интеллект даёт бонус: intel=50→+0%, intel=90→+0.4%.
            const intelligenceBonus = ((agent.intelligence ?? 50) - 50) * 0.0001;
            const promotionProb = (agent.ambition / 100) * 0.005 + intelligenceBonus;
            if (Math.random() < promotionProb) {
              recordPromotion(agent.employerId, agent.careerLevel, toGrade);
              agent.careerLevel = toGrade;
              agent.jobHistory = [...agent.jobHistory, {
                tick: this.state.tick, event: "promoted",
                businessId: agent.employerId, businessName: employerBiz.name,
              }];
              agent.money += agent.careerLevel * rand(8, 15);
              agent.mood = clamp(agent.mood + rand(5, 12));
            }
          } else if (availableBusinessIds.length > 1 && Math.random() < 0.035) {
            // Нет вакансии — ищет работу с возможностью роста в другом бизнесе.
            const candidates = availableBusinessIds.filter(id => id !== agent.employerId);
            if (candidates.length > 0) {
              const newBizId = pick(candidates);
              const newBiz = this.businesses.get(newBizId);
              if (newBiz) {
                const oldBiz = employerBiz;
                oldBiz.employeeCount = Math.max(0, oldBiz.employeeCount - 1);
                oldBiz.firedThisTick++;
                agent.jobHistory = [...agent.jobHistory, {
                  tick: this.state.tick, event: "quit",
                  businessId: agent.employerId, businessName: oldBiz.name, duration: tenure,
                }];
                agent.employerId = newBizId;
                agent.jobStartTick = this.state.tick;
                newBiz.employeeCount++;
                newBiz.hiredThisTick++;
                agent.jobHistory = [...agent.jobHistory, {
                  tick: this.state.tick, event: "hired",
                  businessId: newBizId, businessName: newBiz.name,
                }];
              }
            }
          }
        } else if (agent.careerLevel >= careerTarget && agent.employerId != null && employerBiz != null
            && tenure >= 200 && agent.careerLevel < 5 && Math.random() < 0.002) {
          // Исключительное повышение сверхрезультативных сотрудников — тоже требует вакансии.
          const toGrade = agent.careerLevel + 1;
          if (hasVacancy(agent.employerId, employerBiz.type, toGrade)) {
            recordPromotion(agent.employerId, agent.careerLevel, toGrade);
            agent.careerLevel = toGrade;
            agent.jobHistory = [...agent.jobHistory, {
              tick: this.state.tick, event: "promoted",
              businessId: agent.employerId, businessName: employerBiz.name,
            }];
            agent.money += agent.careerLevel * rand(8, 15);
            agent.mood = clamp(agent.mood + rand(3, 8));
          }
        }
      }

      // Job seeking: unemployed, non-retired agents have a 60% chance to find work per tick.
      // Повышено с 30% до 60% чтобы безработные активнее занимали новые места.
      // Найм разрешён если:
      //   а) в бизнесе есть вакансия на грейде агента по таблице штатного расписания, ИЛИ
      //   б) у бизнеса есть динамическая ёмкость выше STAFFING_TABLE — лишние места
      //      выделяются как grade-1 позиции (рядовые работники).
      if (!agent.isRetired && agent.employerId == null && availableBusinessIds.length > 0 && Math.random() < 0.60) {
        const eligibleBizIds = availableBusinessIds.filter(bizId => {
          const biz = this.businesses.get(bizId);
          if (!biz) return false;
          const tableSlots = STAFFING_TABLE[biz.type]?.[agent.careerLevel] ?? 0;
          const occupied = bizGradeCount.get(bizId)?.get(agent.careerLevel) ?? 0;
          // Стандартная проверка по таблице штатного расписания
          if (occupied < tableSlots) return true;
          // Динамическое расширение: лишние места сверх таблицы — только grade-1
          if (agent.careerLevel === 1) {
            const baseCapacity = MAX_EMPLOYEES_BY_TYPE[biz.type] ?? 0;
            const dynamicExtra = Math.max(0, (biz.maxEmployees ?? 0) - baseCapacity);
            const totalGrade1Occupied = bizGradeCount.get(bizId)?.get(1) ?? 0;
            const totalGrade1Slots = (STAFFING_TABLE[biz.type]?.[1] ?? 0) + dynamicExtra;
            return totalGrade1Occupied < totalGrade1Slots;
          }
          return false;
        });
        if (eligibleBizIds.length > 0) {
          const newBizId = pick(eligibleBizIds);
          const newBiz = this.businesses.get(newBizId);
          if (newBiz) {
            agent.employerId = newBizId;
            agent.jobStartTick = this.state.tick;
            newBiz.employeeCount++;
            newBiz.hiredThisTick++;
            // Обновляем карту грейдов при найме
            if (!bizGradeCount.has(newBizId)) bizGradeCount.set(newBizId, new Map());
            const m = bizGradeCount.get(newBizId)!;
            m.set(agent.careerLevel, (m.get(agent.careerLevel) ?? 0) + 1);
            agent.jobHistory = [...agent.jobHistory, { tick: this.state.tick, event: "hired", businessId: newBizId, businessName: newBiz.name }];
          }
        }
      }

      // ── Robbery (Грабёж) ─────────────────────────────────────────────────
      // Desperate unemployed agent (money < 20, financialSafety < 25) has a
      // small chance to rob a random other agent (spec: "ограбить при фин. кризисе")
      // Сила вора повышает шанс ограбления; Сила жертвы снижает урон по physicalSafety
      const robberyChance = 0.01 + (agent.strength ?? 50) * 0.0001; // 50→1.5%, 90→1.9%
      if (!agent.isRetired
          && agent.jailedUntilTick == null
          && agent.employerId == null
          && agent.money < 20
          && agent.needs.financialSafety < 25
          && Math.random() < robberyChance) {
        const potentialVictims = Array.from(this.agents.values())
          .filter(v => v.id !== agent.id && !v.isRetired && v.jailedUntilTick == null && v.money > 30);
        if (potentialVictims.length > 0) {
          const victim = pick(potentialVictims);
          const stolen = rand(15, 40);
          // Thief gains money, brief mood boost, financialSafety rises
          agent.money += stolen;
          agent.needs.financialSafety = clamp(agent.needs.financialSafety + 25);
          agent.mood = clamp(agent.mood + rand(3, 8));
          agent.currentAction = "rob";
          agent.recentActions = ["rob", ...agent.recentActions].slice(0, 10);
          // Слабый вор (низкая Сила) чаще попадается; сильный — чаще уходит
          const arrestChance = 0.45 - (agent.strength ?? 50) * 0.003; // 50→30%, 90→18%
          if (Math.random() < arrestChance) {
            agent.jailedUntilTick = this.state.tick + 360;
            agent.mood = clamp(agent.mood - rand(20, 35));
          } else {
            // Evaded but mood penalty from guilt
            agent.mood = clamp(agent.mood - rand(5, 10));
          }
          // Жертва с высокой Силой теряет меньше physicalSafety
          const safetyLoss = Math.round(55 - (victim.strength ?? 50) * 0.2); // 50→45, 90→37, 10→53
          victim.money = Math.max(0, victim.money - stolen);
          victim.needs.physicalSafety = clamp(victim.needs.physicalSafety - safetyLoss);
          victim.mood = clamp(victim.mood - rand(8, 15));
          victim.recentActions = ["robbed", ...victim.recentActions].slice(0, 10);
        }
      }

      // Jailed agents skip action processing this tick
      if (agent.jailedUntilTick != null) {
        if (this.state.tick >= agent.jailedUntilTick) {
          agent.jailedUntilTick = null; // Released
          agent.mood = clamp(agent.mood + rand(3, 8));
        } else {
          agent.currentAction = "jailed";
          // Still apply need decay below, but skip criticalNeed action
          agent.needs.hunger = clamp(agent.needs.hunger - needDecayRate * rand(0.5, 1.5));
          agent.needs.comfort = clamp(agent.needs.comfort - needDecayRate * rand(0.3, 1.0));
          agent.needs.sleep = clamp(agent.needs.sleep - 1.8 * rand(0.8, 1.2));
          continue;
        }
      }

      agent.needs.hunger = clamp(agent.needs.hunger - needDecayRate * rand(0.5, 1.5));
      agent.needs.comfort = clamp(agent.needs.comfort - needDecayRate * rand(0.3, 1.0));
      // Общение: по спеку -1 каждые 4 часа ≈ 0.25/тик — не масштабируется needDecayRate
      agent.needs.social = clamp(agent.needs.social - rand(0.15, 0.4));
      agent.needs.sleep = clamp(agent.needs.sleep - 1.8 * rand(0.8, 1.2));
      // Образование: по спеку не расходуется — очень медленное снижение для устойчивости
      agent.needs.education = clamp(agent.needs.education - rand(0.05, 0.15));
      // Развлечения: по спеку -0.5/час ≈ 0.5/тик
      agent.needs.entertainment = clamp(agent.needs.entertainment - rand(0.3, 0.7));
      // Вера: медленный распад
      agent.needs.faith = clamp(agent.needs.faith - rand(0.1, 0.3));

      // Благосостояние: отражает удовлетворённость уровнем жизни
      // Растёт при достойной зарплате, медленно падает без роста карьеры
      {
        const salary = agent.employerId ? calcSalary(baseSalary, agent.careerLevel) : 0;
        const targetGradeVal = targetGrade(agent.ambition);
        if (salary > 0 && agent.careerLevel >= targetGradeVal) {
          // Доволен карьерой — медленный рост
          agent.needs.wellbeing = clamp(agent.needs.wellbeing + rand(0.1, 0.3));
        } else if (salary > 0 && agent.careerLevel < targetGradeVal) {
          // Работает, но ниже желаемого уровня — медленный спад
          agent.needs.wellbeing = clamp(agent.needs.wellbeing - rand(0.2, 0.5));
        } else {
          // Безработный — ускоренный спад
          agent.needs.wellbeing = clamp(agent.needs.wellbeing - rand(0.4, 0.8));
        }
      }

      // Financial safety: decays when low on money, recovers when financially stable
      if (agent.money < 50) {
        agent.needs.financialSafety = clamp(agent.needs.financialSafety - 0.8);
      } else if (agent.money < 100) {
        agent.needs.financialSafety = clamp(agent.needs.financialSafety - 0.4);
      } else {
        agent.needs.financialSafety = clamp(agent.needs.financialSafety + 0.15);
      }

      // Housing safety: decays when unemployed and poor, recovers when employed
      if (!agent.employerId) {
        if (agent.money < 30) {
          agent.needs.housingSafety = clamp(agent.needs.housingSafety - 1.2);
        } else if (agent.money < 100) {
          agent.needs.housingSafety = clamp(agent.needs.housingSafety - 0.5);
        } else {
          agent.needs.housingSafety = clamp(agent.needs.housingSafety - 0.15);
        }
      } else {
        agent.needs.housingSafety = clamp(agent.needs.housingSafety + 0.25);
      }

      // Physical safety: no natural decay — only drops via robbery; slowly self-recovers
      if (agent.needs.physicalSafety < 80) {
        agent.needs.physicalSafety = clamp(agent.needs.physicalSafety + 0.4);
      }

      // Health dynamics
      // Model: health requires active medical care to stay high.
      // Base entropy (aging) drains health every tick; hospitals are the primary cure.
      // Strength slows the drain; hunger/sleep crisis accelerates it.
      let healthDelta = 0;
      if (agent.needs.hunger < 30) healthDelta -= 1.0;  // starvation hurts
      if (agent.needs.sleep < 20) healthDelta -= 1.5;   // exhaustion hurts
      // Mild recovery when very well-fed and rested (eating healthy helps, but not enough alone)
      if (agent.needs.hunger > 70 && agent.needs.sleep > 70) healthDelta += 0.05;
      // Base entropy: strength=50 → -0.12/tick, strength=90 → -0.08/tick, strength=10 → -0.16/tick
      // Эпидемия ускоряет деградацию здоровья в 3 раза
      healthDelta -= (0.15 - (agent.strength ?? 50) * 0.001) * this.getEpidemicModifier();
      agent.needs.health = clamp(agent.needs.health + healthDelta);

      const criticalNeed = this.getCriticalNeed(agent.needs);
      let income = 0;

      if (criticalNeed === "sleep") {
        // Agent sleeps: slow recovery so residents need 8-12 hours of sleep per day
        agent.needs.sleep = clamp(agent.needs.sleep + rand(2, 6));
        agent.needs.health = clamp(agent.needs.health + 0.3);
        agent.currentAction = "sleep";
      } else if (criticalNeed === "health") {
        // Try to visit a hospital; fall back to home rest if unavailable or unaffordable
        const hospitalGood = this.pickAvailableGood("hospital");
        if (hospitalGood && agent.money >= hospitalGood.currentPrice) {
          agent.money -= hospitalGood.currentPrice;
          // Качество влияет на восстановление здоровья (quality=50 → ×1.0, 100 → ×1.3, 0 → ×0.7)
          const hospQMult = 0.7 + hospitalGood.quality * 0.006;
          agent.needs.health = clamp(agent.needs.health + rand(20, 35) * hospQMult);
          agent.needs.comfort = clamp(agent.needs.comfort + rand(5, 12));
          agent.currentAction = "heal";
          hospitalGood.demand = clamp(hospitalGood.demand + 1, 0, 200);
          // Накопление качества: каждые 1000 монет → +1 балл качества
          hospitalGood.quality = Math.min(100, hospitalGood.quality + hospitalGood.currentPrice / 1000);
          const bizId = hospitalGood.businessId;
          if (bizId) {
            const biz = this.businesses.get(bizId);
            if (biz) biz.balance += hospitalGood.currentPrice;
          }
          // Больницы получают государственное финансирование через ежедневную субсидию (см. isNewDay блок).
          gdp += hospitalGood.currentPrice;
          dbgMoneyOut += hospitalGood.currentPrice;
          dbgSuccessful++;
        } else {
          // No hospital available or can't afford → rest at home (slower sleep recovery than proper sleep)
          agent.needs.sleep = clamp(agent.needs.sleep + rand(3, 5));
          agent.needs.comfort = clamp(agent.needs.comfort + rand(5, 12));
          agent.needs.health = clamp(agent.needs.health + 0.3);
          agent.currentAction = "rest";
        }
      } else if (criticalNeed === "hunger") {
        const foodGood = this.pickGoodByPreference("food", agent.personality, agent.socialization, agent.money);
        if (foodGood && agent.money >= foodGood.currentPrice) {
          agent.money -= foodGood.currentPrice;
          // Качество влияет на насыщение едой (quality=50 → ×1.0, 100 → ×1.3, 0 → ×0.7)
          const foodQMult = 0.7 + foodGood.quality * 0.006;
          agent.needs.hunger = clamp(agent.needs.hunger + rand(30, 60) * foodQMult);
          agent.currentAction = "eat";
          foodGood.demand = clamp(foodGood.demand + 1, 0, 200);
          // Накопление качества: каждые 1000 монет → +1 балл качества
          foodGood.quality = Math.min(100, foodGood.quality + foodGood.currentPrice / 1000);
          const bizId = foodGood.businessId;
          if (bizId) {
            const biz = this.businesses.get(bizId);
            if (biz) biz.balance += foodGood.currentPrice;
          }
          gdp += foodGood.currentPrice;
          dbgMoneyOut += foodGood.currentPrice;
          dbgSuccessful++;
        } else if (!foodGood || agent.money < (foodGood?.currentPrice ?? 0)) {
          if (!foodGood) dbgFailedNoGoods++;
          else dbgFailedNoMoney++;
          // No food available or can't afford — work to earn (salary paid daily, not per tick)
          agent.currentAction = agent.employerId ? "work" : "idle";
        }
      } else if (criticalNeed === "comfort") {
        agent.needs.comfort = clamp(agent.needs.comfort + rand(20, 40));
        agent.currentAction = "rest";
        const serviceGood = this.pickGoodByPreference("service", agent.personality, agent.socialization, agent.money);
        if (serviceGood && agent.money >= serviceGood.currentPrice) {
          const servicePayment = serviceGood.currentPrice;
          agent.money -= servicePayment;
          serviceGood.demand = clamp(serviceGood.demand + 1, 0, 200);
          serviceGood.supply = clamp(serviceGood.supply - 1, 0, 200);
          // Накопление качества
          serviceGood.quality = Math.min(100, serviceGood.quality + servicePayment / 1000);
          // Выручка поступает в баланс сервис-бизнеса
          const bizId = serviceGood.businessId;
          if (bizId) {
            const biz = this.businesses.get(bizId);
            if (biz) biz.balance += servicePayment;
          }
          gdp += servicePayment;
          dbgMoneyOut += servicePayment;
          dbgSuccessful++;
        }
      } else if (criticalNeed === "social") {
        const partnerId = this.pickSocialPartner(agentId, agentIds);
        if (partnerId) {
          const partner = this.agents.get(partnerId);
          if (partner) {
            // ── Матрица диалогов: тир инициатора × тир ответчика (v1.6) ──
            const initTier = getMoodTier(agent.mood);
            const respTier = getMoodTier(partner.mood);
            const outcomes = DIALOG_MATRIX[initTier][respTier];
            // Если 2 варианта — «Рандом» из спека (50/50)
            const [dInit, dResp, dFriend] = outcomes[Math.floor(Math.random() * outcomes.length)];

            // socialInteractionStrength как масштабный коэффициент (default=2 → 1x)
            const s = socialInteractionStrength * 0.5;
            const dMoodInit = dInit * s;
            const dMoodResp = dResp * s;

            agent.needs.social   = clamp(agent.needs.social   + rand(20, 50));
            partner.needs.social = clamp(partner.needs.social + rand(10, 30));

            agent.mood   = clamp(agent.mood   + dMoodInit);
            partner.mood = clamp(partner.mood + dMoodResp);

            // Шкала дружбы: точно по спеку (dFriend), масштабируется
            const friendDelta = dFriend * s * 5;
            this.updateRelation(agentId, partnerId, friendDelta);
            this.updateRelation(partnerId, agentId, friendDelta * 0.5);
          }
        }
        agent.currentAction = "socialize";
      } else if (criticalNeed === "education") {
        // Schools are publicly funded — free for agents. Budget paid via daily flat subsidy (see isNewDay block).
        const schoolGood = this.pickAvailableGood("school");
        if (schoolGood) {
          // Интеллект усиливает усвоение знаний: intel=50 → ×1.0, intel=90 → ×1.4
          const intelFactor = 0.5 + (agent.intelligence ?? 50) / 100;
          // Agent uses service for free
          agent.needs.education = clamp(agent.needs.education + rand(25, 45) * intelFactor);
          agent.needs.comfort = clamp(agent.needs.comfort + rand(3, 8));
          agent.currentAction = "study";
          // Учёба медленно повышает Интеллект (max 100)
          agent.intelligence = Math.min(100, (agent.intelligence ?? 50) + rand(0.1, 0.3));
          schoolGood.demand = clamp(schoolGood.demand + 1, 0, 200);
          schoolGood.supply = clamp(schoolGood.supply - 1, 0, 200);
          // Качество растёт при высокой посещаемости
          schoolGood.quality = Math.min(100, schoolGood.quality + 0.05);
          dbgSuccessful++;
        } else {
          // No school available — self-study at home (intelligence still helps)
          const intelFactorSelf = 0.5 + (agent.intelligence ?? 50) / 100;
          agent.needs.education = clamp(agent.needs.education + rand(8, 15) * intelFactorSelf);
          agent.currentAction = "study";
        }
      } else if (criticalNeed === "entertainment") {
        // Parks are publicly funded — free for agents. Budget paid via daily flat subsidy (see isNewDay block).
        const parkGood = this.pickGoodByPreference("park", agent.personality, agent.socialization, Infinity);
        if (parkGood) {
          // Agent uses park for free
          agent.needs.entertainment = clamp(agent.needs.entertainment + rand(25, 45));
          agent.needs.comfort = clamp(agent.needs.comfort + rand(5, 12));
          agent.mood = clamp(agent.mood + rand(1, 4));
          agent.currentAction = "relax";
          parkGood.demand = clamp(parkGood.demand + 1, 0, 200);
          parkGood.supply = clamp(parkGood.supply - 1, 0, 200);
          // Качество растёт при высокой посещаемости
          parkGood.quality = Math.min(100, parkGood.quality + 0.05);
          dbgSuccessful++;
        } else {
          // No park available — leisure at home
          agent.needs.entertainment = clamp(agent.needs.entertainment + rand(10, 18));
          agent.currentAction = "relax";
        }
      } else if (criticalNeed === "faith") {
        const templeGood = this.pickAvailableGood("temple");
        if (templeGood && agent.money >= templeGood.currentPrice) {
          agent.money -= templeGood.currentPrice;
          agent.needs.faith = clamp(agent.needs.faith + rand(25, 50));
          agent.needs.social = clamp(agent.needs.social + rand(5, 12));
          agent.mood = clamp(agent.mood + rand(0.5, 2));
          agent.currentAction = "pray";
          templeGood.demand = clamp(templeGood.demand + 1, 0, 200);
          templeGood.supply = clamp(templeGood.supply - 1, 0, 200);
          // Накопление качества
          templeGood.quality = Math.min(100, templeGood.quality + templeGood.currentPrice / 1000);
          const biz = templeGood.businessId ? this.businesses.get(templeGood.businessId) : null;
          if (biz) biz.balance += templeGood.currentPrice;
          // Храмы получают государственную субсидию через ежедневный платёж (см. isNewDay блок).
          gdp += templeGood.currentPrice;
          dbgMoneyOut += templeGood.currentPrice;
          dbgSuccessful++;
        } else {
          // Pray at home for free
          agent.needs.faith = clamp(agent.needs.faith + rand(12, 22));
          agent.currentAction = "pray";
        }
      } else if (criticalNeed === "financialSafety") {
        // Financial crisis: prioritise earning money (salary paid daily, not per-tick)
        if (agent.employerId) {
          agent.currentAction = "work";
          agent.needs.financialSafety = clamp(agent.needs.financialSafety + rand(3, 7));
        } else {
          // Unemployed: urgently seek a job. Raw producers (farm/workshop) are
          // included even when negative — they earn B2B revenue with employees.
          const availBiz = Array.from(this.businesses.values()).filter(b =>
            b.employeeCount < b.maxEmployees &&
            (b.balance > -200 || b.type === "farm" || b.type === "workshop")
          );
          if (availBiz.length > 0) {
            const newBiz = pick(availBiz);
            agent.employerId = newBiz.id;
            agent.jobStartTick = this.state.tick;
            newBiz.employeeCount++;
            agent.jobHistory = [...agent.jobHistory, { tick: this.state.tick, event: "hired", businessId: newBiz.id, businessName: newBiz.name }];
            agent.currentAction = "work";
            agent.needs.financialSafety = clamp(agent.needs.financialSafety + rand(5, 10));
          } else {
            agent.currentAction = "idle";
          }
        }
      } else if (criticalNeed === "housingSafety") {
        // Housing crisis: urgently get a job (salary paid daily, not per-tick)
        if (agent.employerId) {
          agent.currentAction = "work";
          agent.needs.housingSafety = clamp(agent.needs.housingSafety + rand(3, 8));
        } else {
          // No housing: desperately seek employment (farms/workshops included even if negative)
          const availBiz = Array.from(this.businesses.values()).filter(b =>
            b.employeeCount < b.maxEmployees &&
            (b.balance > -200 || b.type === "farm" || b.type === "workshop")
          );
          if (availBiz.length > 0) {
            const newBiz = pick(availBiz);
            agent.employerId = newBiz.id;
            agent.jobStartTick = this.state.tick;
            newBiz.employeeCount++;
            agent.jobHistory = [...agent.jobHistory, { tick: this.state.tick, event: "hired", businessId: newBiz.id, businessName: newBiz.name }];
            agent.currentAction = "work";
            agent.needs.housingSafety = clamp(agent.needs.housingSafety + rand(5, 10));
          } else {
            agent.currentAction = "idle";
          }
        }
      } else if (criticalNeed === "physicalSafety") {
        // Обращение в полицию: agent reports the robbery (spec: "Обратиться в полицию")
        agent.currentAction = "call_police";
        // Reporting to police gradually restores a sense of safety
        agent.needs.physicalSafety = clamp(agent.needs.physicalSafety + rand(12, 22));
        agent.mood = clamp(agent.mood + rand(3, 7));
      } else if (criticalNeed === "wellbeing") {
        // Желаемый уровень жизни не достигнут — агент пытается сменить работу на лучшую
        const targetGradeVal = targetGrade(agent.ambition);
        if (agent.employerId) {
          // Ищем вакансию с более высокой карьерной ступенью (или просто другую с достаточным балансом)
          const higherBiz = Array.from(this.businesses.values()).filter(
            b => b.id !== agent.employerId && b.balance > 0 && b.employeeCount < b.maxEmployees
          );
          if (higherBiz.length > 0 && agent.careerLevel < targetGradeVal) {
            // Уволиться из текущего места
            const oldBiz = this.businesses.get(agent.employerId);
            if (oldBiz) {
              oldBiz.employeeCount = Math.max(0, oldBiz.employeeCount - 1);
              agent.jobHistory = [...agent.jobHistory, { tick: this.state.tick, event: "fired", businessId: oldBiz.id, businessName: oldBiz.name }];
            }
            // Нанимаемся на новое место
            const newBiz = pick(higherBiz);
            agent.employerId = newBiz.id;
            agent.jobStartTick = this.state.tick;
            newBiz.employeeCount++;
            agent.jobHistory = [...agent.jobHistory, { tick: this.state.tick, event: "hired", businessId: newBiz.id, businessName: newBiz.name }];
            // Небольшой подъём wellbeing от смены работы (зарплата — раз в день)
            agent.needs.wellbeing = clamp(agent.needs.wellbeing + rand(5, 12));
            agent.currentAction = "work";
          } else {
            // Нет подходящих мест — работаем на текущем (зарплата — раз в день)
            agent.currentAction = "work";
          }
        } else {
          // Безработный — любая работа улучшит wellbeing (farms/workshops included even if negative)
          const availBiz = Array.from(this.businesses.values()).filter(b =>
            b.employeeCount < b.maxEmployees &&
            (b.balance > -200 || b.type === "farm" || b.type === "workshop")
          );
          if (availBiz.length > 0) {
            const newBiz = pick(availBiz);
            agent.employerId = newBiz.id;
            agent.jobStartTick = this.state.tick;
            newBiz.employeeCount++;
            agent.jobHistory = [...agent.jobHistory, { tick: this.state.tick, event: "hired", businessId: newBiz.id, businessName: newBiz.name }];
            agent.needs.wellbeing = clamp(agent.needs.wellbeing + rand(8, 15));
            agent.currentAction = "work";
          } else {
            agent.currentAction = "idle";
          }
        }
      } else if (criticalNeed === "socialRating") {
        // Рейтинг упал — агент активно социализируется, чтобы поднять оценку в глазах других
        const partnerId = this.pickSocialPartner(agentId, agentIds);
        if (partnerId) {
          const partner = this.agents.get(partnerId);
          if (partner) {
            // Инициатор заинтересован произвести впечатление → положительная дельта дружбы
            const friendDelta = rand(3, 8);
            this.updateRelation(agentId, partnerId, friendDelta);
            this.updateRelation(partnerId, agentId, friendDelta * 0.5);
            partner.needs.social = clamp(partner.needs.social + rand(5, 15));
            partner.mood = clamp(partner.mood + rand(1, 4));
          }
        }
        agent.needs.social = clamp(agent.needs.social + rand(15, 35));
        agent.mood = clamp(agent.mood + rand(2, 6));
        agent.currentAction = "socialize";
      } else {
        // Default action: work if employed, idle otherwise (salary paid once per day)
        agent.currentAction = agent.employerId ? "work" : "idle";
      }

      // Настроение конвергирует к "целевому" значению на основе взвешенного
      // среднего потребностей (2% в тик ≈ 1.5 игровых дня до равновесия).
      // Это предотвращает накопление настроения до 100 при удовлетворённых нуждах.
      const moodTarget = clamp(
        50 +
          (agent.needs.hunger - 50) * 0.14 +
          (agent.needs.comfort - 50) * 0.12 +
          (agent.needs.social - 50) * 0.09 +
          (agent.needs.health - 50) * 0.13 +
          (agent.needs.sleep - 50) * 0.12 +
          (agent.needs.education - 50) * 0.05 +
          (agent.needs.entertainment - 50) * 0.07 +
          (agent.needs.faith - 50) * 0.04 +
          (agent.needs.financialSafety - 50) * 0.09 +
          (agent.needs.housingSafety - 50) * 0.06 +
          (agent.needs.physicalSafety - 50) * 0.08 +
          (agent.needs.socialRating - 50) * 0.07 +
          (agent.needs.wellbeing - 50) * 0.06
      ); // коэффициенты сумма = 1.12 → небольшое масштабирование вверх при хороших нуждах
      agent.mood = clamp(agent.mood + (moodTarget - agent.mood) * 0.025);

      // Subsidy: once per game day only, capped at subsidyAmount per day
      if (isNewDay && agent.money <= 10 && runningBudget >= subsidyAmount) {
        agent.money += subsidyAmount;
        subsidiesPaid += subsidyAmount;
        runningBudget -= subsidyAmount;
        dbgSubsidyRecipients++;
      }

      // Count action for debug report
      const act = agent.currentAction;
      if (act === "work") dbgActWork++;
      else if (act === "eat") dbgActEat++;
      else if (act === "rest") dbgActRest++;
      else if (act === "socialize") dbgActSocialize++;
      else if (act === "sleep") dbgActSleep++;
      else if (act === "heal") dbgActHeal++;
      else if (act === "study") dbgActStudy++;
      else if (act === "relax") dbgActRelax++;
      else if (act === "pray") dbgActPray++;
      else dbgActIdle++;

      // Track recent actions (keep last 10)
      agent.recentActions.push(agent.currentAction);
      if (agent.recentActions.length > 10) agent.recentActions.shift();
    }

    // Budget floor: governmentBudget should never go below 0 after all per-tick agent payments
    this.state.governmentBudget = Math.max(0, runningBudget);
    runningBudget = this.state.governmentBudget; // sync so isNewDay block starts from clamped value
    this.state.totalTaxCollected += taxRevenue;
    this.state.totalSubsidiesPaid += subsidiesPaid;
    this.state.totalPensionPaid += pensionPaid;
    this.state.totalPublicServicesPaid += publicServiceSpend;

    // Process daily lifecycle: remove dead agents, spawn newborns
    if (isNewDay) {
      if (dailyDeaths.length > 0) {
        // Pre-compute dead IDs for heir filtering
        const deadSet = new Set(dailyDeaths);
        for (const deadId of dailyDeaths) {
          const deadAgent = this.agents.get(deadId);
          if (!deadAgent) continue;
          // Employer headcount
          if (deadAgent.employerId) {
            const biz = this.businesses.get(deadAgent.employerId);
            if (biz) biz.employeeCount = Math.max(0, biz.employeeCount - 1);
          }

          // ── Наследование ────────────────────────────────────────────────────
          // Деньги умершего агента НЕ уничтожаются, а возвращаются в экономику:
          // 50% → государственный бюджет (налог на наследство),
          // 50% → случайный трудоспособный агент (семья / наследник).
          // Это предотвращает дефляцию денежной массы при высокой смертности.
          if (deadAgent.money > 0) {
            const estate = deadAgent.money;
            const govShare = Math.round(estate * 0.5);
            const heirShare = estate - govShare;
            this.state.governmentBudget += govShare;
            runningBudget = this.state.governmentBudget;
            inheritanceRecycled += estate;

            // Найти наследника: живой, трудоспособный, не умирает в этот же тик
            const heirPool = Array.from(this.agents.values()).filter(
              a => !deadSet.has(a.id) && !a.isRetired && a.age >= 18 && a.age <= 65
            );
            if (heirPool.length > 0) {
              heirPool[Math.floor(Math.random() * heirPool.length)].money += heirShare;
            } else {
              // Наследников нет — всё в бюджет
              this.state.governmentBudget += heirShare;
              runningBudget = this.state.governmentBudget;
            }
          }

          // Remove from memory
          this.agents.delete(deadId);
          this.relations.delete(deadId);
          for (const relMap of this.relations.values()) relMap.delete(deadId);
          this.dirtyRelations.delete(`${deadId}:`);
        }
        this.lastDeaths = dailyDeaths.length;
        await this.purgeDeadAgents(dailyDeaths);
        logger.info({ count: dailyDeaths.length, population: this.agents.size }, "Agents died");
      } else if (isNewDay) {
        this.lastDeaths = 0;
      }

      if (plannedBirths > 0) {
        this.lastBirths = plannedBirths;
        await this.spawnNewAgents(plannedBirths);
        logger.info({ count: plannedBirths, population: this.agents.size }, "New agents born");
      } else if (isNewDay) {
        this.lastBirths = 0;
      }

      // ── Эмиграция: агенты покидают город при неудовлетворённых нуждах ──
      // Проверяется после удаления умерших (те уже вычищены из this.agents).
      // Два уровня ухода:
      //   • критические нужды (голод < 25 или здоровье < 25): сильный стимул — 4%/день
      //   • высшие нужды (финансы < 30 или комфорт < 30): слабый стимул — 1%/день
      // При глубоком кризисе (wellbeing < 0.35) шанс умножается до 2.4×.
      // Уехавшие агенты забирают деньги с собой (деньги покидают экономику).
      if (isNewDay) {
        const emigrantIds: number[] = [];
        for (const [aId, a] of this.agents) {
          const criticalNeeds = a.needs.hunger < 25 || a.needs.health < 25;
          const higherNeeds   = !criticalNeeds && (
            a.needs.financialSafety < 30 || a.needs.comfort < 30 || a.needs.social < 25
          );
          let emigChance = criticalNeeds ? 0.04 : higherNeeds ? 0.01 : 0;
          if (emigChance > 0 && wellbeingScore < 0.35) {
            emigChance *= 1 + (0.35 - wellbeingScore) * 4; // до 2.4× при кризисе
          }
          if (emigChance > 0 && Math.random() < emigChance) {
            emigrantIds.push(aId);
          }
        }
        if (emigrantIds.length > 0) {
          for (const eId of emigrantIds) {
            const ea = this.agents.get(eId);
            if (!ea) continue;
            if (ea.employerId) {
              const biz = this.businesses.get(ea.employerId);
              if (biz) biz.employeeCount = Math.max(0, biz.employeeCount - 1);
            }
            this.agents.delete(eId);
            this.relations.delete(eId);
            for (const relMap of this.relations.values()) relMap.delete(eId);
          }
          this.lastEmigrants = emigrantIds.length;
          await this.purgeDeadAgents(emigrantIds);
          logger.info({ count: emigrantIds.length, population: this.agents.size, wellbeingScore: Math.round(wellbeingScore * 100) / 100 }, "Agents emigrated");
        } else {
          this.lastEmigrants = 0;
        }
      }

      // ── Иммиграция: приток людей при благоприятных условиях ─────────────
      // Иммигранты — взрослые 20-45 лет с некоторыми сбережениями.
      // Они ищут работу сами (employerId = null при прибытии).
      // Деньги иммигрантов — новые деньги из «других городов» (вливание в экономику).
      if (plannedImmigrants > 0) {
        this.lastImmigrants = plannedImmigrants;
        await this.spawnImmigrants(plannedImmigrants);
        logger.info({ count: plannedImmigrants, population: this.agents.size, wellbeingScore: Math.round(wellbeingScore * 100) / 100 }, "Agents immigrated");
      } else if (isNewDay) {
        this.lastImmigrants = 0;
      }
    }

    // ── Случайные мировые события ────────────────────────────────────────────
    // Раз в ~6.7 дней происходит случайное событие (15% шанс/день).
    // Одновременно активно не более одного долгосрочного события.
    if (isNewDay) {
      // Удалить истекшие и одноразовые события из active-списка
      this.activeEvents = this.activeEvents.filter(e => e.endDay !== -1 && e.endDay >= this.state.gameDay);

      const hasActiveLong = this.activeEvents.some(e => e.endDay >= this.state.gameDay);
      const cooldown = this.state.gameDay - this.lastEventDay;
      if (!hasActiveLong && cooldown >= 3 && Math.random() < 0.17) {
        const totalWeight = WORLD_EVENT_CATALOG.reduce((s, e) => s + e.weight, 0);
        let pick2 = Math.random() * totalWeight;
        let chosen: typeof WORLD_EVENT_CATALOG[0] | undefined;
        for (const ev of WORLD_EVENT_CATALOG) {
          pick2 -= ev.weight;
          if (pick2 <= 0) { chosen = ev; break; }
        }
        if (!chosen) chosen = WORLD_EVENT_CATALOG[0];

        // Не повторять тип последнего события
        const lastType = this.eventLog.find(e => e.type !== "auto")?.type;
        if (chosen.type === lastType) {
          const idx = WORLD_EVENT_CATALOG.findIndex(e => e.type === chosen!.type);
          chosen = WORLD_EVENT_CATALOG[(idx + 1) % WORLD_EVENT_CATALOG.length];
        }

        const startDay = this.state.gameDay;
        const endDay = chosen.duration === -1 ? -1 : startDay + chosen.duration - 1;
        const newEvent: WorldEvent = {
          id: `${chosen.type}-${startDay}`,
          type: chosen.type,
          name: chosen.name,
          description: chosen.description,
          icon: chosen.icon,
          startDay,
          endDay,
          severity: chosen.severity,
        };
        if (chosen.duration !== -1) {
          this.activeEvents.push(newEvent);
        }
        this.addEventLogEntry({
          type: chosen.type,
          name: chosen.name,
          description: chosen.description,
          icon: chosen.icon,
          severity: chosen.severity,
        });
        this.lastEventDay = startDay;

        // Мгновенные эффекты
        if (chosen.type === "wealthy_migration") {
          await this.spawnWealthyMigrants(100);
          const logEntry = this.eventLog[0];
          if (logEntry) logEntry.description = `100 зажиточных жителей переехали в город с крупными накоплениями (~${Math.round(this.config.baseSalary * 100)} монет каждый).`;
        } else if (chosen.type === "government_subsidy") {
          const grant = Math.round(this.agents.size * 20); // 20 монет на жителя
          this.state.governmentBudget += grant;
          runningBudget = this.state.governmentBudget;
          const logEntry = this.eventLog[0];
          if (logEntry) logEntry.description = `Регион выделил городу ${grant.toLocaleString()} монет на развитие инфраструктуры.`;
        }

        logger.info({ event: newEvent, day: startDay }, "World event triggered");
      }

      // Авто-события: заметные метрики дня
      if (this.lastEmigrants > 80) {
        this.addEventLogEntry({
          type: "auto",
          name: "Волна эмиграции",
          description: `${this.lastEmigrants} жителей покинули город из-за низкого качества жизни.`,
          icon: "🚪",
          severity: "negative",
        });
      }
      if (this.lastDeaths > 60) {
        this.addEventLogEntry({
          type: "auto",
          name: "Высокая смертность",
          description: `${this.lastDeaths} жителей умерли за день — критическое состояние здоровья.`,
          icon: "💀",
          severity: "negative",
        });
      }
      if (this.lastImmigrants > 30) {
        this.addEventLogEntry({
          type: "auto",
          name: "Приток мигрантов",
          description: `${this.lastImmigrants} новых жителей прибыли в город.`,
          icon: "🏘️",
          severity: "positive",
        });
      }
      if (this.lastBirths > 20) {
        this.addEventLogEntry({
          type: "auto",
          name: "Бэби-бум",
          description: `${this.lastBirths} детей родились сегодня — высокий уровень благополучия.`,
          icon: "👶",
          severity: "positive",
        });
      }
    }

    const prevGoodPrices = new Map(Array.from(this.goods.entries()).map(([id, g]) => [id, g.currentPrice]));
    const chainResult = this.processProductionChains();
    this.updateGoodPrices();
    await this.updateBusinesses();

    // Corporate tax: once per game day, 5% of profitable business balance.
    // Raw producers (farms, workshops) are exempt — they are supply-chain
    // infrastructure and their economics depend on B2B revenue, not profit margins.
    if (isNewDay) {
      let corpTax = 0;
      for (const biz of this.businesses.values()) {
        if (biz.type === "farm" || biz.type === "workshop") continue;
        if (biz.balance > 500) {
          const tax = biz.balance * 0.05;
          biz.balance -= tax;
          corpTax += tax;
        }
      }
      runningBudget += corpTax;
      taxRevenue += corpTax;
      this.state.totalTaxCollected += corpTax;

      // ── Экономический подъём: ежедневный бонус к балансу потребительских бизнесов
      if (this.isEconomicBoomActive()) {
        for (const biz of this.businesses.values()) {
          if (biz.type !== "food" && biz.type !== "service") continue;
          const boom = Math.max(biz.balance * 0.12, 200);
          biz.balance += boom;
        }
      }

      // ── Производительность труда: создание добавленной стоимости ─────────
      // Каждый занятый рабочий в частном секторе генерирует небольшое количество
      // новых денег — это моделирует добавленную стоимость, не охваченную
      // простыми товарными транзакциями (знания, инфраструктура, опыт).
      // Ставка 4% от базовой зарплаты ≈ 2.44/работник/день компенсирует
      // уничтожение денег при смертях агентов (~2 200/день при 100 смертях).
      {
        const PROD_RATE = baseSalary * 0.04;
        let productivityCreated = 0;
        for (const biz of this.businesses.values()) {
          if (PUBLIC_SECTOR_TYPES.has(biz.type)) continue; // госсектор уже дотируется
          if (biz.employeeCount <= 0) continue;
          const gain = biz.employeeCount * PROD_RATE;
          biz.balance += gain;
          productivityCreated += gain;
        }
        if (productivityCreated > 0) {
          logger.debug({ productivityCreated: Math.round(productivityCreated) }, "Labor productivity value created");
        }
      }

      // ── Центробанк: антидефляционная инъекция ────────────────────────────
      // Если среднее богатство агентов падает ниже критического порога,
      // правительство получает экстренное финансирование (эмиссия последней инстанции).
      // Порог низкий — механизм срабатывает только при реальном кризисе ликвидности,
      // а не при обычных экономических колебаниях.
      {
        const allAgentArr = Array.from(this.agents.values());
        const DEFLATION_THRESHOLD = 10; // среднее богатство ниже этого → кризис
        if (allAgentArr.length > 0) {
          const avgWealth = allAgentArr.reduce((s, a) => s + a.money, 0) / allAgentArr.length;
          if (avgWealth < DEFLATION_THRESHOLD) {
            const injection = Math.min(
              12_000, // не более 12 000 в день во избежание гиперинфляции
              Math.round(allAgentArr.length * (DEFLATION_THRESHOLD - avgWealth) * 0.5)
            );
            this.state.governmentBudget += injection;
            runningBudget = this.state.governmentBudget;
            logger.info(
              { injection, avgWealth: Math.round(avgWealth * 10) / 10 },
              "Central bank emergency monetary injection"
            );
          }
        }
      }

      // ── Daily public service funding: actual payroll + 10% infrastructure ──
      // Government covers 100% of actual employee salaries (based on real grades)
      // plus 10% overhead for building maintenance and operations.
      // Formula: subsidy = sum(salary_of_each_employee) × 1.10
      // Empty buildings receive a small maintenance floor (baseSalary × 0.5/day)
      // so they can stay operational while hiring proceeds.

      // Step 1: compute actual daily payroll per public-sector business
      const publicPayrollMap = new Map<number, number>();
      for (const a of this.agents.values()) {
        if (a.isRetired || a.employerId == null) continue;
        const pb = this.businesses.get(a.employerId);
        if (!pb || !PUBLIC_SECTOR_TYPES.has(pb.type)) continue;
        publicPayrollMap.set(pb.id, (publicPayrollMap.get(pb.id) ?? 0) + calcSalary(baseSalary, a.careerLevel));
      }

      // Step 2: fund each public business
      const INFRA_OVERHEAD = 0.10; // 10% on top of payroll for infrastructure
      let dailyPublicSubsidy = 0;
      for (const biz of this.businesses.values()) {
        if (!PUBLIC_SECTOR_TYPES.has(biz.type)) continue;
        const payroll = publicPayrollMap.get(biz.id) ?? 0;
        // Staffed: cover wages + 10% infra. Empty: minimal maintenance floor.
        const subsidy = payroll > 0
          ? Math.round(payroll * (1 + INFRA_OVERHEAD))
          : Math.round(baseSalary * 0.5);
        if (runningBudget >= subsidy) {
          biz.balance += subsidy;
          runningBudget -= subsidy;
          dailyPublicSubsidy += subsidy;
        } else if (runningBudget > 0) {
          biz.balance += runningBudget;
          dailyPublicSubsidy += runningBudget;
          runningBudget = 0;
        }
      }
      this.state.totalPublicServicesPaid += dailyPublicSubsidy;
      this.state.governmentBudget = runningBudget;

      // ── Daily raw-producer support: farms and workshops deeply in the red
      // receive a modest government grant.  Capped to 1000 coins total per
      // day to protect the government budget from over-drain.
      const RAW_SUPPORT_FLOOR  = -500;   // only trigger below this balance
      const RAW_SUPPORT_AMOUNT = 150;    // per-business top-up per game day
      const RAW_SUPPORT_CAP    = 1000;   // total budget cap per game day
      let rawSupportSpent = 0;
      for (const biz of this.businesses.values()) {
        if (rawSupportSpent >= RAW_SUPPORT_CAP) break;
        if (biz.type !== "farm" && biz.type !== "workshop") continue;
        if (biz.balance > RAW_SUPPORT_FLOOR) continue;
        if (runningBudget < RAW_SUPPORT_AMOUNT) break;
        biz.balance += RAW_SUPPORT_AMOUNT;
        runningBudget -= RAW_SUPPORT_AMOUNT;
        rawSupportSpent += RAW_SUPPORT_AMOUNT;
        this.state.totalSubsidiesPaid += RAW_SUPPORT_AMOUNT;
      }
      this.state.governmentBudget = runningBudget;

      // ── One-time survival bailouts for distressed commercial businesses ───────
      // Each eligible business receives this exactly once; amount is modest
      const bailoutResult = this.processBusinessBailouts();
      if (bailoutResult.bailoutsIssued > 0) {
        this.state.totalSubsidiesPaid += bailoutResult.totalSpent;
      }
      runningBudget = this.state.governmentBudget; // sync after bailouts deducted

      // ── Business openings: self-funded + government grants ────────────────
      // Self-funded: ambitious agents with savings open on their own initiative.
      // Gov-funded:  unemployed agents apply; government approves based on
      //              resident needs (hunger/comfort) + market gap + budget.
      const openingResult = await this.processBusinessOpenings();
      this.totalGrantsPaid  += openingResult.totalSpent;
      this.lastGrantsIssued  = openingResult.govFunded + openingResult.selfFunded;
      runningBudget = this.state.governmentBudget; // sync after grants deducted
    }

    const elapsed = Date.now() - startTime;
    logger.debug({ tick: this.state.tick, elapsed, agentCount: this.agents.size }, "Tick complete");

    // Compute tick debug report
    {
      const goodsArr = Array.from(this.goods.values());
      const totalDemand = goodsArr.reduce((s, g) => s + g.demand, 0);
      const totalSupply = goodsArr.reduce((s, g) => s + g.supply, 0);
      const avgPrice = goodsArr.length > 0 ? goodsArr.reduce((s, g) => s + g.currentPrice, 0) / goodsArr.length : 0;
      const priceChangePct = this.prevAvgPrice > 0 ? ((avgPrice - this.prevAvgPrice) / this.prevAvgPrice) * 100 : 0;
      const bigPriceSpikes = goodsArr.filter(g => {
        const prev = prevGoodPrices.get(g.id) ?? 0;
        return prev > 0 && Math.abs(g.currentPrice - prev) / prev > 0.2;
      }).length;
      this.prevAvgPrice = avgPrice;

      const bizArr = Array.from(this.businesses.values());
      const bizBalanceAfter = bizArr.reduce((s, b) => s + b.balance, 0);
      const totalHired = bizArr.reduce((s, b) => s + b.hiredThisTick, 0);
      const totalFired = bizArr.reduce((s, b) => s + b.firedThisTick, 0);
      const totalEmployed = bizArr.reduce((s, b) => s + b.employeeCount, 0);

      const agentsArr = Array.from(this.agents.values());
      const negativeMoneyAgents = agentsArr.filter(a => a.money < 0).length;
      const nanValues = agentsArr.filter(a => !isFinite(a.money) || !isFinite(a.mood)).length;
      const totalMoneyAgents = agentsArr.reduce((s, a) => s + a.money, 0);
      const totalMoneyBusinesses = bizArr.reduce((s, b) => s + b.balance, 0);
      const orphanedGoods = goodsArr.filter(g => g.businessId != null && !this.businesses.has(g.businessId)).length;

      this.lastTickReport = {
        tick: this.state.tick,
        elapsedMs: elapsed,
        computedAt: Date.now(),
        agents: {
          processed: agentIds.length - dbgSkipped,
          skipped: dbgSkipped,
          actions: { work: dbgActWork, eat: dbgActEat, rest: dbgActRest, sleep: dbgActSleep, heal: dbgActHeal, socialize: dbgActSocialize, idle: dbgActIdle, study: dbgActStudy, relax: dbgActRelax, pray: dbgActPray },
          moneyIn: Math.round(dbgMoneyIn),
          moneyOut: Math.round(dbgMoneyOut),
        },
        businesses: {
          total: bizArr.length,
          active: bizArr.filter(b => b.balance > 0).length,
          unprofitable: bizArr.filter(b => b.balance < 0).length,
          staffless: bizArr.filter(b => b.employeeCount === 0).length,
          employed: totalEmployed,
          hired: totalHired,
          fired: totalFired,
          balanceBefore: Math.round(dbgBizBalanceBefore),
          balanceAfter: Math.round(bizBalanceAfter),
          wagesPaid: Math.round(dbgWagesPaid),
        },
        government: {
          budgetBefore: Math.round(dbgBudgetBefore),
          budgetAfter: Math.round(this.state.governmentBudget),
          taxRevenue: Math.round(taxRevenue),
          pensionsPaid: Math.round(pensionPaid),
          subsidiesPaid: Math.round(subsidiesPaid),
          publicServiceSpend: Math.round(publicServiceSpend),
          pensionRecipients: dbgPensionRecipients,
          subsidyRecipients: dbgSubsidyRecipients,
          inheritanceRecycled: Math.round(inheritanceRecycled),
        },
        market: {
          totalDemand: Math.round(totalDemand),
          totalSupply: Math.round(totalSupply),
          avgPrice: Math.round(avgPrice * 10) / 10,
          priceChangePct: Math.round(priceChangePct * 10) / 10,
          bigPriceSpikes,
          successfulPurchases: dbgSuccessful,
          failedNoGoods: dbgFailedNoGoods,
          failedNoMoney: dbgFailedNoMoney,
        },
        integrity: {
          negativeMoneyAgents,
          nanValues,
          totalMoneyAgents: Math.round(totalMoneyAgents),
          totalMoneyBusinesses: Math.round(totalMoneyBusinesses),
          governmentBudget: Math.round(this.state.governmentBudget),
          orphanedGoods,
        },
        chain: {
          b2bSuccess: chainResult.b2bSuccess,
          b2bFail: chainResult.b2bFail,
          farmSupplyTotal: Math.round(goodsArr.filter(g => {
            const biz = g.businessId != null ? this.businesses.get(g.businessId) : null;
            return biz?.type === "farm";
          }).reduce((s, g) => s + g.supply, 0)),
          workshopSupplyTotal: Math.round(goodsArr.filter(g => {
            const biz = g.businessId != null ? this.businesses.get(g.businessId) : null;
            return biz?.type === "workshop";
          }).reduce((s, g) => s + g.supply, 0)),
          foodSupplyTotal: Math.round(goodsArr.filter(g => {
            const biz = g.businessId != null ? this.businesses.get(g.businessId) : null;
            return biz?.type === "food";
          }).reduce((s, g) => s + g.supply, 0)),
          serviceSupplyTotal: Math.round(goodsArr.filter(g => {
            const biz = g.businessId != null ? this.businesses.get(g.businessId) : null;
            return biz?.type === "service";
          }).reduce((s, g) => s + g.supply, 0)),
        },
      };
    }

    this.syncCounter++;
    this.applyGoalEvaluation(gdp);
    if (this.syncCounter >= 1) {
      this.syncCounter = 0;
      const dbStart = Date.now();
      await this.syncToDB(gdp);
      const dbMs = Date.now() - dbStart;
      if (dbMs > 500) {
        logger.warn({ tick: this.state.tick, dbMs, agentCount: this.agents.size }, "syncToDB slow");
      } else {
        logger.debug({ tick: this.state.tick, dbMs }, "syncToDB done");
      }
    }
  }

  private async purgeDeadAgents(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await db.delete(agentStatHistoryTable).where(inArray(agentStatHistoryTable.agentId, ids));
    await db.delete(needsTable).where(inArray(needsTable.agentId, ids));
    await db.delete(relationsTable).where(
      or(inArray(relationsTable.agentIdA, ids), inArray(relationsTable.agentIdB, ids))
    );
    await db.delete(agentsTable).where(inArray(agentsTable.id, ids));
    // Clean up persisted relation keys
    for (const id of ids) {
      for (const key of Array.from(this.persistedRelations)) {
        if (key.startsWith(`${id}:`) || key.endsWith(`:${id}`)) {
          this.persistedRelations.delete(key);
        }
      }
    }
  }

  private async spawnNewAgents(count: number): Promise<void> {
    if (count <= 0) return;
    const availableBusinessIds = Array.from(this.businesses.values())
      .filter(b => b.balance > -200 && b.type !== "farm" && b.type !== "workshop")
      .map(b => b.id);

    const newAgentData = [];
    for (let i = 0; i < count; i++) {
      const gender = Math.random() < 0.5 ? "male" : "female";
      const name = gender === "male" ? pick(MALE_NAMES) : pick(FEMALE_NAMES);
      const employerId = availableBusinessIds.length > 0 && Math.random() < 0.5
        ? pick(availableBusinessIds) : null;
      newAgentData.push({
        name, gender,
        age: randInt(18, 25),
        mood: rand(50, 80),
        money: rand(20, 100),
        personality: pick(PERSONALITIES),
        socialization: rand(30, 70),
        currentAction: "idle" as const,
        employerId,
        locationX: rand(0, 1000),
        locationY: rand(0, 1000),
        careerLevel: 1,
        ambition: randInt(20, 100),
        strength: rand(30, 90),
        intelligence: rand(30, 90),
      });
    }

    const saved = await db.insert(agentsTable).values(newAgentData).returning();
    if (saved.length === 0) return;

    const needsInserts = saved.map(a => ({
      agentId: a.id,
      hunger: rand(60, 90),
      comfort: rand(60, 90),
      social: rand(60, 90),
      health: rand(65, 90),
      sleep: rand(55, 90),
      education: rand(50, 80),
      entertainment: rand(50, 80),
      faith: rand(40, 70),
      housingSafety: rand(65, 95),
      financialSafety: rand(60, 90),
      physicalSafety: rand(70, 95),
      socialRating: 50,
    }));
    const savedNeeds = await db.insert(needsTable).values(needsInserts).returning();
    const needsMap = new Map<number, typeof savedNeeds[0]>();
    for (const n of savedNeeds) needsMap.set(n.agentId, n);

    for (const agent of saved) {
      const needs = needsMap.get(agent.id);
      if (!needs) continue;
      this.agents.set(agent.id, {
        ...agent,
        needs: { hunger: needs.hunger, comfort: needs.comfort, social: needs.social, health: needs.health ?? 80, sleep: needs.sleep ?? 80, education: needs.education ?? 70, entertainment: needs.entertainment ?? 70, faith: needs.faith ?? 60, housingSafety: needs.housingSafety ?? 80, financialSafety: needs.financialSafety ?? 80, physicalSafety: needs.physicalSafety ?? 80, socialRating: needs.socialRating ?? 50, wellbeing: needs.wellbeing ?? 70 },
        needsId: needs.id,
        recentActions: [],
        jobHistory: agent.employerId
          ? [{ tick: this.state.tick, event: "hired", businessId: agent.employerId, businessName: this.businesses.get(agent.employerId)?.name ?? null }]
          : [],
        jobStartTick: agent.employerId ? this.state.tick : null,
        jailedUntilTick: null,
      });
      if (agent.employerId) {
        const biz = this.businesses.get(agent.employerId);
        if (biz) biz.employeeCount++;
      }
    }
  }

  // ── Иммигранты: взрослые 20-45 лет, приезжают без работы, с накоплениями ─
  // Деньги иммигрантов — вливание из «другого города» (новые деньги в экономике).
  private async spawnImmigrants(count: number): Promise<void> {
    if (count <= 0) return;
    const newAgentData = [];
    for (let i = 0; i < count; i++) {
      const gender = Math.random() < 0.5 ? "male" : "female";
      const name = gender === "male" ? pick(MALE_NAMES) : pick(FEMALE_NAMES);
      newAgentData.push({
        name, gender,
        age: randInt(20, 45),
        mood: rand(40, 70),       // тревожные, но с надеждой
        money: rand(30, 150),     // накопления на переезд
        personality: pick(PERSONALITIES),
        socialization: rand(20, 60),
        currentAction: "idle" as const,
        employerId: null,         // ищут работу с нуля
        locationX: rand(0, 1000),
        locationY: rand(0, 1000),
        careerLevel: 1,
        ambition: randInt(40, 100), // мотивация выше среднего — едут за лучшей жизнью
        strength: rand(30, 90),
        intelligence: rand(30, 90),
      });
    }
    const saved = await db.insert(agentsTable).values(newAgentData).returning();
    if (saved.length === 0) return;
    const needsInserts = saved.map(_a => ({
      agentId: _a.id,
      hunger: rand(50, 80),       // в дороге немного устали
      comfort: rand(40, 70),
      social: rand(30, 60),       // оторваны от прежних связей
      health: rand(60, 90),
      sleep: rand(50, 80),
      education: rand(50, 80),
      entertainment: rand(40, 70),
      faith: rand(40, 70),
      housingSafety: rand(40, 70), // пока без жилья
      financialSafety: rand(50, 80),
      physicalSafety: rand(60, 90),
      socialRating: 50,
    }));
    const savedNeeds = await db.insert(needsTable).values(needsInserts).returning();
    const needsMap = new Map<number, typeof savedNeeds[0]>();
    for (const n of savedNeeds) needsMap.set(n.agentId, n);
    for (const agent of saved) {
      const needs = needsMap.get(agent.id);
      if (!needs) continue;
      this.agents.set(agent.id, {
        ...agent,
        needs: { hunger: needs.hunger, comfort: needs.comfort, social: needs.social, health: needs.health ?? 75, sleep: needs.sleep ?? 70, education: needs.education ?? 70, entertainment: needs.entertainment ?? 60, faith: needs.faith ?? 60, housingSafety: needs.housingSafety ?? 60, financialSafety: needs.financialSafety ?? 70, physicalSafety: needs.physicalSafety ?? 75, socialRating: needs.socialRating ?? 50, wellbeing: needs.wellbeing ?? 65 },
        needsId: needs.id,
        recentActions: [],
        jobHistory: [],
        jobStartTick: null,
        jailedUntilTick: null,
      });
    }
  }

  // ── Богатые мигранты (событие wealthy_migration) ─────────────────────────
  // Взрослые специалисты 25-55 лет, богатые (~100×baseSalary), с высоким IQ
  private async spawnWealthyMigrants(count: number): Promise<void> {
    if (count <= 0) return;
    const baseSalary = this.config.baseSalary;
    const newAgentData = [];
    for (let i = 0; i < count; i++) {
      const gender = Math.random() < 0.5 ? "male" : "female";
      const name = gender === "male" ? pick(MALE_NAMES) : pick(FEMALE_NAMES);
      newAgentData.push({
        name, gender,
        age: randInt(25, 55),
        mood: rand(65, 90),
        money: Math.round(baseSalary * rand(80, 120)),
        personality: pick(PERSONALITIES),
        socialization: rand(50, 90),
        currentAction: "idle" as const,
        employerId: null,
        locationX: rand(0, 1000),
        locationY: rand(0, 1000),
        careerLevel: randInt(2, 6),
        ambition: randInt(50, 100),
        strength: rand(40, 90),
        intelligence: rand(60, 95),
      });
    }
    const saved = await db.insert(agentsTable).values(newAgentData).returning();
    if (saved.length === 0) return;
    const needsInserts = saved.map(_a => ({
      agentId: _a.id,
      hunger: rand(65, 90),
      comfort: rand(60, 85),
      social: rand(50, 80),
      health: rand(70, 95),
      sleep: rand(60, 85),
      education: rand(60, 90),
      entertainment: rand(55, 80),
      faith: rand(45, 75),
      housingSafety: rand(60, 85),
      financialSafety: rand(75, 95),
      physicalSafety: rand(70, 90),
      socialRating: 60,
    }));
    const savedNeeds = await db.insert(needsTable).values(needsInserts).returning();
    const needsMap = new Map<number, typeof savedNeeds[0]>();
    for (const n of savedNeeds) needsMap.set(n.agentId, n);
    for (const agent of saved) {
      const needs = needsMap.get(agent.id);
      if (!needs) continue;
      this.agents.set(agent.id, {
        ...agent,
        needs: { hunger: needs.hunger, comfort: needs.comfort, social: needs.social, health: needs.health ?? 80, sleep: needs.sleep ?? 75, education: needs.education ?? 75, entertainment: needs.entertainment ?? 65, faith: needs.faith ?? 60, housingSafety: needs.housingSafety ?? 70, financialSafety: needs.financialSafety ?? 80, physicalSafety: needs.physicalSafety ?? 80, socialRating: needs.socialRating ?? 60, wellbeing: needs.wellbeing ?? 70 },
        needsId: needs.id,
        recentActions: [],
        jobHistory: [],
        jobStartTick: null,
        jailedUntilTick: null,
      });
    }
    this.lastImmigrants += count; // считать как иммигранты
  }

  // ── Модификаторы активных событий ────────────────────────────────────────
  private getHarvestModifier(): number {
    const day = this.state.gameDay;
    if (this.activeEvents.some(e => e.type === "good_harvest" && (e.endDay === -1 || e.endDay >= day))) return 2.0;
    if (this.activeEvents.some(e => e.type === "bad_harvest"  && (e.endDay === -1 || e.endDay >= day))) return 0.35;
    return 1.0;
  }

  private getEpidemicModifier(): number {
    const day = this.state.gameDay;
    return this.activeEvents.some(e => e.type === "epidemic" && (e.endDay === -1 || e.endDay >= day)) ? 3.0 : 1.0;
  }

  private isEconomicBoomActive(): boolean {
    const day = this.state.gameDay;
    return this.activeEvents.some(e => e.type === "economic_boom" && (e.endDay === -1 || e.endDay >= day));
  }

  // ── Публичный метод для API ────────────────────────────────────────────────
  getEvents(): { active: WorldEvent[]; log: EventLogEntry[] } {
    const day = this.state.gameDay;
    const active = this.activeEvents.filter(e => e.endDay === -1 || e.endDay >= day);
    return { active, log: this.eventLog.slice(0, 20) };
  }

  // ── Вспомогательный метод добавления записи в лог ─────────────────────────
  private addEventLogEntry(entry: Omit<EventLogEntry, "id" | "day" | "tick">): void {
    const id = `${entry.type}-${this.state.gameDay}-${this.state.tick}`;
    this.eventLog.unshift({ id, day: this.state.gameDay, tick: this.state.tick, ...entry });
    if (this.eventLog.length > 30) this.eventLog.pop();
  }

  private getCriticalNeed(needs: { hunger: number; comfort: number; social: number; health: number; sleep: number; education: number; entertainment: number; faith: number; housingSafety: number; financialSafety: number; physicalSafety: number; socialRating: number; wellbeing: number }): string {
    // Priority 0: extreme exhaustion overrides everything — humans fall asleep standing up
    if (needs.sleep < 20) return "sleep";
    // Priority 1-4: critical physical needs
    if (needs.health < 45) return "health";            // only truly ill agents rush to hospital
    if (needs.sleep < 45) return "sleep";
    if (needs.hunger < 55) return "hunger";
    // Priority 5-7: safety needs (trigger before social/entertainment)
    if (needs.financialSafety < 30) return "financialSafety";
    if (needs.housingSafety < 25) return "housingSafety";
    if (needs.physicalSafety < 45) return "physicalSafety";
    // Priority 8+: secondary social/growth needs — individual thresholds per spec
    // socialRating: lower threshold (30) since it moves slowly (daily recalc)
    if (needs.socialRating < 30) return "socialRating";
    const secondary: Array<[string, number]> = [
      ["comfort",       needs.comfort],
      ["social",        needs.social],
      ["entertainment", needs.entertainment],
      ["education",     needs.education],
      ["faith",         needs.faith],
      ["wellbeing",     needs.wellbeing],
    ];
    const thresholds: Record<string, number> = {
      comfort: 35,
      social: 45,
      entertainment: 60, // raised: 50 → 60; parks used more often
      education: 45,     // raised: 30 → 45; schools used more often
      faith: 45,         // raised: 30 → 45; temples used more often
      wellbeing: 35,
    };
    const critical = secondary.filter(([name, v]) => v < (thresholds[name] ?? 30));
    if (critical.length > 0) {
      critical.sort((a, b) => a[1] - b[1]);
      return critical[0][0];
    }
    return "work";
  }

  private pickAvailableGood(type: "food" | "service" | "hospital" | "school" | "park" | "temple"): GoodState | null {
    const relevant = Array.from(this.goods.values()).filter(g => {
      const biz = g.businessId ? this.businesses.get(g.businessId) : null;
      return biz && biz.type === type && g.supply > 0;
    });
    if (relevant.length === 0) return null;
    return pick(relevant);
  }

  /**
   * Pick a good using the consumer preference matrix (spec v1.6).
   * Falls back to pickAvailableGood when no matrix entry exists for this type.
   *
   * Rules (from spec):
   *   85% probability → buy from preferred price/quality tier
   *   15% probability → buy from random available tier
   *   If preferred tier is unaffordable → buy cheapest affordable
   */
  private pickGoodByPreference(
    type: "food" | "service" | "park",
    personality: string,
    socialization: number,
    budget: number,
  ): GoodState | null {
    const peers = Array.from(this.goods.values()).filter(g => {
      const biz = g.businessId ? this.businesses.get(g.businessId) : null;
      return biz && biz.type === type && g.supply > 0;
    });
    if (peers.length === 0) return null;

    const matrixRow = CONSUMER_MATRIX[type];
    if (!matrixRow) return pick(peers.filter(g => g.currentPrice <= budget)) ?? pick(peers);

    const pIdx = getPersonalityIndex(personality, socialization);
    const [prefPrice, prefQuality] = matrixRow[pIdx];

    const preferred = peers.filter(g => {
      const [pl, ql] = classifyGood(g, peers);
      return pl === prefPrice && ql === prefQuality;
    });

    const affordablePreferred = preferred.filter(g => g.currentPrice <= budget);
    const affordableAll = peers.filter(g => g.currentPrice <= budget);

    if (affordablePreferred.length > 0 && Math.random() < 0.85) {
      return pick(affordablePreferred);
    }

    // 15% random tier or preferred unaffordable → random from affordable
    if (affordableAll.length > 0) {
      return pick(affordableAll);
    }

    // Can't afford anything → cheapest available regardless of budget
    return peers.sort((a, b) => a.currentPrice - b.currentPrice)[0] ?? null;
  }

  private pickSocialPartner(agentId: number, allIds: number[]): number | null {
    const candidates = allIds.filter(id => id !== agentId);
    if (candidates.length === 0) return null;
    return pick(candidates);
  }

  private updateRelation(agentIdA: number, agentIdB: number, delta: number): void {
    let relMap = this.relations.get(agentIdA);
    if (!relMap) {
      relMap = new Map();
      this.relations.set(agentIdA, relMap);
    }
    const current = relMap.get(agentIdB) ?? 50;
    const next = clamp(current + delta);
    relMap.set(agentIdB, next);
    this.dirtyRelations.add(`${agentIdA}:${agentIdB}`);
  }

  private processProductionChains(): { b2bSuccess: number; b2bFail: number } {
    let b2bSuccess = 0, b2bFail = 0;

    const farmGoods = Array.from(this.goods.values()).filter(g => {
      const biz = g.businessId != null ? this.businesses.get(g.businessId) : null;
      return biz?.type === "farm";
    });
    const workshopGoods = Array.from(this.goods.values()).filter(g => {
      const biz = g.businessId != null ? this.businesses.get(g.businessId) : null;
      return biz?.type === "workshop";
    });

    // Food businesses buy raw ingredients from farms ONLY when supply is low.
    // Farm is chosen RANDOMLY among available ones (supply > 10) to distribute
    // load evenly across all farms rather than always hammering the same one.
    for (const biz of this.businesses.values()) {
      if (biz.type !== "food") continue;
      const consumerGood = Array.from(this.goods.values()).find(g => g.businessId === biz.id) ?? null;

      // B2B procurement runs every tick — food businesses always buy raw ingredients
      // from farms (this represents a continuous supply chain, not a reorder trigger).
      // Food supply at the consumer-goods layer is managed separately by agent purchases
      // and per-tick production. Removing the supply threshold stops farms from being
      // starved of revenue when food biz supply is permanently maxed by production.
      const availFarms = farmGoods.filter(g => g.supply > 10);
      const farmGood = availFarms.length > 0 ? availFarms[Math.floor(Math.random() * availFarms.length)] : null;

      if (farmGood && biz.balance >= farmGood.currentPrice) {
        const cost = farmGood.currentPrice;
        biz.balance -= cost;
        const farmBiz = farmGood.businessId != null ? this.businesses.get(farmGood.businessId) : null;
        if (farmBiz) farmBiz.balance += cost;
        farmGood.supply = clamp(farmGood.supply - 1, 0, 200);
        farmGood.demand = clamp(farmGood.demand + 1, 0, 200);
        if (consumerGood) {
          consumerGood.quality = clamp(consumerGood.quality + 0.1, 0, 100);
        }
        b2bSuccess++;
      } else {
        if (consumerGood) {
          consumerGood.quality = clamp(consumerGood.quality - 0.2, 0, 100);
        }
        b2bFail++;
      }
    }

    // Service businesses buy raw materials from workshops ONLY when supply is low.
    // Workshop is chosen RANDOMLY to distribute load evenly.
    for (const biz of this.businesses.values()) {
      if (biz.type !== "service") continue;
      const consumerGood = Array.from(this.goods.values()).find(g => g.businessId === biz.id) ?? null;

      // B2B procurement runs every tick — service businesses always buy materials
      // from workshops as a continuous supply chain relationship.
      const availWs = workshopGoods.filter(g => g.supply > 10);
      const wsGood = availWs.length > 0 ? availWs[Math.floor(Math.random() * availWs.length)] : null;

      if (wsGood && biz.balance >= wsGood.currentPrice) {
        const cost = wsGood.currentPrice;
        biz.balance -= cost;
        const wsBiz = wsGood.businessId != null ? this.businesses.get(wsGood.businessId) : null;
        if (wsBiz) wsBiz.balance += cost;
        wsGood.supply = clamp(wsGood.supply - 1, 0, 200);
        wsGood.demand = clamp(wsGood.demand + 1, 0, 200);
        if (consumerGood) {
          consumerGood.quality = clamp(consumerGood.quality + 0.1, 0, 100);
        }
        b2bSuccess++;
      } else {
        if (consumerGood) {
          consumerGood.quality = clamp(consumerGood.quality - 0.1, 0, 100);
        }
        b2bFail++;
      }
    }

    return { b2bSuccess, b2bFail };
  }

  private updateGoodPrices(): void {
    const { priceMarkup } = this.config;

    for (const good of this.goods.values()) {
      const bizType = good.businessId != null ? this.businesses.get(good.businessId)?.type : undefined;
      const base = good.basePrice;

      // ── Equilibrium price (quality-adjusted base) ─────────────────────────
      // Quality premium: ±10% at quality 0/100; neutral at quality 50
      // Качество: ±30% к равновесной цене (quality=50 → ×1.0, 100 → ×1.3, 0 → ×0.7)
      const qualityPremium = (good.quality - 50) / 167;
      const equilibrium = base * (1 + priceMarkup) * (1 + qualityPremium);

      // ── Demand-supply pressure ────────────────────────────────────────────
      // ratio > 1 → demand exceeds supply → price rises
      // ratio < 1 → excess supply → price falls
      // elasticity: 2% of currentPrice per unit of excess ratio per tick
      const supply = Math.max(good.supply, 1);
      const ratio = good.demand / supply;
      const elasticity = 0.02;
      const pressureChange = (ratio - 1) * elasticity * good.currentPrice;

      // ── Mean reversion toward equilibrium ─────────────────────────────────
      // Prevents runaway inflation/deflation; 3% pull per tick
      const reversionRate = 0.03;
      const reversion = (equilibrium - good.currentPrice) * reversionRate;

      // ── Apply combined adjustment with hard floor/ceiling ─────────────────
      // Ceiling: scales with quality (high-quality goods can command higher prices)
      const qualityCeilingMult = 1 + (good.quality - 50) / 100; // quality=100 → ×1.5, quality=50 → ×1.0
      const baseCeiling = (bizType === "food" || bizType === "service" || bizType === "hospital") ? base * 2.5 : base * 3.0;
      const priceCeiling = baseCeiling * qualityCeilingMult;
      const newPrice = good.currentPrice + pressureChange + reversion;
      good.currentPrice = Math.max(base * 0.3, Math.min(priceCeiling, newPrice));

      // ── Supply/demand natural dynamics per business tier ──────────────────
      if (bizType === "farm" || bizType === "workshop") {
        // Raw/intermediate producers (B2B): supply is demand-driven.
        // Demand here comes from B2B purchases by food/service businesses.
        // When nobody is buying (demand≈0), excess stock should decay.
        // Employee headcount boosts production (more workers → more output).
        const rawBiz = good.businessId != null ? this.businesses.get(good.businessId) : null;
        // Each worker adds 1 unit of output per tick (farmers/factory workers)
        const empBoost = rawBiz?.employeeCount ?? 0;
        const rawRatio = good.supply / Math.max(good.demand, 1);
        if (rawRatio > 4 || (good.demand < 3 && good.supply > 20)) {
          // Severe overstock — nobody buying: heavy decay
          good.supply = clamp(good.supply - rand(6, 12), 0, 200);
        } else if (rawRatio > 2) {
          // Moderate surplus: small drain, employees partially offset it
          good.supply = clamp(good.supply - rand(1, 3) + Math.floor(empBoost * 0.3), 0, 200);
        } else {
          // Healthy B2B demand: produce normally, boosted by employees.
          // Higher base production so farms can sustain frequent B2B sales.
          // Урожай/неурожай модифицирует производство ферм
          const harvestMod = bizType === "farm" ? this.getHarvestModifier() : 1.0;
          const base = bizType === "farm" ? Math.round(rand(12, 20) * harvestMod) : rand(9, 16);
          good.supply = clamp(good.supply + base + empBoost, 0, 200);
        }
        // Demand only comes from actual B2B purchases; no artificial decay here
      } else if (bizType === "school" || bizType === "park" || bizType === "temple") {
        // Public services: infinite capacity (supply = 200 always available).
        // Demand ONLY rises when agents actually visit — no artificial decay.
        good.supply = 200; // always at capacity
        // demand decay removed — only real visits increment demand
      } else if (bizType === "hospital") {
        // Healthcare: always available, capacity-based supply.
        // Demand ONLY rises when sick agents visit — no artificial decay.
        good.supply = 200; // always at capacity
        // demand decay removed — only real sick-agent visits increment demand
      } else {
        // Consumer goods (food/service/retail): moderate replenishment
        // Productivity bonus: each invested level adds 0.1 × employeeCount extra supply
        const ownerBiz = good.businessId != null ? this.businesses.get(good.businessId) : null;
        const prodLevel = ownerBiz?.productivityLevel ?? 0;
        const empCount = ownerBiz?.employeeCount ?? 0;
        const prodBonus = Math.floor(prodLevel * 0.1 * empCount);

        // ── Supply decay for oversupplied goods ───────────────────────────
        // Ratio-based: when supply massively exceeds demand, goods spoil/go unsold.
        // This applies regardless of the absolute demand level.
        const supplyRatio = good.supply / Math.max(good.demand, 1);
        if (supplyRatio > 5 || (good.demand < 5 && good.supply > 30)) {
          // Severe oversupply: heavy spoilage
          good.supply = clamp(good.supply - rand(8, 16), 0, 200);
        } else if (supplyRatio > 2.5) {
          // Moderate oversupply: trim excess
          good.supply = clamp(good.supply - rand(3, 7), 0, 200);
        } else if (supplyRatio > 1.5) {
          // Slight oversupply: hold steady, minimal growth
          good.supply = clamp(good.supply - rand(0, 2), 0, 200);
        } else {
          // Healthy demand: allow production growth
          good.supply = clamp(good.supply + rand(1, 4) + prodBonus, 0, 200);
        }
        good.demand = clamp(good.demand - rand(1, 3), 0, 200);
      }
    }
  }

  private async updateBusinesses(): Promise<void> {
    // ── Bankruptcy thresholds ──────────────────────────────────────────────
    // Only commercial non-essential businesses can go bankrupt
    const BANKRUPT_TYPES = new Set(["food", "service"]);
    const BANKRUPT_TICKS = 40;          // must be unprofitable for this many consecutive ticks
    const BANKRUPT_SUPPLY_RATIO = 3.0;  // AND its good must be severely oversupplied (supply > demand×3)
    const BANKRUPT_BALANCE_CAP = -300;  // AND balance must be below this threshold

    const toClose: number[] = [];

    for (const biz of this.businesses.values()) {
      if (biz.balance < 0) {
        biz.ticksUnprofitable++;
      } else {
        biz.ticksUnprofitable = 0;
      }

      // Check bankruptcy conditions for commercial businesses only
      if (!BANKRUPT_TYPES.has(biz.type)) continue;
      if (biz.ticksUnprofitable < BANKRUPT_TICKS) continue;
      if (biz.balance > BANKRUPT_BALANCE_CAP) continue;

      // Check if this business's good is severely oversupplied (no real buyers for its stock)
      const bizGood = Array.from(this.goods.values()).find(g => g.businessId === biz.id);
      if (bizGood) {
        const ratio = bizGood.supply / Math.max(bizGood.demand, 1);
        if (ratio < BANKRUPT_SUPPLY_RATIO) continue; // demand still outpaces oversupply — keep open
      }

      toClose.push(biz.id);
    }

    // Close bankrupt businesses
    for (const bizId of toClose) {
      const biz = this.businesses.get(bizId);
      if (!biz) continue;

      logger.info({ bizId, bizName: biz.name, balance: Math.round(biz.balance), ticksUnprofitable: biz.ticksUnprofitable }, "Business going bankrupt — closing");

      // Fire all employees
      for (const agent of this.agents.values()) {
        if (agent.employerId === bizId) {
          agent.employerId = null;
          agent.jobHistory = [...agent.jobHistory, { tick: this.state.tick, event: "fired", businessId: bizId, businessName: biz.name }];
        }
      }

      // Remove goods owned by this business
      for (const [goodId, good] of this.goods.entries()) {
        if (good.businessId === bizId) {
          this.goods.delete(goodId);
          await db.delete(goodsTable).where(eq(goodsTable.id, goodId)).catch(() => {});
        }
      }

      // Remove business from map and DB
      this.businesses.delete(bizId);
      await db.delete(businessesTable).where(eq(businessesTable.id, bizId)).catch(() => {});
    }
  }

  /**
   * One-time government survival bailout for distressed commercial businesses.
   * Conditions: commercial (food/service), balance below DISTRESS threshold, never received before.
   * Amount is deliberately modest — enough to give a fighting chance, not a windfall.
   * Each business can receive this bailout exactly once per simulation run.
   */
  private processBusinessBailouts(): { bailoutsIssued: number; totalSpent: number } {
    const BAILOUT_TYPES    = new Set(["food", "service"]);
    const DISTRESS_BALANCE = -150;  // balance must be at or below this level to qualify
    const BAILOUT_AMOUNT   = 800;   // one-time payout — covers ~a few days of operating costs
    const MAX_PER_DAY      = 5;     // cap to prevent budget drain from simultaneous crises

    if (this.state.governmentBudget < BAILOUT_AMOUNT) {
      return { bailoutsIssued: 0, totalSpent: 0 };
    }

    let bailoutsIssued = 0;
    let totalSpent = 0;

    for (const biz of this.businesses.values()) {
      if (bailoutsIssued >= MAX_PER_DAY) break;
      if (!BAILOUT_TYPES.has(biz.type)) continue;
      if (biz.hasReceivedBailout) continue;
      if (biz.balance > DISTRESS_BALANCE) continue;
      if (this.state.governmentBudget < BAILOUT_AMOUNT) break;

      biz.balance += BAILOUT_AMOUNT;
      biz.hasReceivedBailout = true;
      this.state.governmentBudget -= BAILOUT_AMOUNT;
      bailoutsIssued++;
      totalSpent += BAILOUT_AMOUNT;

      logger.info(
        { bizId: biz.id, bizName: biz.name, balanceAfter: Math.round(biz.balance), bailoutAmount: BAILOUT_AMOUNT },
        "One-time government survival bailout issued"
      );
    }

    return { bailoutsIssued, totalSpent };
  }

  // ── Niche scoring ─────────────────────────────────────────────────────
  // Computes a composite "success probability" score for EVERY openable good niche:
  // farm (raw food), workshop (raw materials), food (processed), service.
  // Score = 60% market gap (demand/supply) + 40% resident need signal.
  // Higher score → more unmet demand → agent/government should open this type of business.
  private computeNicheScores(): Array<{
    name: string;
    bizType: "farm" | "workshop" | "food" | "service";
    basePrice: number;
    marketRatio: number;  // raw demand / supply
    needScore: number;    // 0–1: fraction of unmet resident need for this category
    successScore: number; // composite 0–1
  }> {
    // Map from good name → which business type produces it
    const GOOD_TYPE_MAP = new Map<string, "farm" | "workshop" | "food" | "service">([
      ...RAW_FOOD_GOOD_NAMES.map(n  => [n, "farm"]     as const),
      ...RAW_MATERIAL_GOOD_NAMES.map(n => [n, "workshop"] as const),
      ...FOOD_GOOD_NAMES.map(n      => [n, "food"]     as const),
      ...SERVICE_GOOD_NAMES.map(n   => [n, "service"]  as const),
    ]);

    // ── Step 1: aggregate demand/supply per good name ──────────────────
    const OPENABLE = new Set<string>(["farm", "workshop", "food", "service"]);
    const nicheDemand = new Map<string, { totalDemand: number; totalSupply: number; bizType: "farm" | "workshop" | "food" | "service"; basePrice: number }>();
    for (const good of this.goods.values()) {
      const biz = good.businessId != null ? this.businesses.get(good.businessId) : null;
      if (!biz || !OPENABLE.has(biz.type)) continue;
      const prev = nicheDemand.get(good.name);
      if (prev) {
        prev.totalDemand += good.demand;
        prev.totalSupply += good.supply;
      } else {
        const bizType = GOOD_TYPE_MAP.get(good.name) ?? (biz.type as "farm" | "workshop" | "food" | "service");
        nicheDemand.set(good.name, {
          totalDemand: good.demand, totalSupply: good.supply,
          bizType, basePrice: good.basePrice,
        });
      }
    }
    // Add completely unserved niches with latent demand
    for (const [gn, bt] of GOOD_TYPE_MAP.entries()) {
      if (!nicheDemand.has(gn)) {
        const isFarm = bt === "farm";
        const isWorkshop = bt === "workshop";
        nicheDemand.set(gn, {
          totalDemand: 50, totalSupply: 1, bizType: bt,
          basePrice: isFarm
            ? this.config.baseFoodPrice * 0.5
            : isWorkshop
              ? this.config.baseFoodPrice * 0.8
              : this.config.baseFoodPrice * (bt === "food" ? 1.0 : 1.5),
        });
      }
    }

    // ── Step 2: resident need scores ──────────────────────────────────
    // needScore reflects how much FINAL consumers need this type of good.
    // farms/workshops produce B2B raw materials — residents don't buy them directly,
    // so their need signal is 0 (raw good success = pure market ratio only).
    // food/service businesses sell directly to residents → resident needs apply.
    const activeAgents = Array.from(this.agents.values()).filter(a => !a.isRetired);
    const n = activeAgents.length || 1;
    const avgHunger  = activeAgents.reduce((s, a) => s + a.needs.hunger,  0) / n;
    const avgComfort = activeAgents.reduce((s, a) => s + a.needs.comfort, 0) / n;
    const foodNeedScore    = clamp(1 - avgHunger  / 100, 0, 1);
    const serviceNeedScore = clamp(1 - avgComfort / 100, 0, 1);

    // ── Step 3: composite success score ──────────────────────────────
    return Array.from(nicheDemand.entries())
      .map(([name, data]) => {
        const marketRatio = data.totalDemand / Math.max(data.totalSupply, 1);
        // Raw (B2B) goods: score = 100% market gap (no resident need signal)
        // Consumer goods: score = 60% market gap + 40% resident need
        let needScore: number;
        let successScore: number;
        if (data.bizType === "farm" || data.bizType === "workshop") {
          needScore = 0; // raw materials don't map to resident hunger/comfort directly
          successScore = Math.min(marketRatio / 3, 1); // pure market ratio, capped at 1
        } else {
          needScore = data.bizType === "food" ? foodNeedScore : serviceNeedScore;
          const normalised = Math.min(marketRatio / 3, 1);
          successScore = normalised * 0.6 + needScore * 0.4;
        }
        return { name, ...data, marketRatio, needScore, successScore };
      })
      .sort((a, b) => b.successScore - a.successScore);
  }

  /**
   * Business opening logic — two independent pathways:
   *
   * 1. Self-funded: agent with savings + ambition opens a business using their own money.
   *    Niche is selected by highest successScore (best market opportunity).
   *
   * 2. Government-funded: unemployed agent applies for a grant.
   *    Government approves only when successScore ≥ threshold AND budget allows.
   *    Approval criteria reflect BOTH market gap AND current resident needs —
   *    government will not fund a niche that residents don't actually need.
   */
  private async processBusinessOpenings(): Promise<{ selfFunded: number; govFunded: number; totalSpent: number }> {
    const MAX_SELF_FUNDED      = 3;    // cap per game day to avoid sudden market floods
    const MAX_GOV_FUNDED       = 3;    // up to 3 gov-funded businesses per day
    // Текущий уровень безработицы (доля работоспособного населения без работы)
    const { unemploymentRate } = this.getAggregateStats();
    // При высокой безработице снижаем порог входа — правительство больше рискует
    const GOV_THRESHOLD = unemploymentRate > 0.60 ? 0.25
                        : unemploymentRate > 0.40 ? 0.35
                        : 0.45;
    const SELF_AMBITION_MIN    = 55;   // agent must be ambitious enough to start a business
    const SELF_INTEL_MIN       = 40;   // agent must have enough intelligence
    const SELF_INITIATIVE_RATE = 0.05; // 5% daily chance per eligible agent

    const niches = this.computeNicheScores();
    if (niches.length === 0) return { selfFunded: 0, govFunded: 0, totalSpent: 0 };

    // Set of agents who already own at least one business (skip them)
    const existingOwnerIds = new Set(
      Array.from(this.businesses.values())
        .filter(b => b.ownerId != null)
        .map(b => b.ownerId as number)
    );

    let selfFunded = 0, govFunded = 0, totalSpent = 0;

    // Helper: create the business + good in DB and register in memory
    const openBusiness = async (
      agent: AgentState,
      niche: ReturnType<typeof this.computeNicheScores>[number],
      startingBalance: number,
    ) => {
      const bizCount = Array.from(this.businesses.values()).filter(b => b.type === niche.bizType).length;
      const bizName =
        niche.bizType === "food"     ? `${pick(FOOD_BUSINESS_NAMES)}     №${bizCount + 1}` :
        niche.bizType === "service"  ? `${pick(SERVICE_BUSINESS_NAMES)}  №${bizCount + 1}` :
        niche.bizType === "farm"     ? `${pick(FARM_BUSINESS_NAMES)}     №${bizCount + 1}` :
        /* workshop */                 `${pick(WORKSHOP_BUSINESS_NAMES)} №${bizCount + 1}`;

      // Raw producers (farm/workshop) have higher base production rate
      const prodRate = (niche.bizType === "farm" || niche.bizType === "workshop")
        ? rand(6, 15) : rand(4, 12);

      const [newBiz] = await db.insert(businessesTable).values({
        name: bizName.trim(), type: niche.bizType, balance: startingBalance,
        productionRate: prodRate, ownerId: agent.id, productivityLevel: 0,
      }).returning();
      this.businesses.set(newBiz.id, {
        ...newBiz, employeeCount: 1, maxEmployees: MAX_EMPLOYEES_BY_TYPE[newBiz.type] ?? 5,
        firedThisTick: 0, hiredThisTick: 1, ticksUnprofitable: 0, hasReceivedBailout: false,
      });

      const initialDemand = clamp(Math.round(niche.marketRatio * 20), 20, 80);
      const [newGood] = await db.insert(goodsTable).values({
        name: niche.name, businessId: newBiz.id,
        basePrice: niche.basePrice,
        currentPrice: niche.basePrice * (1 + this.config.priceMarkup),
        quality: rand(40, 70), demand: initialDemand, supply: rand(10, 25),
      }).returning();
      this.goods.set(newGood.id, { ...newGood });

      agent.employerId   = newBiz.id;
      agent.jobStartTick = this.state.tick;
      agent.jobHistory   = [...agent.jobHistory, { tick: this.state.tick, event: "hired", businessId: newBiz.id, businessName: bizName }];
      existingOwnerIds.add(agent.id);
      return bizName;
    };

    // ── Stage 1: Self-funded openings ─────────────────────────────────
    const selfCandidates = Array.from(this.agents.values()).filter(a =>
      !a.isRetired &&
      a.age >= 25 && a.age <= 55 &&
      a.jailedUntilTick == null &&
      !existingOwnerIds.has(a.id) &&
      (a.ambition     ?? 50) >= SELF_AMBITION_MIN &&
      (a.intelligence ?? 50) >= SELF_INTEL_MIN &&
      Math.random() < SELF_INITIATIVE_RATE
    );

    for (const agent of selfCandidates) {
      if (selfFunded >= MAX_SELF_FUNDED) break;
      // Pick the best niche the agent can afford (needs 1.5× buffer after paying launch cost)
      const targetNiche = niches.find(n => agent.money >= (BUSINESS_LAUNCH_COSTS[n.bizType] ?? Infinity) * 1.5);
      if (!targetNiche) continue;
      const launchCost = BUSINESS_LAUNCH_COSTS[targetNiche.bizType]!;
      agent.money -= launchCost;
      const bizName = await openBusiness(agent, targetNiche, launchCost);
      selfFunded++;
      logger.info({
        agentId: agent.id, bizName, bizType: targetNiche.bizType,
        launchCost, successScore: Math.round(targetNiche.successScore * 100),
        agentMoney: Math.round(agent.money + launchCost),
      }, "Self-funded business opened");
    }

    // ── Stage 2: Government grant requests ────────────────────────────
    // Government only funds niches above the approval threshold.
    const eligibleNiches = niches.filter(n => n.successScore >= GOV_THRESHOLD);
    if (eligibleNiches.length === 0) return { selfFunded, govFunded, totalSpent };

    // Минимальный порог бюджета для выдачи грантов.
    // При высокой безработице (>60%) правительство может уйти в дефицит до -15_000 —
    // инвестиция в новый бизнес возвращается налогами быстрее, чем копится долг.
    // При безработице 40-60% допускаем небольшой дефицит (-5_000).
    // При здоровой экономике требуем положительный резерв.
    const GRANT_BUDGET_RESERVE = unemploymentRate > 0.60 ? -15_000
                                : unemploymentRate > 0.40 ? -5_000
                                : 10_000;
    if (this.state.governmentBudget < GRANT_BUDGET_RESERVE) return { selfFunded, govFunded, totalSpent };

    // Grant candidates: unemployed agents who don't have enough savings to self-fund
    const grantCandidates = Array.from(this.agents.values())
      .filter(a =>
        !a.isRetired &&
        a.age >= 18 && a.age <= 65 &&
        a.employerId == null &&
        a.jailedUntilTick == null &&
        !existingOwnerIds.has(a.id)
      )
      // Sort: most ambitious first; break ties by poorest first
      .sort((a, b) => {
        const ad = (b.ambition ?? 50) - (a.ambition ?? 50);
        return Math.abs(ad) > 10 ? ad : a.money - b.money;
      })
      .slice(0, MAX_GOV_FUNDED * 2); // oversample — not every application will be approved

    for (const agent of grantCandidates) {
      if (govFunded >= MAX_GOV_FUNDED) break;
      // Rotate through top eligible niches to avoid saturation
      const nicheIndex  = govFunded % Math.min(eligibleNiches.length, 5);
      const targetNiche = eligibleNiches[nicheIndex];
      const launchCost  = BUSINESS_LAUNCH_COSTS[targetNiche.bizType]!;

      // Final budget check (may have decreased from prior approvals in this loop)
      // Stop issuing grants if we'd go deeper than the allowed deficit limit
      if (this.state.governmentBudget - launchCost < GRANT_BUDGET_RESERVE) break;

      this.state.governmentBudget -= launchCost;
      const bizName = await openBusiness(agent, targetNiche, launchCost);
      agent.money  += 200; // small cash stipend alongside the grant
      govFunded++;
      totalSpent += launchCost;

      logger.info({
        agentId: agent.id, bizName, bizType: targetNiche.bizType,
        launchCost, successScore: Math.round(targetNiche.successScore * 100),
        needScore: Math.round(targetNiche.needScore * 100),
        marketRatio: Math.round(targetNiche.marketRatio * 100) / 100,
        govBudgetAfter: Math.round(this.state.governmentBudget),
      }, "Government grant approved (need-driven)");
    }

    return { selfFunded, govFunded, totalSpent };
  }

  private async syncToDB(gdp: number): Promise<void> {
    await this.persistState();

    const agentArray = Array.from(this.agents.values());
    const goodsArray = Array.from(this.goods.values());
    const bizArray = Array.from(this.businesses.values());

    // --- SQLite sync ---
    const dirtyKeys = Array.from(this.dirtyRelations).slice(0, 500);
    const newRelRows: { agentIdA: number; agentIdB: number; friendshipLevel: number }[] = [];
    const existingRelRows: { agentIdA: number; agentIdB: number; friendshipLevel: number }[] = [];
    for (const key of dirtyKeys) {
      const [aStr, bStr] = key.split(":");
      const agentIdA = parseInt(aStr, 10);
      const agentIdB = parseInt(bStr, 10);
      const level = this.relations.get(agentIdA)?.get(agentIdB);
      if (level !== undefined) {
        if (this.persistedRelations.has(key)) {
          existingRelRows.push({ agentIdA, agentIdB, friendshipLevel: level });
        } else {
          newRelRows.push({ agentIdA, agentIdB, friendshipLevel: level });
          this.persistedRelations.add(key);
        }
      }
      this.dirtyRelations.delete(key);
    }
    sqlite.transaction(() => {
      const updateAgent = sqlite.prepare(`
        UPDATE agents SET
          age = ?,
          mood = ?,
          money = ?,
          current_action = ?,
          employer_id = ?,
          is_retired = ?,
          job_history = ?,
          career_level = ?,
          ambition = ?,
          strength = ?,
          intelligence = ?
        WHERE id = ?
      `);
      const updateNeeds = sqlite.prepare(`
        UPDATE needs SET
          hunger = ?,
          comfort = ?,
          social = ?,
          health = ?,
          sleep = ?,
          education = ?,
          entertainment = ?,
          faith = ?,
          housing_safety = ?,
          financial_safety = ?,
          physical_safety = ?,
          social_rating = ?,
          wellbeing = ?
        WHERE agent_id = ?
      `);
      const updateGood = sqlite.prepare(`
        UPDATE goods SET
          current_price = ?,
          demand = ?,
          supply = ?,
          quality = ?
        WHERE id = ?
      `);
      const updateBusiness = sqlite.prepare(`
        UPDATE businesses SET
          balance = ?,
          productivity_level = ?
        WHERE id = ?
      `);
      const insertRelation = sqlite.prepare(`
        INSERT OR IGNORE INTO relations (agent_id_a, agent_id_b, friendship_level)
        VALUES (?, ?, ?)
      `);
      const updateRelation = sqlite.prepare(`
        UPDATE relations
        SET friendship_level = ?
        WHERE agent_id_a = ? AND agent_id_b = ?
      `);

      for (const a of agentArray) {
        updateAgent.run(
          a.age,
          a.mood,
          a.money,
          a.currentAction,
          a.employerId ?? null,
          a.isRetired ? 1 : 0,
          JSON.stringify(a.jobHistory.slice(-50)),
          a.careerLevel,
          a.ambition,
          a.strength ?? 50,
          a.intelligence ?? 50,
          a.id,
        );
        updateNeeds.run(
          a.needs.hunger,
          a.needs.comfort,
          a.needs.social,
          a.needs.health,
          a.needs.sleep,
          a.needs.education,
          a.needs.entertainment,
          a.needs.faith,
          a.needs.housingSafety,
          a.needs.financialSafety,
          a.needs.physicalSafety,
          a.needs.socialRating,
          a.needs.wellbeing,
          a.id,
        );
      }

      for (const g of goodsArray) {
        updateGood.run(g.currentPrice, g.demand, g.supply, g.quality, g.id);
      }

      for (const b of bizArray) {
        updateBusiness.run(b.balance, b.productivityLevel ?? 0, b.id);
      }

      for (const r of newRelRows) {
        insertRelation.run(r.agentIdA, r.agentIdB, r.friendshipLevel);
      }

      for (const r of existingRelRows) {
        updateRelation.run(r.friendshipLevel, r.agentIdA, r.agentIdB);
      }
    })();

    // Stats history (single row insert)
    const { avgMood, avgWealth, unemploymentRate } = this.getAggregateStats();
    await db.insert(statsHistoryTable).values({
      tick: this.state.tick,
      gameHour: this.state.gameHour,
      gameDay: this.state.gameDay,
      avgMood,
      gdp,
      population: this.agents.size,
      avgWealth,
      unemploymentRate,
      governmentBudget: this.state.governmentBudget,
    });

    // Agent stat history — only write to DB every 24 ticks (once per game day)
    // to avoid inserting 4000+ rows every 10 seconds and triggering lock storms.
    const currentTick = this.state.tick;
    const shouldPersistStatHistory = currentTick % 24 === 0;
    const dbRows: { agentId: number; tick: number; money: number; mood: number; age: number; socialization: number }[] = [];
    for (const agent of this.agents.values()) {
      const snapshot: AgentStatSnapshot = {
        tick: currentTick,
        money: Math.round(agent.money * 100) / 100,
        mood: Math.round(agent.mood * 10) / 10,
        age: agent.age,
        socialization: Math.round(agent.socialization * 10) / 10,
      };
      const history = this.agentStatHistory.get(agent.id) ?? [];
      history.push(snapshot);
      if (history.length > AGENT_STAT_HISTORY_MAX) history.shift();
      this.agentStatHistory.set(agent.id, history);
      if (shouldPersistStatHistory) {
        dbRows.push({ agentId: agent.id, tick: currentTick, money: snapshot.money, mood: snapshot.mood, age: snapshot.age, socialization: snapshot.socialization });
      }
    }
    if (dbRows.length > 0) {
      await db.insert(agentStatHistoryTable).values(dbRows);
      const trimAgentHistory = sqlite.prepare(`
        DELETE FROM agent_stat_history
        WHERE agent_id = ?
          AND id NOT IN (
            SELECT id
            FROM agent_stat_history
            WHERE agent_id = ?
            ORDER BY tick DESC
            LIMIT ?
          )
      `);
      const agentIds = [...new Set(dbRows.map(r => r.agentId))];
      sqlite.transaction(() => {
        for (const agentId of agentIds) {
          trimAgentHistory.run(agentId, agentId, AGENT_STAT_HISTORY_MAX);
        }
      })();
    }
  }

  private async persistState(): Promise<void> {
    const [existing] = await db.select().from(simStateTable).limit(1);
    if (existing) {
      await db.update(simStateTable).set({
        tick: this.state.tick,
        running: this.state.running,
        gameHour: this.state.gameHour,
        gameDay: this.state.gameDay,
        scenarioType: this.state.scenarioType,
        goalType: this.state.goalType,
        dayLimit: this.state.dayLimit,
        gameStatus: this.state.gameStatus,
        gameOutcomeReason: this.state.gameOutcomeReason,
        actionPointsRemaining: this.state.actionPointsRemaining,
        actionPointsMax: this.state.actionPointsMax,
        governmentBudget: this.state.governmentBudget,
        totalTaxCollected: this.state.totalTaxCollected,
        totalSubsidiesPaid: this.state.totalSubsidiesPaid,
        totalPensionPaid: this.state.totalPensionPaid,
        totalPublicServicesPaid: this.state.totalPublicServicesPaid,
        updatedAt: new Date(),
      }).where(eq(simStateTable.id, existing.id));
    }
  }

  private getAggregateStats() {
    const agents = Array.from(this.agents.values());
    if (agents.length === 0) return { avgMood: 0, avgWealth: 0, unemploymentRate: 0 };
    const avgMood = agents.reduce((s, a) => s + a.mood, 0) / agents.length;
    const avgWealth = agents.reduce((s, a) => s + a.money, 0) / agents.length;
    // Безработица = только среди трудоспособных (не пенсионеры)
    const workingAge = agents.filter(a => !a.isRetired);
    const employed = workingAge.filter(a => a.employerId != null).length;
    const unemploymentRate = workingAge.length > 0
      ? ((workingAge.length - employed) / workingAge.length) * 100
      : 0;
    return { avgMood, avgWealth, unemploymentRate };
  }

  private getAverageHealth(): number {
    const agents = Array.from(this.agents.values());
    if (agents.length === 0) return 0;
    return agents.reduce((sum, agent) => sum + agent.needs.health, 0) / agents.length;
  }

  private getProfitableBusinessPercent(): number {
    const businesses = Array.from(this.businesses.values());
    if (businesses.length === 0) return 0;
    return (businesses.filter(b => b.balance >= 0).length / businesses.length) * 100;
  }

  private getPlayerDecisionCount(predicate?: (decree: DailyDecreeRecord) => boolean): number {
    const issued = new Set<string>();
    for (const decree of this.dailyDecrees) {
      if (decree.actionPointCost <= 0) continue;
      if (predicate && !predicate(decree)) continue;
      issued.add(`${decree.decisionId}:${decree.issuedDay}`);
    }
    return issued.size;
  }

  private evaluateGoal(gdpOverride?: number): GoalEvaluation {
    const { avgMood, unemploymentRate } = this.getAggregateStats();
    const avgHealth = this.getAverageHealth();
    const avgPhysicalSafety = this.getAverageNeed("physicalSafety");
    const avgHousingSafety = this.getAverageNeed("housingSafety");
    const avgSocialRating = this.getAverageNeed("socialRating");
    const profitablePercent = this.getProfitableBusinessPercent();
    const gdp = gdpOverride ?? Array.from(this.businesses.values()).reduce((s, b) => s + b.balance, 0);

    const residentsScore = clampScore(avgMood * 0.5 + (100 - unemploymentRate) * 0.3 + avgHealth * 0.2 + this.residentRequestReputationDelta);
    const businessScore = clampScore(profitablePercent * 0.65 + Math.min(35, Math.max(0, gdp / 10000)));
    const governmentScore = clampScore(Math.min(100, Math.max(0, this.state.governmentBudget / 2500)) * 0.7 + 30);
    const securityScore = clampScore((avgPhysicalSafety + avgHousingSafety) / 2);
    const playerDecisionCount = this.getPlayerDecisionCount();
    const requiredDecisionCount = Math.max(4, Math.min(10, Math.ceil(this.state.dayLimit * 0.22)));
    const activeDaysRequired = Math.max(7, Math.ceil(this.state.dayLimit * 0.55));
    const enoughChoices = playerDecisionCount >= requiredDecisionCount && this.state.gameDay >= activeDaysRequired;

    let progress = 0;
    let rawVictory = false;

    switch (this.state.goalType) {
      case "crisis_recovery":
        progress = (
          Math.min(1, this.state.governmentBudget / 100000) +
          Math.min(1, Math.max(0, (25 - unemploymentRate) / 15)) +
          Math.min(1, avgMood / 60)
        ) / 3;
        rawVictory = this.state.governmentBudget >= 100000 && unemploymentRate <= 10 && avgMood >= 60;
        break;
      case "economic_growth":
      case "market_growth":
        progress = (
          Math.min(1, gdp / 420000) +
          Math.min(1, profitablePercent / 75) +
          Math.min(1, Math.max(0, (18 - unemploymentRate) / 12))
        ) / 3;
        rawVictory = gdp >= 420000 && profitablePercent >= 75 && unemploymentRate <= 8;
        break;
      case "social_stability":
        progress = (
          Math.min(1, residentsScore / 75) +
          Math.min(1, avgHealth / 75) +
          Math.min(1, Math.max(0, this.agents.size / 1000))
        ) / 3;
        rawVictory = residentsScore >= 75 && avgHealth >= 75 && this.agents.size >= 1000;
        break;
      case "force_order": {
        const forceMoves = this.getPlayerDecisionCount(decree =>
          decree.decisionId === "government_hardline_patrols" ||
          decree.decisionId === "government_security_push" ||
          decree.decisionId === "residents_quiet_evenings" ||
          decree.decisionId === "residents_housing_repairs"
        );
        progress = (
          Math.min(1, securityScore / 78) +
          Math.min(1, governmentScore / 72) +
          Math.min(1, residentsScore / 55) +
          Math.min(1, forceMoves / 4)
        ) / 4;
        rawVictory = securityScore >= 78 && governmentScore >= 72 && residentsScore >= 55 && forceMoves >= 4;
        break;
      }
      case "corruption_network": {
        const shadowContracts = this.getPlayerDecisionCount(decree => decree.decisionId === "government_shadow_contracts");
        progress = (
          Math.min(1, this.state.governmentBudget / 140000) +
          Math.min(1, businessScore / 76) +
          Math.min(1, residentsScore / 45) +
          Math.min(1, shadowContracts / 4)
        ) / 4;
        rawVictory = this.state.governmentBudget >= 140000 && businessScore >= 76 && residentsScore >= 45 && avgSocialRating >= 35 && shadowContracts >= 4;
        break;
      }
      case "balanced":
      default:
        progress = (
          Math.min(1, residentsScore / 70) +
          Math.min(1, businessScore / 70) +
          Math.min(1, governmentScore / 70)
        ) / 3;
        rawVictory = residentsScore >= 70 && businessScore >= 70 && governmentScore >= 70;
        break;
    }

    const victory = rawVictory && enoughChoices;
    if (rawVictory && !victory) {
      progress = Math.min(progress, 0.96);
    }

    if (victory) {
      return {
        status: "victory",
        reason: this.getVictoryReason(),
        progress: Math.round(progress * 100),
        residentsScore: Math.round(residentsScore),
        businessScore: Math.round(businessScore),
        governmentScore: Math.round(governmentScore),
      };
    }

    const timeExpired = this.state.gameDay > this.state.dayLimit;
    if (timeExpired) {
      return {
        status: "defeat",
        reason: "Срок партии истёк: цель сценария не выполнена.",
        progress: Math.round(progress * 100),
        residentsScore: Math.round(residentsScore),
        businessScore: Math.round(businessScore),
        governmentScore: Math.round(governmentScore),
      };
    }

    if (residentsScore < 20) {
      return {
        status: "defeat",
        reason: "Город сорвался в массовые протесты жителей.",
        progress: Math.round(progress * 100),
        residentsScore: Math.round(residentsScore),
        businessScore: Math.round(businessScore),
        governmentScore: Math.round(governmentScore),
      };
    }

    return {
      status: "active",
      reason: null,
      progress: Math.round(progress * 100),
      residentsScore: Math.round(residentsScore),
      businessScore: Math.round(businessScore),
      governmentScore: Math.round(governmentScore),
    };
  }

  private getVictoryReason(): string {
    switch (this.state.goalType) {
      case "crisis_recovery":
        return "Кризис преодолён: бюджет, занятость и настроение вернулись в устойчивую зону.";
      case "economic_growth":
      case "market_growth":
        return "Экономический рывок состоялся: бизнесы прибыльны, ВВП вырос, безработица низкая.";
      case "social_stability":
        return "Город стабилен: жители здоровы, население удержано, доверие высокое.";
      case "force_order":
        return "Порядок удержан: силовая стратегия стабилизировала безопасность и управляемость города.";
      case "corruption_network":
        return "Серая сеть сработала: бюджет и подрядчики удержали город на плаву, не обрушив доверие ниже критической зоны.";
      case "balanced":
      default:
        return "Баланс интересов найден: жители, бизнес и власть поддерживают курс мэра.";
    }
  }

  private applyGoalEvaluation(gdpOverride?: number): GoalEvaluation {
    const evaluation = this.evaluateGoal(gdpOverride);
    if (this.state.gameStatus === "active" && evaluation.status !== "active") {
      this.state.gameStatus = evaluation.status;
      this.state.gameOutcomeReason = evaluation.reason;
      this.state.running = false;
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      logger.info({ status: evaluation.status, reason: evaluation.reason }, "Game finished");
    }
    return evaluation;
  }

  private refreshDailyDecreeStatuses(): void {
    const updateStatus = sqlite.prepare("UPDATE daily_decrees SET status = ? WHERE id = ?");
    let changed = false;
    for (const decree of this.dailyDecrees) {
      const nextStatus: DailyDecreeStatus =
        this.state.gameDay < decree.startDay
          ? "pending"
          : this.state.gameDay <= decree.endDay
            ? "active"
            : "expired";
      if (decree.status !== nextStatus) {
        decree.status = nextStatus;
        updateStatus.run(nextStatus, decree.id);
        changed = true;
      }
    }
    if (changed) {
      this.dailyDecrees.sort((a, b) => b.issuedDay - a.issuedDay || b.id - a.id);
    }
  }

  private getActiveDailyDecrees(): DailyDecreeRecord[] {
    this.refreshDailyDecreeStatuses();
    return this.dailyDecrees.filter(decree => decree.status === "active");
  }

  private getDecisionModifiers(): DecisionModifiers {
    const modifiers: DecisionModifiers = {
      needDecayMultiplier: 1,
      socialMultiplier: 1,
      taxDelta: 0,
      subsidyMultiplier: 1,
    };
    for (const decree of this.getActiveDailyDecrees()) {
      for (const effect of decree.effects) {
        if (effect.kind === "need_decay_multiplier") modifiers.needDecayMultiplier *= effect.value;
        else if (effect.kind === "social_multiplier") modifiers.socialMultiplier *= effect.value;
        else if (effect.kind === "tax_delta") modifiers.taxDelta += effect.value;
        else if (effect.kind === "subsidy_multiplier") modifiers.subsidyMultiplier *= effect.value;
      }
    }
    return modifiers;
  }

  private applyDailyDecisionEffects(decrees = this.getActiveDailyDecrees()): void {
    for (const decree of decrees) {
      for (const effect of decree.effects) {
        this.applyDecisionEffect(effect);
      }
    }
  }

  private applyDecisionEffect(effect: DecisionEffect): void {
    if (effect.kind === "daily_need_delta" && effect.need) {
      for (const agent of this.agents.values()) {
        agent.needs[effect.need] = clamp(agent.needs[effect.need] + effect.value);
      }
    } else if (effect.kind === "daily_business_delta" && effect.businessType) {
      for (const business of this.businesses.values()) {
        if (business.type === effect.businessType) {
          business.balance += effect.value;
        }
      }
    } else if (effect.kind === "budget_delta") {
      this.state.governmentBudget = Math.max(0, this.state.governmentBudget + effect.value);
    } else if (effect.kind === "public_quality_delta" && effect.businessType) {
      for (const good of this.goods.values()) {
        const business = good.businessId != null ? this.businesses.get(good.businessId) : null;
        if (business?.type === effect.businessType) {
          good.quality = clamp(good.quality + effect.value);
        }
      }
    } else if (effect.kind === "food_supply_delta") {
      for (const good of this.goods.values()) {
        const business = good.businessId != null ? this.businesses.get(good.businessId) : null;
        if (business?.type === "food" || business?.type === "farm") {
          good.supply = clamp(good.supply + effect.value, 0, 200);
        }
      }
    }
  }

  private applyFactionOutcome(demand: FactionDemandRecord, outcome: FactionDemandOutcome, status: Exclude<FactionDemandStatus, "active">): void {
    this.state.governmentBudget = Math.max(0, this.state.governmentBudget + outcome.budgetDelta);
    for (const effect of outcome.effects) {
      this.applyDecisionEffect(effect);
    }
    demand.status = status;
    demand.resolvedDay = this.state.gameDay;
    demand.pressure = clamp(demand.pressure + outcome.pressureDelta, 0, 100);
    demand.resolutionLabel = outcome.label;
  }

  private getAverageNeed(need: keyof AgentState["needs"]): number {
    if (this.agents.size === 0) return 0;
    let sum = 0;
    for (const agent of this.agents.values()) {
      sum += agent.needs[need];
    }
    return sum / this.agents.size;
  }

  private getFoodMarketRatio(): number {
    let demand = 0;
    let supply = 0;
    for (const good of this.goods.values()) {
      const business = good.businessId != null ? this.businesses.get(good.businessId) : null;
      if (business?.type === "food" || business?.type === "farm") {
        demand += good.demand;
        supply += good.supply;
      }
    }
    return demand > 0 ? supply / demand : 1;
  }

  private buildFactionReward(side: DailyDecisionSide): FactionDemandOutcome {
    if (side === "residents") {
      return {
        label: "Требование жителей закрыто: доверие и благополучие растут.",
        budgetDelta: 0,
        pressureDelta: -28,
        effects: [
          { kind: "daily_need_delta", need: "socialRating", label: "Жители видят, что мэрия реагирует на давление", value: 1.4 },
          { kind: "daily_need_delta", need: "wellbeing", label: "Бытовое напряжение немного снижается", value: 1.0 },
        ],
      };
    }
    if (side === "business") {
      return {
        label: "Бизнес получил ответ и вернул часть доверия инвестициями.",
        budgetDelta: 700,
        pressureDelta: -24,
        effects: [
          { kind: "daily_business_delta", businessType: "service", label: "Сервисные компании активнее держат оборот", value: 120 },
          { kind: "daily_business_delta", businessType: "food", label: "Торговые компании быстрее пополняют оборот", value: 90 },
        ],
      };
    }
    return {
      label: "Госаппарат получил ясное поручение: резерв и управляемость укреплены.",
      budgetDelta: 1000,
      pressureDelta: -22,
      effects: [
        { kind: "daily_need_delta", need: "physicalSafety", label: "Службы работают слаженнее", value: 0.9 },
        { kind: "daily_need_delta", need: "housingSafety", label: "Контроль районных проблем становится лучше", value: 0.7 },
      ],
    };
  }

  private buildFactionPenalty(side: DailyDecisionSide): FactionDemandOutcome {
    if (side === "residents") {
      return {
        label: "Требование жителей проигнорировано: настроение и доверие просели.",
        budgetDelta: 0,
        pressureDelta: 18,
        effects: [
          { kind: "daily_need_delta", need: "socialRating", label: "Игнорирование жалоб бьет по доверию", value: -2.2 },
          { kind: "daily_need_delta", need: "wellbeing", label: "Нерешенные бытовые проблемы давят на людей", value: -1.4 },
        ],
      };
    }
    if (side === "business") {
      return {
        label: "Бизнес не дождался ответа: часть компаний замораживает оборот.",
        budgetDelta: -600,
        pressureDelta: 16,
        effects: [
          { kind: "daily_business_delta", businessType: "service", label: "Сервисные компании откладывают найм и закупки", value: -130 },
          { kind: "daily_business_delta", businessType: "food", label: "Торговый оборот проседает из-за неопределенности", value: -90 },
        ],
      };
    }
    return {
      label: "Госаппарат не получил решения: срочные расходы выросли.",
      budgetDelta: -1200,
      pressureDelta: 20,
      effects: [
        { kind: "daily_need_delta", need: "physicalSafety", label: "Просроченные поручения ухудшают ощущение безопасности", value: -1.3 },
        { kind: "daily_need_delta", need: "housingSafety", label: "Районные проблемы накапливаются без реакции", value: -1.1 },
      ],
    };
  }

  private buildFactionRequirement(card: DailyEventCard): string {
    const deadlineText = card.tone === "critical" ? "до конца следующего дня" : "в течение двух дней";
    if (card.side === "residents") {
      return `Принять любую реакцию в пользу жителей ${deadlineText}.`;
    }
    if (card.side === "business") {
      return `Принять любую реакцию в пользу бизнеса ${deadlineText}.`;
    }
    return `Принять любую реакцию в пользу власти ${deadlineText}.`;
  }

  private generateFactionDemands(cards = this.getDailyEventCards()): void {
    if (this.state.gameStatus !== "active") return;
    for (const card of cards) {
      const hasActive = this.factionDemands.some(demand => demand.side === card.side && demand.status === "active");
      const recentResolved = this.factionDemands.some(demand =>
        demand.side === card.side &&
        demand.status !== "active" &&
        demand.resolvedDay != null &&
        this.state.gameDay - demand.resolvedDay <= 1
      );
      if (hasActive || recentResolved) continue;
      if (card.tone !== "critical" && (this.state.gameDay + card.side.length) % 2 !== 0) continue;

      const pressure = card.tone === "critical" ? 82 : card.tone === "warning" ? 58 : 36;
      this.factionDemands.unshift({
        id: `faction-${this.factionDemandSeq++}`,
        side: card.side,
        sideLabel: card.sideLabel,
        title: card.title,
        description: card.eventText,
        requirement: this.buildFactionRequirement(card),
        pressure,
        createdDay: this.state.gameDay,
        deadlineDay: this.state.gameDay + (card.tone === "critical" ? 1 : 2),
        status: "active",
        resolvedDay: null,
        resolutionLabel: null,
        reward: this.buildFactionReward(card.side),
        penalty: this.buildFactionPenalty(card.side),
      });
    }
    this.factionDemands = this.factionDemands.slice(0, 18);
  }

  private resolveExpiredFactionDemands(): void {
    for (const demand of this.factionDemands) {
      if (demand.status === "active" && this.state.gameDay > demand.deadlineDay) {
        this.applyFactionOutcome(demand, demand.penalty, "ignored");
      }
    }
  }

  private completeFactionDemandForSide(side: DailyDecisionSide): void {
    const demand = this.factionDemands
      .filter(item => item.side === side && item.status === "active")
      .sort((a, b) => a.deadlineDay - b.deadlineDay)[0];
    if (!demand) return;
    this.applyFactionOutcome(demand, demand.reward, "completed");
  }

  private serializeFactionDemand(demand: FactionDemandRecord) {
    return {
      ...demand,
      daysRemaining: demand.status === "active" ? Math.max(0, demand.deadlineDay - this.state.gameDay + 1) : 0,
    };
  }

  private getFactionPressureState(cards = this.getDailyEventCards()) {
    this.resolveExpiredFactionDemands();
    this.generateFactionDemands(cards);
    const activeDemands = this.factionDemands
      .filter(demand => demand.status === "active")
      .sort((a, b) => a.deadlineDay - b.deadlineDay || b.pressure - a.pressure);
    const recentDemands = this.factionDemands
      .filter(demand => demand.status !== "active")
      .sort((a, b) => (b.resolvedDay ?? 0) - (a.resolvedDay ?? 0))
      .slice(0, 6);
    const pressureBySide = (["residents", "business", "government"] as DailyDecisionSide[]).map(side => {
      const active = activeDemands.filter(demand => demand.side === side);
      const card = cards.find(item => item.side === side);
      const pressure = active.length > 0
        ? Math.max(...active.map(demand => demand.pressure))
        : card?.tone === "critical" ? 70 : card?.tone === "warning" ? 45 : 25;
      return {
        side,
        sideLabel: card?.sideLabel ?? side,
        pressure: Math.round(pressure),
        activeCount: active.length,
      };
    });
    return {
      currentDay: this.state.gameDay,
      activeDemands: activeDemands.map(demand => this.serializeFactionDemand(demand)),
      recentDemands: recentDemands.map(demand => this.serializeFactionDemand(demand)),
      pressureBySide,
      completedCount: this.factionDemands.filter(demand => demand.status === "completed").length,
      ignoredCount: this.factionDemands.filter(demand => demand.status === "ignored").length,
    };
  }

  private getDailyCardDecisionIds(side: DailyDecisionSide, preferred: string[]): string[] {
    const sideDecisionIds = DAILY_DECISION_CATALOG
      .filter(decision => decision.side === side)
      .map(decision => decision.id);
    const result: string[] = [];
    for (const id of preferred) {
      if (sideDecisionIds.includes(id) && !result.includes(id)) result.push(id);
    }
    const offset = sideDecisionIds.length > 0 ? (this.state.gameDay + side.length) % sideDecisionIds.length : 0;
    const rotated = [...sideDecisionIds.slice(offset), ...sideDecisionIds.slice(0, offset)];
    for (const id of rotated) {
      if (result.length >= 3) break;
      if (!result.includes(id)) result.push(id);
    }
    return result.slice(0, 3);
  }

  private getDailyEventCards(): DailyEventCard[] {
    const { avgMood, avgWealth, unemploymentRate } = this.getAggregateStats();
    const foodRatio = this.getFoodMarketRatio();
    const avgHealth = this.getAverageNeed("health");
    const avgSleep = this.getAverageNeed("sleep");
    const avgFinancialSafety = this.getAverageNeed("financialSafety");
    const avgPhysicalSafety = this.getAverageNeed("physicalSafety");
    const avgHousingSafety = this.getAverageNeed("housingSafety");
    const businesses = Array.from(this.businesses.values());
    const goods = Array.from(this.goods.values());
    const profitableCount = businesses.filter(b => b.balance > 0).length;
    const unprofitableCount = businesses.filter(b => b.balance < 0).length;
    const profitablePct = businesses.length > 0 ? (profitableCount / businesses.length) * 100 : 100;
    const totalDemand = goods.reduce((s, g) => s + g.demand, 0);
    const totalSupply = goods.reduce((s, g) => s + g.supply, 0);
    const marketRatio = totalDemand > 0 ? totalSupply / totalDemand : 1;
    const dailyIncome = Math.max(1, this.state.totalTaxCollected / Math.max(1, this.state.gameDay));
    const budgetDays = this.state.governmentBudget / dailyIncome;
    const securityAvg = (avgPhysicalSafety + avgHousingSafety) / 2;

    const residentsCritical = avgMood < 42 || avgFinancialSafety < 45 || foodRatio < 0.75 || avgHealth < 45;
    const businessCritical = profitablePct < 45 || unprofitableCount >= Math.max(3, businesses.length * 0.35) || marketRatio < 0.72;
    const governmentCritical = this.state.governmentBudget < 15000 || budgetDays < 3 || securityAvg < 52;

    const residentsTitle = residentsCritical
      ? "Жители требуют срочной реакции"
      : avgMood > 68 && avgFinancialSafety > 65
        ? "Жители замечают улучшения"
        : "Жители просят внимания";
    const residentsEvent = foodRatio < 0.75
      ? "В районах жалуются на рост цен и нехватку доступной еды."
      : avgFinancialSafety < 45
        ? "Семьи с низкими доходами просят адресной помощи до следующей выплаты."
        : avgHealth < 45
          ? "Жители сообщают о проблемах со здоровьем и доступом к услугам."
          : avgSleep < 45
            ? "Усталость накапливается: люди хуже восстанавливаются после работы."
            : "Обращения жителей показывают, какие бытовые проблемы сильнее всего давят на настроение.";

    const businessTitle = businessCritical
      ? "Бизнес предупреждает о закрытиях"
      : profitablePct > 70 && marketRatio >= 0.9
        ? "Бизнес готов к расширению"
        : "Бизнес просит предсказуемости";
    const businessEvent = profitablePct < 45
      ? "Доля прибыльных компаний падает, предприниматели откладывают найм."
      : unprofitableCount > 0
        ? "Несколько компаний работают в минус и просят короткую передышку."
        : marketRatio < 0.8
          ? "Цепочки поставок не успевают за спросом, склады и магазины расходятся по темпу."
          : "Предприниматели предлагают сделку: больше рабочих мест в обмен на поддержку оборота.";

    const governmentTitle = governmentCritical
      ? "Финансовый отдел бьет тревогу"
      : this.state.governmentBudget > 80000 && securityAvg > 65
        ? "Государство может укрепить устойчивость"
        : "Государству нужен управленческий выбор";
    const governmentEvent = this.state.governmentBudget < 15000
      ? "Расходы подбираются к опасной черте, запас бюджета почти исчерпан."
      : budgetDays < 3
        ? "Текущих доходов мало относительно темпа расходов."
        : securityAvg < 52
          ? "Службы безопасности просят усилить контроль в районах."
          : "Аппарат мэрии предлагает навести порядок в расходах, пока кризис не стал явным.";

    const residentDecisionIds = this.getDailyCardDecisionIds(
      "residents",
      foodRatio < 0.75
        ? ["residents_food_subsidy", "residents_targeted_aid", "residents_public_promise"]
        : avgHealth < 50
          ? ["residents_mobile_clinics", "residents_targeted_aid", "residents_public_promise"]
          : avgSleep < 50
            ? ["residents_quiet_evenings", "residents_housing_repairs", "residents_public_promise"]
            : securityAvg < 55 || avgHousingSafety < 55
              ? ["residents_housing_repairs", "residents_quiet_evenings", "residents_targeted_aid"]
              : ["residents_public_promise", "residents_targeted_aid", "residents_quiet_evenings"],
    );
    const businessDecisionIds = this.getDailyCardDecisionIds(
      "business",
      marketRatio < 0.8
        ? ["business_supply_chain", "business_food_contracts", "business_micro_grants"]
        : profitablePct < 55 || unprofitableCount > 0
          ? ["business_micro_grants", "business_hiring_vouchers", "business_tax_relief"]
          : unemploymentRate > 8
            ? ["business_hiring_vouchers", "business_micro_grants", "business_tax_relief"]
            : ["business_fast_permits", "business_tax_relief", "business_supply_chain"],
    );
    const governmentDecisionIds = this.getDailyCardDecisionIds(
      "government",
      this.state.governmentBudget < 15000 || budgetDays < 3
        ? ["government_tax_surcharge", "government_shadow_contracts", "government_emergency_reserve"]
        : securityAvg < 52
          ? ["government_hardline_patrols", "government_security_push", "government_service_overtime"]
          : ["government_data_inspection", "government_spending_audit", "government_shadow_contracts"],
    );

    return [
      {
        id: "residents",
        side: "residents",
        sideLabel: "Жители",
        title: residentsTitle,
        eventText: residentsEvent,
        daySummary: `Настроение ${avgMood.toFixed(1)}, фин. безопасность ${avgFinancialSafety.toFixed(1)}, еда ${foodRatio.toFixed(2)}x.`,
        tone: residentsCritical ? "critical" : avgMood > 68 ? "opportunity" : "warning",
        activity: foodRatio < 0.75 || avgFinancialSafety < 45 ? "resident_requests" : "city_news",
        decisionIds: residentDecisionIds,
      },
      {
        id: "business",
        side: "business",
        sideLabel: "Бизнес",
        title: businessTitle,
        eventText: businessEvent,
        daySummary: `Прибыльных ${profitablePct.toFixed(0)}%, убыточных ${unprofitableCount}, рынок ${marketRatio.toFixed(2)}x.`,
        tone: businessCritical ? "critical" : profitablePct > 70 ? "opportunity" : "warning",
        activity: marketRatio < 0.8 ? "crisis_staff" : "business_talks",
        decisionIds: businessDecisionIds,
      },
      {
        id: "government",
        side: "government",
        sideLabel: "Государство",
        title: governmentTitle,
        eventText: governmentEvent,
        daySummary: `Бюджет ${Math.round(this.state.governmentBudget).toLocaleString()}, запас ${budgetDays.toFixed(1)} дн., безопасность ${securityAvg.toFixed(1)}.`,
        tone: governmentCritical ? "critical" : this.state.governmentBudget > 80000 ? "opportunity" : "warning",
        activity: this.state.governmentBudget < 15000 || budgetDays < 3 ? "budget_session" : "crisis_staff",
        decisionIds: governmentDecisionIds,
      },
    ];
  }

  private getDailySummary(cards = this.getDailyEventCards()): string {
    const critical = cards.filter(card => card.tone === "critical").map(card => card.sideLabel);
    if (critical.length > 0) {
      return `За день обострились вопросы: ${critical.join(", ")}. Можно поддержать только одну сторону.`;
    }
    const opportunities = cards.filter(card => card.tone === "opportunity").map(card => card.sideLabel);
    if (opportunities.length > 0) {
      return `День прошел без острого кризиса. Лучшие возможности сейчас: ${opportunities.join(", ")}.`;
    }
    return "День прошел напряженно, но без единственного очевидного кризиса. Выберите, какую сторону города поддержать.";
  }

  private hasIssuedDailyDecisionToday(): boolean {
    return this.dailyDecrees.some(decree => decree.issuedDay === this.state.gameDay);
  }

  private getDecisionAvailability(definition: DailyDecisionDefinition) {
    const latest = this.dailyDecrees
      .filter(decree => decree.decisionId === definition.id)
      .sort((a, b) => b.issuedDay - a.issuedDay)[0];
    const cooldownRemaining = latest
      ? Math.max(0, latest.issuedDay + latest.cooldownDays - this.state.gameDay)
      : 0;
    const activeDuplicate = this.dailyDecrees.some(decree =>
      decree.decisionId === definition.id && (decree.status === "active" || decree.status === "pending")
    );
    const alreadyChosenToday = this.hasIssuedDailyDecisionToday();
    const reasons: string[] = [];
    if (this.state.gameStatus !== "active") reasons.push("Партия завершена");
    if (alreadyChosenToday) reasons.push("Событие дня уже выбрано");
    if (this.state.actionPointsRemaining < definition.actionPointCost) reasons.push("Не хватает очков действий");
    if (this.state.governmentBudget < definition.budgetCost) reasons.push("Не хватает бюджета");
    if (cooldownRemaining > 0) reasons.push(`Кулдаун ${cooldownRemaining} дн.`);
    if (activeDuplicate) reasons.push("Указ уже действует или ожидает запуска");
    return {
      canIssue: reasons.length === 0,
      unavailableReason: reasons[0] ?? null,
      cooldownRemaining,
    };
  }

  private getResidentDistrict(agentId: number): string {
    return RESIDENT_REQUEST_DISTRICTS[Math.abs(agentId) % RESIDENT_REQUEST_DISTRICTS.length];
  }

  private getFoodPressure(): boolean {
    let demand = 0;
    let supply = 0;
    for (const good of this.goods.values()) {
      const business = good.businessId != null ? this.businesses.get(good.businessId) : null;
      if (business?.type === "food" || business?.type === "farm") {
        demand += good.demand;
        supply += good.supply;
      }
    }
    return demand > 0 && supply / demand < 0.75;
  }

  private getResidentRequestCandidates(): ResidentRequestRecord[] {
    const { unemploymentRate } = this.getAggregateStats();
    const foodPressure = this.getFoodPressure();
    const existingKeys = new Set(this.residentRequests.map(request => `${request.agentId}:${request.category}`));
    const candidates: ResidentRequestRecord[] = [];

    const addCandidate = (
      agent: AgentState,
      category: ResidentRequestCategory,
      problem: string,
      need?: keyof AgentState["needs"],
    ) => {
      if (existingKeys.has(`${agent.id}:${category}`)) return;
      candidates.push({
        id: `req-${this.residentRequestSeq + candidates.length}`,
        agentId: agent.id,
        residentName: agent.name,
        residentAge: agent.age,
        district: this.getResidentDistrict(agent.id),
        category,
        categoryLabel: RESIDENT_REQUEST_CATEGORY_LABELS[category],
        problem,
        need,
        helpCost: randInt(10, 50),
        createdTick: this.state.tick,
        createdDay: this.state.gameDay,
      });
    };

    for (const agent of this.agents.values()) {
      if (agent.isRetired && agent.age > 90) continue;
      if (agent.money < 45) {
        addCandidate(agent, "finance", pick([
          "Не хватает денег до следующей выплаты.",
          "Просит разовую помощь на базовые расходы.",
          "Нужна поддержка после неудачной недели.",
        ]), "financialSafety");
      }
      if (!agent.isRetired && agent.employerId == null && agent.age >= 18 && agent.age <= 65 && unemploymentRate > 8) {
        addCandidate(agent, "work", pick([
          "Просит помочь найти работу в городе.",
          "Жалуется, что вакансий рядом почти нет.",
          "Нужна поддержка при поиске нового места.",
        ]), "financialSafety");
      }
      if (agent.needs.hunger < 55 || foodPressure) {
        addCandidate(agent, "food", pick([
          "Жалуется на дорогую еду и пустые полки.",
          "Просит продуктовый набор для семьи.",
          "Сообщает, что районный магазин не справляется со спросом.",
        ]), "hunger");
      }
      if (agent.needs.health < 55) {
        addCandidate(agent, "health", pick([
          "Просит помочь попасть к врачу быстрее.",
          "Нужна компенсация на лечение.",
          "Жалуется на ухудшение здоровья.",
        ]), "health");
      }
      if (agent.needs.comfort < 45 || agent.needs.wellbeing < 45) {
        addCandidate(agent, "comfort", pick([
          "Просит решить бытовую проблему в доме.",
          "Жалуется на усталость и нехватку условий для отдыха.",
          "Нужна небольшая помощь с ремонтом жилья.",
        ]), "comfort");
      }
      if (agent.needs.physicalSafety < 50 || agent.needs.housingSafety < 50) {
        addCandidate(agent, "safety", pick([
          "Сообщает о небезопасном дворе.",
          "Просит усилить патрулирование возле дома.",
          "Жалуется на тревожную обстановку в районе.",
        ]), "physicalSafety");
      }
    }

    return candidates;
  }

  private generateResidentRequests(): void {
    const slots = RESIDENT_REQUEST_BUFFER_MAX - this.residentRequests.length;
    if (slots <= 0 || this.agents.size === 0) return;

    const candidates = this.getResidentRequestCandidates();
    if (candidates.length === 0) return;

    const count = Math.min(slots, randInt(1, 2), candidates.length);
    for (let i = 0; i < count; i++) {
      const index = randInt(0, candidates.length - 1);
      const [candidate] = candidates.splice(index, 1);
      candidate.id = `req-${this.residentRequestSeq++}`;
      this.residentRequests.unshift(candidate);
    }
  }

  getResidentRequestsState() {
    return {
      currentDay: this.state.gameDay,
      pendingCount: this.residentRequests.length,
      bufferMax: RESIDENT_REQUEST_BUFFER_MAX,
      reputationDelta: Math.round(this.residentRequestReputationDelta * 10) / 10,
      requests: this.residentRequests.map(request => ({
        ...request,
        canHelp: this.state.gameStatus === "active" && this.state.governmentBudget >= request.helpCost,
      })),
    };
  }

  private syncResidentRequestAgent(agent: AgentState): void {
    sqlite.prepare(`
      UPDATE agents SET mood = ?, money = ? WHERE id = ?
    `).run(agent.mood, agent.money, agent.id);
    sqlite.prepare(`
      UPDATE needs SET
        hunger = ?,
        comfort = ?,
        social = ?,
        health = ?,
        sleep = ?,
        education = ?,
        entertainment = ?,
        faith = ?,
        housing_safety = ?,
        financial_safety = ?,
        physical_safety = ?,
        social_rating = ?,
        wellbeing = ?
      WHERE agent_id = ?
    `).run(
      agent.needs.hunger,
      agent.needs.comfort,
      agent.needs.social,
      agent.needs.health,
      agent.needs.sleep,
      agent.needs.education,
      agent.needs.entertainment,
      agent.needs.faith,
      agent.needs.housingSafety,
      agent.needs.financialSafety,
      agent.needs.physicalSafety,
      agent.needs.socialRating,
      agent.needs.wellbeing,
      agent.id,
    );
  }

  async processResidentRequest(requestId: string, action: ResidentRequestAction) {
    const index = this.residentRequests.findIndex(request => request.id === requestId);
    if (index < 0) {
      throw new Error("UNKNOWN_RESIDENT_REQUEST");
    }
    if (this.state.gameStatus !== "active") {
      throw new Error("GAME_FINISHED");
    }

    const [request] = this.residentRequests.splice(index, 1);
    const agent = this.agents.get(request.agentId);
    if (action === "help") {
      if (this.state.governmentBudget < request.helpCost) {
        this.residentRequests.splice(index, 0, request);
        throw new Error("NOT_ENOUGH_BUDGET");
      }
      this.state.governmentBudget = Math.max(0, this.state.governmentBudget - request.helpCost);
      this.residentRequestReputationDelta = clamp(this.residentRequestReputationDelta + rand(0.1, 0.3), -5, 5);
      if (agent) {
        agent.mood = clamp(agent.mood + rand(4, 8));
        agent.needs.wellbeing = clamp(agent.needs.wellbeing + rand(2, 5));
        if (request.need) {
          agent.needs[request.need] = clamp(agent.needs[request.need] + rand(6, 12));
        }
        if (request.category === "finance" || request.category === "work") {
          agent.money += request.helpCost;
        }
        this.syncResidentRequestAgent(agent);
      }
    } else if (action === "decline") {
      this.residentRequestReputationDelta = clamp(this.residentRequestReputationDelta - rand(0.1, 0.3), -5, 5);
      if (agent) {
        agent.mood = clamp(agent.mood - rand(2, 5));
        agent.needs.wellbeing = clamp(agent.needs.wellbeing - rand(1, 3));
        this.syncResidentRequestAgent(agent);
      }
    } else {
      this.residentRequests.splice(index, 0, request);
      throw new Error("UNKNOWN_RESIDENT_REQUEST_ACTION");
    }

    await this.persistState();
    return this.getResidentRequestsState();
  }

  getDailyDecisionsState() {
    this.refreshDailyDecreeStatuses();
    const activeDecrees = this.dailyDecrees.filter(decree => decree.status === "active");
    const eventCards = this.getDailyEventCards();
    const cardsBySide = new Map(eventCards.map(card => [card.side, card]));
    const chosenToday = this.dailyDecrees.find(decree => decree.issuedDay === this.state.gameDay) ?? null;
    return {
      currentDay: this.state.gameDay,
      actionPointsRemaining: this.state.actionPointsRemaining,
      actionPointsMax: this.state.actionPointsMax,
      dailySummary: this.getDailySummary(eventCards),
      hasChosenToday: chosenToday != null,
      chosenDecisionId: chosenToday?.decisionId ?? null,
      factionPressure: this.getFactionPressureState(eventCards),
      eventCards,
      decisions: DAILY_DECISION_CATALOG.map(definition => {
        const availability = this.getDecisionAvailability(definition);
        const card = cardsBySide.get(definition.side);
        return {
          ...definition,
          cardTitle: card?.title ?? definition.sideLabel,
          eventText: card?.eventText ?? definition.description,
          daySummary: card?.daySummary ?? "",
          tone: card?.tone ?? "warning",
          ...availability,
        };
      }),
      activeEffects: activeDecrees.flatMap(decree =>
        decree.effects.map(effect => ({
          id: `${decree.id}-${effect.kind}-${effect.label}`,
          decisionId: decree.decisionId,
          title: decree.title,
          label: effect.label,
          value: effect.value,
          startDay: decree.startDay,
          endDay: decree.endDay,
          remainingDays: Math.max(0, decree.endDay - this.state.gameDay + 1),
        })),
      ),
      pendingDecrees: this.dailyDecrees
        .filter(decree => decree.status === "pending")
        .sort((a, b) => a.startDay - b.startDay)
        .map(decree => this.serializeDecree(decree)),
      recentDecrees: this.dailyDecrees
        .slice()
        .sort((a, b) => b.issuedDay - a.issuedDay || b.id - a.id)
        .slice(0, 12)
        .map(decree => this.serializeDecree(decree)),
    };
  }

  private serializeDecree(decree: DailyDecreeRecord) {
    return {
      id: decree.id,
      decisionId: decree.decisionId,
      title: decree.title,
      description: decree.description,
      status: decree.status,
      issuedDay: decree.issuedDay,
      startDay: decree.startDay,
      endDay: decree.endDay,
      remainingDays: decree.status === "active" ? Math.max(0, decree.endDay - this.state.gameDay + 1) : 0,
      actionPointCost: decree.actionPointCost,
      budgetCost: decree.budgetCost,
      effects: decree.effects,
    };
  }

  private insertDailyDecreeRecord(record: Omit<DailyDecreeRecord, "id">): DailyDecreeRecord {
    const inserted = sqlite.prepare(`
      INSERT INTO daily_decrees (
        decision_id, title, description, status, issued_day, start_day, end_day,
        action_point_cost, budget_cost, cooldown_days, effects_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.decisionId,
      record.title,
      record.description,
      record.status,
      record.issuedDay,
      record.startDay,
      record.endDay,
      record.actionPointCost,
      record.budgetCost,
      record.cooldownDays,
      JSON.stringify(record.effects),
    ) as { lastInsertRowid?: number | bigint };

    return {
      ...record,
      id: Number(inserted.lastInsertRowid ?? 0),
    };
  }

  async issueDailyDecision(decisionId: string) {
    const definition = DAILY_DECISION_MAP.get(decisionId);
    if (!definition) {
      throw new Error("UNKNOWN_DECISION");
    }
    this.refreshDailyDecreeStatuses();
    const availability = this.getDecisionAvailability(definition);
    if (!availability.canIssue) {
      throw new Error(availability.unavailableReason ?? "DECISION_UNAVAILABLE");
    }

    const startDay = this.state.gameDay + definition.delayDays;
    const endDay = startDay + definition.durationDays - 1;
    const status: DailyDecreeStatus = this.state.gameDay < startDay ? "pending" : "active";
    this.state.actionPointsRemaining -= definition.actionPointCost;
    this.state.governmentBudget = Math.max(0, this.state.governmentBudget - definition.budgetCost);

    const record = this.insertDailyDecreeRecord({
      decisionId: definition.id,
      title: definition.title,
      description: definition.description,
      status,
      issuedDay: this.state.gameDay,
      startDay,
      endDay,
      actionPointCost: definition.actionPointCost,
      budgetCost: definition.budgetCost,
      cooldownDays: definition.cooldownDays,
      effects: definition.effects,
    });
    const sideEffectRecords = (definition.sideEffects ?? []).map(sideEffect => {
      const sideStartDay = this.state.gameDay + sideEffect.delayDays;
      const sideEndDay = sideStartDay + sideEffect.durationDays - 1;
      const sideStatus: DailyDecreeStatus = this.state.gameDay < sideStartDay ? "pending" : "active";
      return this.insertDailyDecreeRecord({
        decisionId: definition.id,
        title: `Побочный эффект: ${sideEffect.title}`,
        description: sideEffect.description,
        status: sideStatus,
        issuedDay: this.state.gameDay,
        startDay: sideStartDay,
        endDay: sideEndDay,
        actionPointCost: 0,
        budgetCost: 0,
        cooldownDays: 0,
        effects: sideEffect.effects,
      });
    });
    this.dailyDecrees.unshift(...sideEffectRecords);
    this.dailyDecrees.unshift(record);
    if (status === "active") {
      this.applyDailyDecisionEffects([record]);
    }
    const activeSideEffects = sideEffectRecords.filter(sideEffect => sideEffect.status === "active");
    if (activeSideEffects.length > 0) {
      this.applyDailyDecisionEffects(activeSideEffects);
    }
    this.completeFactionDemandForSide(definition.side);
    await this.persistState();
    return this.getDailyDecisionsState();
  }

  getSimulationState() {
    const { avgMood, avgWealth, unemploymentRate } = this.getAggregateStats();
    const gdp = Array.from(this.businesses.values()).reduce((s, b) => s + b.balance, 0);
    const goal = this.evaluateGoal(gdp);
    return {
      tick: this.state.tick,
      running: this.state.running,
      gameHour: this.state.gameHour,
      gameDay: this.state.gameDay,
      scenarioType: this.state.scenarioType,
      goalType: this.state.goalType,
      dayLimit: this.state.dayLimit,
      daysRemaining: Math.max(0, this.state.dayLimit - this.state.gameDay + 1),
      gameStatus: this.state.gameStatus,
      gameOutcomeReason: this.state.gameOutcomeReason,
      goalProgress: goal.progress,
      reputationResidents: goal.residentsScore,
      reputationBusiness: goal.businessScore,
      reputationGovernment: goal.governmentScore,
      actionPointsRemaining: this.state.actionPointsRemaining,
      actionPointsMax: this.state.actionPointsMax,
      population: this.agents.size,
      avgMood: Math.round(avgMood * 10) / 10,
      gdp: Math.round(gdp),
      unemploymentRate: Math.round(unemploymentRate * 10) / 10,
      governmentBudget: Math.round(this.state.governmentBudget * 100) / 100,
      totalTaxCollected: Math.round(this.state.totalTaxCollected * 100) / 100,
      totalSubsidiesPaid: Math.round(this.state.totalSubsidiesPaid * 100) / 100,
      totalPensionPaid: Math.round(this.state.totalPensionPaid * 100) / 100,
      totalPublicServicesPaid: Math.round(this.state.totalPublicServicesPaid * 100) / 100,
      avgWealth: Math.round(avgWealth * 100) / 100,
    };
  }

  getLastTickReport(): TickDebugReport | null {
    return this.lastTickReport;
  }

  getPopulationBreakdown() {
    const agents = Array.from(this.agents.values());
    const total = agents.length;

    const employed = agents.filter(a => a.employerId != null && !a.isRetired).length;
    const unemployed = agents.filter(a => a.employerId == null && !a.isRetired).length;
    const retired = agents.filter(a => !!a.isRetired).length;

    const youth  = agents.filter(a => a.age <= 30).length;
    const adult  = agents.filter(a => a.age >= 31 && a.age <= 50).length;
    const mature = agents.filter(a => a.age >= 51 && a.age <= 65).length;
    const elder  = agents.filter(a => a.age > 65).length;

    const personalityCounts: Record<string, number> = {};
    for (const a of agents) {
      personalityCounts[a.personality] = (personalityCounts[a.personality] ?? 0) + 1;
    }

    const actionCounts: Record<string, number> = {};
    for (const a of agents) {
      actionCounts[a.currentAction] = (actionCounts[a.currentAction] ?? 0) + 1;
    }

    return {
      total,
      byEmployment: { employed, unemployed, retired },
      byAge: { youth, adult, mature, elder },
      byPersonality: personalityCounts,
      byAction: actionCounts,
    };
  }

  getPopulationGroups(groupBy: "personality" | "employment" | "ageGroup") {
    const agents = Array.from(this.agents.values());
    const total = agents.length;

    const ACTION_RU: Record<string, string> = { work: "Работает", eat: "Ест", rest: "Отдыхает", socialize: "Общается", idle: "Простаивает" };

    const getGroupKey = (a: AgentState): string => {
      if (groupBy === "personality") return a.personality;
      if (groupBy === "employment") {
        if (a.isRetired) return "Пенсионеры";
        if (a.employerId != null) return "Работающие";
        return "Безработные";
      }
      if (a.age <= 30) return "18–30 (молодёжь)";
      if (a.age <= 50) return "31–50 (взрослые)";
      if (a.age <= 65) return "51–65 (зрелые)";
      return "66+ (пожилые)";
    };

    const groups = new Map<string, AgentState[]>();
    for (const a of agents) {
      const key = getGroupKey(a);
      const arr = groups.get(key) ?? [];
      arr.push(a);
      groups.set(key, arr);
    }

    const rows = Array.from(groups.entries()).map(([label, members]) => {
      const count = members.length;
      const avgMood  = members.reduce((s, a) => s + a.mood, 0) / count;
      const avgMoney = members.reduce((s, a) => s + a.money, 0) / count;
      const avgAge   = members.reduce((s, a) => s + a.age, 0) / count;
      const employedCount = members.filter(a => a.employerId != null && !a.isRetired).length;
      const actionFreq: Record<string, number> = {};
      for (const a of members) actionFreq[a.currentAction] = (actionFreq[a.currentAction] ?? 0) + 1;
      const topAction = Object.entries(actionFreq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "idle";
      return {
        label,
        count,
        pct: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
        avgMood:  Math.round(avgMood * 10) / 10,
        avgMoney: Math.round(avgMoney),
        avgAge:   Math.round(avgAge),
        employedCount,
        topAction: ACTION_RU[topAction] ?? topAction,
        topActionKey: topAction,
      };
    });

    rows.sort((a, b) => b.count - a.count);
    return { groupBy, total, groups: rows };
  }

  getAgents(page: number, limit: number, sortBy?: string, sortDir?: string, filterAction?: string) {
    let agents = Array.from(this.agents.values());
    if (filterAction) {
      agents = agents.filter(a => a.currentAction === filterAction);
    }
    if (sortBy && (AGENT_SORT_KEYS as readonly string[]).includes(sortBy)) {
      const key = sortBy as AgentSortKey;
      agents.sort((a, b) => {
        const aVal = a[key] ?? 0;
        const bVal = b[key] ?? 0;
        const cmp = typeof aVal === "string" ? (aVal as string).localeCompare(bVal as string) : (aVal as number) - (bVal as number);
        return sortDir === "desc" ? -cmp : cmp;
      });
    }
    const total = agents.length;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    return {
      agents: agents.slice(offset, offset + limit).map(a => ({
        id: a.id,
        name: a.name,
        gender: a.gender,
        age: a.age,
        mood: Math.round(a.mood * 10) / 10,
        money: Math.round(a.money * 100) / 100,
        personality: a.personality,
        socialization: a.socialization,
        currentAction: a.currentAction,
        employerId: a.employerId,
        isRetired: a.isRetired,
        careerLevel: a.careerLevel,
        jobTitle: GRADE_LABELS[a.careerLevel] ?? "Рабочий",
      })),
      total,
      page,
      limit,
      totalPages,
    };
  }

  getAgent(id: number) {
    const agent = this.agents.get(id);
    if (!agent) return null;
    return {
      id: agent.id,
      name: agent.name,
      gender: agent.gender,
      age: agent.age,
      mood: Math.round(agent.mood * 10) / 10,
      money: Math.round(agent.money * 100) / 100,
      personality: agent.personality,
      socialization: agent.socialization,
      currentAction: agent.currentAction,
      employerId: agent.employerId,
      isRetired: agent.isRetired,
      recentActions: [...agent.recentActions],
      jobHistory: [...agent.jobHistory].reverse().slice(0, 20),
      needs: {
        hunger: Math.round(agent.needs.hunger * 10) / 10,
        comfort: Math.round(agent.needs.comfort * 10) / 10,
        social: Math.round(agent.needs.social * 10) / 10,
        health: Math.round(agent.needs.health * 10) / 10,
        sleep: Math.round(agent.needs.sleep * 10) / 10,
        education: Math.round(agent.needs.education * 10) / 10,
        entertainment: Math.round(agent.needs.entertainment * 10) / 10,
        faith: Math.round(agent.needs.faith * 10) / 10,
        housingSafety: Math.round(agent.needs.housingSafety * 10) / 10,
        financialSafety: Math.round(agent.needs.financialSafety * 10) / 10,
        physicalSafety: Math.round(agent.needs.physicalSafety * 10) / 10,
        socialRating: Math.round(agent.needs.socialRating * 10) / 10,
        wellbeing: Math.round(agent.needs.wellbeing * 10) / 10,
      },
      // Career info
      employerName: agent.employerId ? (this.businesses.get(agent.employerId)?.name ?? null) : null,
      jobStartTick: agent.jobStartTick,
      jobTenure: agent.employerId && agent.jobStartTick != null ? this.state.tick - agent.jobStartTick : null,
      totalJobs: agent.jobHistory.filter(e => e.event === "hired").length,
      promotions: agent.jobHistory.filter(e => e.event === "promoted").length,
      careerLevel: agent.careerLevel,
      ambition: Math.round(agent.ambition),
      targetCareerLevel: targetGrade(agent.ambition),
      strength: Math.round((agent.strength ?? 50) * 10) / 10,
      intelligence: Math.round((agent.intelligence ?? 50) * 10) / 10,
    };
  }

  getAgentRelations(agentId: number) {
    const relMap = this.relations.get(agentId);
    if (!relMap) return [];
    const entries = Array.from(relMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    return entries.map(([otherId, friendshipLevel]) => {
      const other = this.agents.get(otherId);
      return {
        otherId,
        otherName: other?.name ?? `Агент ${otherId}`,
        friendshipLevel: Math.round(friendshipLevel * 10) / 10,
      };
    });
  }

  getBusinesses() {
    return Array.from(this.businesses.values()).map(b => ({
      id: b.id,
      name: b.name,
      type: b.type,
      balance: Math.round(b.balance * 100) / 100,
      productionRate: b.productionRate,
      employeeCount: b.employeeCount,
      maxEmployees: b.maxEmployees,
      ownerId: b.ownerId,
      firedThisTick: b.firedThisTick,
      hiredThisTick: b.hiredThisTick,
      productivityLevel: b.productivityLevel ?? 0,
    }));
  }

  getGoods() {
    return Array.from(this.goods.values()).map(g => ({
      id: g.id,
      name: g.name,
      basePrice: Math.round(g.basePrice * 100) / 100,
      currentPrice: Math.round(g.currentPrice * 100) / 100,
      quality: g.quality,
      demand: Math.round(g.demand * 10) / 10,
      supply: Math.round(g.supply * 10) / 10,
    }));
  }

  getNeedsStats() {
    const agents = Array.from(this.agents.values());
    const n = agents.length;
    if (n === 0) {
      const empty = { avg: 0, criticalPct: 0, lowPct: 0 };
      return {
        hunger: empty, comfort: empty, health: empty, sleep: empty,
        social: empty, education: empty, entertainment: empty, faith: empty,
        financialSafety: empty, housingSafety: empty, physicalSafety: empty, socialRating: empty,
        wellbeing: empty,
      };
    }
    type NeedKey = keyof typeof agents[0]["needs"];
    const keys: NeedKey[] = [
      "hunger", "comfort", "health", "sleep", "social", "education",
      "entertainment", "faith", "financialSafety", "housingSafety",
      "physicalSafety", "socialRating", "wellbeing",
    ];
    const result: Record<string, { avg: number; criticalPct: number; lowPct: number }> = {};
    for (const key of keys) {
      let sum = 0, critical = 0, low = 0;
      for (const a of agents) {
        const v = a.needs[key];
        sum += v;
        if (v < 25) critical++;
        else if (v < 50) low++;
      }
      result[key] = {
        avg: Math.round((sum / n) * 10) / 10,
        criticalPct: Math.round((critical / n) * 1000) / 10,
        lowPct: Math.round((low / n) * 1000) / 10,
      };
    }
    return result;
  }

  getGovernment() {
    const workingAge = Array.from(this.agents.values()).filter(a => !a.isRetired && a.age >= 18 && a.age <= 65);
    const unemployed = workingAge.filter(a => a.employerId == null);
    const unemploymentRate = workingAge.length > 0 ? unemployed.length / workingAge.length : 0;
    return {
      budget: Math.round(this.state.governmentBudget * 100) / 100,
      totalTaxCollected: Math.round(this.state.totalTaxCollected * 100) / 100,
      totalSubsidiesPaid: Math.round(this.state.totalSubsidiesPaid * 100) / 100,
      totalPensionPaid: Math.round(this.state.totalPensionPaid * 100) / 100,
      totalPublicServicesPaid: Math.round(this.state.totalPublicServicesPaid * 100) / 100,
      taxRate: this.config.taxRate,
      subsidyAmount: this.config.subsidyAmount,
      pensionRate: this.config.pensionRate,
      totalGrantsPaid: Math.round(this.totalGrantsPaid * 100) / 100,
      grantsIssuedLastDay: this.lastGrantsIssued,
      unemploymentRatePct: Math.round(unemploymentRate * 1000) / 10,
      grantThresholdPct: 28,
    };
  }

  getConfig(): SimulationConfig {
    return { ...this.config };
  }

  async updateConfig(updates: Partial<SimulationConfig>): Promise<SimulationConfig> {
    this.config = { ...this.config, ...updates };
    await this.saveConfig();
    if (this.state.running && updates.tickIntervalMs != null) {
      this.startTimer();
    }
    return this.config;
  }

  getStatsSummary() {
    const agents = Array.from(this.agents.values());
    const bizArr = Array.from(this.businesses.values());
    const goodsArr = Array.from(this.goods.values());
    const marketBalance = bizArr.reduce((s, b) => s + b.balance, 0);
    const profitableBusinesses = bizArr.filter(b => b.balance > 0).length;
    const unprofitableBusinesses = bizArr.filter(b => b.balance < 0).length;
    const totalDemand = goodsArr.reduce((s, g) => s + g.demand, 0);
    const totalSupply = goodsArr.reduce((s, g) => s + g.supply, 0);
    if (agents.length === 0) {
      return {
        totalAgents: 0,
        totalBusinesses: this.businesses.size,
        totalGoods: this.goods.size,
        employedAgents: 0,
        unemployedAgents: 0,
        avgMood: 0,
        avgWealth: 0,
        avgHealth: 0,
        avgSleep: 0,
        gdp: 0,
        richestAgent: null,
        happiestAgent: null,
        mostPopularGood: null,
        birthsLastTick: this.lastBirths,
        deathsLastTick: this.lastDeaths,
        immigrantsLastTick: this.lastImmigrants,
        emigrantsLastTick: this.lastEmigrants,
        profitableBusinesses,
        unprofitableBusinesses,
        marketBalance: Math.round(marketBalance),
        totalDemand: Math.round(totalDemand),
        totalSupply: Math.round(totalSupply),
      };
    }
    const employed = agents.filter(a => a.employerId != null);
    const avgMood = agents.reduce((s, a) => s + a.mood, 0) / agents.length;
    const avgWealth = agents.reduce((s, a) => s + a.money, 0) / agents.length;
    const avgHealth = agents.reduce((s, a) => s + a.needs.health, 0) / agents.length;
    const avgSleep = agents.reduce((s, a) => s + a.needs.sleep, 0) / agents.length;
    const richest = agents.reduce((max, a) => a.money > max.money ? a : max, agents[0]);
    const happiest = agents.reduce((max, a) => a.mood > max.mood ? a : max, agents[0]);
    const goodsSorted = [...goodsArr].sort((a, b) => b.demand - a.demand);
    return {
      totalAgents: agents.length,
      totalBusinesses: this.businesses.size,
      totalGoods: this.goods.size,
      employedAgents: employed.length,
      unemployedAgents: agents.length - employed.length,
      avgMood: Math.round(avgMood * 10) / 10,
      avgWealth: Math.round(avgWealth * 100) / 100,
      avgHealth: Math.round(avgHealth * 10) / 10,
      avgSleep: Math.round(avgSleep * 10) / 10,
      gdp: Math.round(marketBalance),
      richestAgent: richest?.name ?? null,
      happiestAgent: happiest?.name ?? null,
      mostPopularGood: goodsSorted[0]?.name ?? null,
      birthsLastTick: this.lastBirths,
      deathsLastTick: this.lastDeaths,
      immigrantsLastTick: this.lastImmigrants,
      emigrantsLastTick: this.lastEmigrants,
      profitableBusinesses,
      unprofitableBusinesses,
      marketBalance: Math.round(marketBalance),
      totalDemand: Math.round(totalDemand),
      totalSupply: Math.round(totalSupply),
    };
  }

  getTopAgents(limit = 10) {
    const agents = Array.from(this.agents.values());
    const n = Math.max(1, Math.min(100, limit));
    const mapAgent = (a: AgentState) => ({
      id: a.id, name: a.name, gender: a.gender, age: a.age,
      mood: Math.round(a.mood * 10) / 10, money: Math.round(a.money * 100) / 100,
      personality: a.personality, socialization: Math.round(a.socialization * 10) / 10,
      currentAction: a.currentAction, employerId: a.employerId,
    });
    const byWealth = [...agents].sort((a, b) => b.money - a.money).slice(0, n).map(mapAgent);
    const byMood = [...agents].sort((a, b) => b.mood - a.mood).slice(0, n).map(mapAgent);
    const byAge = [...agents].sort((a, b) => b.age - a.age).slice(0, n).map(mapAgent);
    const bySocialization = [...agents].sort((a, b) => b.socialization - a.socialization).slice(0, n).map(mapAgent);
    return { byWealth, byMood, byAge, bySocialization };
  }

  getAgentStatHistory(id: number): AgentStatSnapshot[] {
    return this.agentStatHistory.get(id) ?? [];
  }
}

export const simulationEngine = new SimulationEngine();
