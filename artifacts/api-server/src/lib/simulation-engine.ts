import { db } from "@workspace/db";
import {
  agentsTable,
  needsTable,
  relationsTable,
  businessesTable,
  goodsTable,
  simStateTable,
  simConfigTable,
  statsHistoryTable,
  agentStatHistoryTable,
  type Agent,
  type Needs,
  type Business,
  type Good,
} from "@workspace/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";
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

interface AgentState extends Agent {
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
  governmentBudget: number;
  totalTaxCollected: number;
  totalSubsidiesPaid: number;
  totalPensionPaid: number;
  totalPublicServicesPaid: number;
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

  async initialize(): Promise<void> {
    logger.info("Initializing simulation engine...");
    await this.loadConfig();
    await this.loadState();
    await this.loadAgents();
    await this.loadBusinesses();
    await this.loadGoods();
    await this.loadRelations();
    await this.loadAgentStatHistory();

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
        governmentBudget: Math.max(0, row.governmentBudget),
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
    const needsMap = new Map<number, { hunger: number; comfort: number; social: number; health: number; sleep: number; education: number; entertainment: number; faith: number; housingSafety: number; financialSafety: number; physicalSafety: number; socialRating: number; id: number }>();
    for (const n of needsRows) {
      needsMap.set(n.agentId, {
        hunger: n.hunger, comfort: n.comfort, social: n.social,
        health: n.health ?? 80, sleep: n.sleep ?? 80,
        education: n.education ?? 70, entertainment: n.entertainment ?? 70, faith: n.faith ?? 60,
        housingSafety: n.housingSafety ?? 80,
        financialSafety: n.financialSafety ?? 80,
        physicalSafety: n.physicalSafety ?? 80,
        socialRating: n.socialRating ?? 50,
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
    const rows = await db.execute(sql`
      SELECT agent_id, tick, money, mood, age, socialization
      FROM (
        SELECT agent_id, tick, money, mood, age, socialization,
               ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY tick DESC) AS rn
        FROM agent_stat_history
      ) ranked
      WHERE rn <= ${AGENT_STAT_HISTORY_MAX}
      ORDER BY agent_id, tick ASC
    `);
    for (const row of rows.rows) {
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
    void db.execute(sql`
      DELETE FROM agent_stat_history
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY tick DESC) AS rn
          FROM agent_stat_history
        ) ranked
        WHERE rn <= ${AGENT_STAT_HISTORY_MAX}
      )
    `).catch(err => logger.warn({ err }, "Background agent_stat_history cleanup failed"));
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

  async reset(): Promise<void> {
    await this.stop();
    await this.waitForTickComplete();
    logger.info("Resetting simulation...");

    // Use TRUNCATE for fast bulk-delete — much faster than DELETE on large tables
    // CASCADE handles FK dependencies automatically; RESTART IDENTITY resets serial PKs
    await db.execute(sql`
      TRUNCATE TABLE
        stats_history,
        agent_stat_history,
        relations,
        needs,
        agents,
        goods,
        businesses
      RESTART IDENTITY CASCADE
    `);

    this.agents.clear();
    this.businesses.clear();
    this.goods.clear();
    this.relations.clear();
    this.dirtyRelations.clear();
    this.persistedRelations.clear();
    this.agentStatHistory.clear();

    this.state = {
      tick: 0,
      running: false,
      gameHour: 0,
      gameDay: 1,
      governmentBudget: 200000,
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

    const { taxRate, needDecayRate, subsidyAmount, baseSalary, socialInteractionStrength, pensionRate } = this.config;

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

    const isNewDay = this.state.gameHour === 0;
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
    const bizGradeCount = new Map<string, Map<number, number>>();
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
        const hasVacancy = (bizId: string, bizType: string, toGrade: number): boolean => {
          const slots = STAFFING_TABLE[bizType]?.[toGrade] ?? 0;
          if (slots <= 0) return false;
          const occupied = bizGradeCount.get(bizId)?.get(toGrade) ?? 0;
          return occupied < slots;
        };

        // Обновляем карту грейдов: агент переходит с fromGrade на toGrade в данном бизнесе.
        const recordPromotion = (bizId: string, fromGrade: number, toGrade: number): void => {
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

    // --- Bulk update agents in one SQL query ---
    const agentUpdateP = agentArray.length > 0
      ? db.execute(sql`
          UPDATE agents AS t SET
            age             = v.age::int,
            mood            = v.mood::float8,
            money           = v.money::float8,
            current_action  = v.current_action::text,
            employer_id     = v.employer_id::int,
            is_retired      = v.is_retired::boolean,
            job_history     = v.job_history::text,
            career_level    = v.career_level::int,
            ambition        = v.ambition::float8,
            strength        = v.strength::float8,
            intelligence    = v.intelligence::float8
          FROM (VALUES ${sql.join(
            agentArray.map(a => sql`(${a.id},${a.age},${a.mood},${a.money},${a.currentAction},${a.employerId ?? null},${a.isRetired},${JSON.stringify(a.jobHistory.slice(-50))},${a.careerLevel},${a.ambition},${a.strength ?? 50},${a.intelligence ?? 50})`),
            sql.raw(',')
          )}) AS v(id, age, mood, money, current_action, employer_id, is_retired, job_history, career_level, ambition, strength, intelligence)
          WHERE t.id = v.id::int
        `)
      : Promise.resolve();

    // --- Bulk update needs in one SQL query ---
    const needsUpdateP = agentArray.length > 0
      ? db.execute(sql`
          UPDATE needs AS t SET
            hunger           = v.hunger::float8,
            comfort          = v.comfort::float8,
            social           = v.social::float8,
            health           = v.health::float8,
            sleep            = v.sleep::float8,
            education        = v.education::float8,
            entertainment    = v.entertainment::float8,
            faith            = v.faith::float8,
            housing_safety   = v.housing_safety::float8,
            financial_safety = v.financial_safety::float8,
            physical_safety  = v.physical_safety::float8,
            social_rating    = v.social_rating::float8,
            wellbeing        = v.wellbeing::float8
          FROM (VALUES ${sql.join(
            agentArray.map(a => sql`(${a.id},${a.needs.hunger},${a.needs.comfort},${a.needs.social},${a.needs.health},${a.needs.sleep},${a.needs.education},${a.needs.entertainment},${a.needs.faith},${a.needs.housingSafety},${a.needs.financialSafety},${a.needs.physicalSafety},${a.needs.socialRating},${a.needs.wellbeing})`),
            sql.raw(',')
          )}) AS v(agent_id, hunger, comfort, social, health, sleep, education, entertainment, faith, housing_safety, financial_safety, physical_safety, social_rating, wellbeing)
          WHERE t.agent_id = v.agent_id::int
        `)
      : Promise.resolve();

    // --- Bulk update goods in one SQL query ---
    const goodsUpdateP = goodsArray.length > 0
      ? db.execute(sql`
          UPDATE goods AS t SET
            current_price = v.current_price::float8,
            demand        = v.demand::float8,
            supply        = v.supply::float8,
            quality       = v.quality::float8
          FROM (VALUES ${sql.join(
            goodsArray.map(g => sql`(${g.id},${g.currentPrice},${g.demand},${g.supply},${g.quality})`),
            sql.raw(',')
          )}) AS v(id, current_price, demand, supply, quality)
          WHERE t.id = v.id::int
        `)
      : Promise.resolve();

    // --- Bulk update businesses in one SQL query ---
    const bizUpdateP = bizArray.length > 0
      ? db.execute(sql`
          UPDATE businesses AS t SET
            balance           = v.balance::float8,
            productivity_level = v.productivity_level::int
          FROM (VALUES ${sql.join(
            bizArray.map(b => sql`(${b.id},${b.balance},${b.productivityLevel ?? 0})`),
            sql.raw(',')
          )}) AS v(id, balance, productivity_level)
          WHERE t.id = v.id::int
        `)
      : Promise.resolve();

    // --- Bulk sync dirty relations (split new vs existing) ---
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
    const relNewP = newRelRows.length > 0
      ? db.insert(relationsTable).values(newRelRows)
      : Promise.resolve();
    const relUpdateP = existingRelRows.length > 0
      ? db.execute(sql`
          UPDATE relations AS t SET friendship_level = v.lvl::float8
          FROM (VALUES ${sql.join(
            existingRelRows.map(r => sql`(${r.agentIdA},${r.agentIdB},${r.friendshipLevel})`),
            sql.raw(',')
          )}) AS v(a, b, lvl)
          WHERE t.agent_id_a = v.a::int AND t.agent_id_b = v.b::int
        `)
      : Promise.resolve();
    const relUpsertP = Promise.all([relNewP, relUpdateP]);

    // Run table updates sequentially (agents first, then needs) to prevent
    // row-level lock contention / deadlocks from concurrent large UPDATEs.
    // Small tables (goods, businesses, relations) run in parallel after agents.
    await agentUpdateP;
    await needsUpdateP;
    await Promise.all([goodsUpdateP, bizUpdateP, relUpsertP]);

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
      const agentIds = dbRows.map(r => r.agentId);
      void db.execute(sql`
        DELETE FROM agent_stat_history
        WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY tick DESC) AS rn
            FROM agent_stat_history
            WHERE agent_id = ANY(${agentIds}::int[])
          ) ranked
          WHERE rn > ${AGENT_STAT_HISTORY_MAX}
        )
      `).catch(() => {});
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

  getSimulationState() {
    const { avgMood, avgWealth, unemploymentRate } = this.getAggregateStats();
    const gdp = Array.from(this.businesses.values()).reduce((s, b) => s + b.balance, 0);
    return {
      tick: this.state.tick,
      running: this.state.running,
      gameHour: this.state.gameHour,
      gameDay: this.state.gameDay,
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
