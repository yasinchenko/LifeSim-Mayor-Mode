import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type Language = "ru" | "en";

const STORAGE_KEY = "lifesim_language";

type Dictionary = {
  menu: {
    title: string;
    subtitle: string;
    newGame: string;
    continueGame: string;
    loadGame: string;
    settings: string;
    simulationSettings: string;
    exit: string;
    exitHint: string;
    scenario: string;
    goal: string;
    dayLimit: string;
    start: string;
    saves: string;
    load: string;
    delete: string;
    saveNow: string;
    quickSave: string;
    language: string;
    back: string;
    loading: string;
  };
  layout: {
    city: string;
    residents: string;
    economy: string;
    government: string;
    settings: string;
    simulationSettings: string;
  };
  game: {
    save: string;
    saved: string;
    saveFailed: string;
    saving: string;
  };
  dashboard: {
    menu: string;
    metrics: string;
    party: string;
    running: string;
    paused: string;
    pause: string;
    start: string;
    day: string;
    loading: string;
    cityLoading: string;
    residents: string;
    economy: string;
    government: string;
    balancedGoal: string;
    crisisRecoveryGoal: string;
    economicGrowthGoal: string;
    marketGrowthGoal: string;
    socialStabilityGoal: string;
    forceOrderGoal: string;
    corruptionNetworkGoal: string;
    balancedScenario: string;
    crisisScenario: string;
    growthScenario: string;
    stabilityScenario: string;
    cityStatus: string;
    society: string;
    goalProgress: string;
    daysRemaining: string;
    factionPressure: string;
    scenario: string;
    scenarioNote: string;
    detailedMetrics: string;
    detailedMetricsDescription: string;
    population: string;
    mood: string;
    gdp: string;
    budget: string;
    unemployment: string;
    health: string;
    businesses: string;
    migration: string;
  };
};

const DICTIONARY: Record<Language, Dictionary> = {
  ru: {
    menu: {
      title: "LifeSim Mayor Mode",
      subtitle: "Город ждёт вашего мандата",
      newGame: "Новая игра",
      continueGame: "Продолжить",
      loadGame: "Загрузить",
      settings: "Настройки",
      simulationSettings: "Параметры города",
      exit: "Выход",
      exitHint: "В web-версии можно закрыть вкладку или окно приложения.",
      scenario: "Сценарий",
      goal: "Цель",
      dayLimit: "Лимит дней",
      start: "Начать",
      saves: "Сохранения",
      load: "Загрузить",
      delete: "Удалить",
      saveNow: "Сохранить текущую партию",
      quickSave: "Сохранение",
      language: "Язык",
      back: "Назад",
      loading: "Загрузка...",
    },
    layout: {
      city: "К городу",
      residents: "Жители",
      economy: "Экономика",
      government: "Государство",
      settings: "Настройки игры",
      simulationSettings: "Параметры города",
    },
    game: {
      save: "Сохранить",
      saved: "Игра сохранена",
      saveFailed: "Не удалось сохранить игру",
      saving: "Сохранение...",
    },
    dashboard: {
      menu: "Меню",
      metrics: "Метрики",
      party: "Партия",
      running: "Город живёт",
      paused: "Пауза",
      pause: "Пауза",
      start: "Пуск",
      day: "День",
      loading: "Загрузка",
      cityLoading: "Город загружается...",
      residents: "Жители",
      economy: "Экономика",
      government: "Государство",
      balancedGoal: "Баланс интересов",
      crisisRecoveryGoal: "Выход из кризиса",
      economicGrowthGoal: "Рост экономики",
      marketGrowthGoal: "Рыночная стратегия",
      socialStabilityGoal: "Социальная стратегия",
      forceOrderGoal: "Силовая стратегия",
      corruptionNetworkGoal: "Коррупционная стратегия",
      balancedScenario: "Сбалансированный город",
      crisisScenario: "Кризисный мандат",
      growthScenario: "Экономический рывок",
      stabilityScenario: "Социальная устойчивость",
      cityStatus: "Состояние города",
      society: "Общество",
      goalProgress: "Прогресс цели",
      daysRemaining: "Дней осталось",
      factionPressure: "Давление фракций",
      scenario: "Сценарий",
      scenarioNote: "Решения дня меняют город не сразу: часть эффектов запускается через несколько дней.",
      detailedMetrics: "Подробные метрики города",
      detailedMetricsDescription: "Полная аналитика вынесена сюда, чтобы главный экран оставался игровым.",
      population: "Население",
      mood: "Настроение",
      gdp: "ВВП",
      budget: "Бюджет",
      unemployment: "Безработица",
      health: "Здоровье",
      businesses: "Бизнесы",
      migration: "Миграция",
    },
  },
  en: {
    menu: {
      title: "LifeSim Mayor Mode",
      subtitle: "The city is waiting for your mandate",
      newGame: "New Game",
      continueGame: "Continue",
      loadGame: "Load",
      settings: "Settings",
      simulationSettings: "City settings",
      exit: "Exit",
      exitHint: "In the web version you can close the tab or app window.",
      scenario: "Scenario",
      goal: "Goal",
      dayLimit: "Day limit",
      start: "Start",
      saves: "Saves",
      load: "Load",
      delete: "Delete",
      saveNow: "Save current game",
      quickSave: "Save",
      language: "Language",
      back: "Back",
      loading: "Loading...",
    },
    layout: {
      city: "To city",
      residents: "Residents",
      economy: "Economy",
      government: "Government",
      settings: "Game settings",
      simulationSettings: "City settings",
    },
    game: {
      save: "Save",
      saved: "Game saved",
      saveFailed: "Could not save game",
      saving: "Saving...",
    },
    dashboard: {
      menu: "Menu",
      metrics: "Metrics",
      party: "Game",
      running: "City running",
      paused: "Paused",
      pause: "Pause",
      start: "Start",
      day: "Day",
      loading: "Loading",
      cityLoading: "City is loading...",
      residents: "Residents",
      economy: "Economy",
      government: "Government",
      balancedGoal: "Balance of interests",
      crisisRecoveryGoal: "Crisis recovery",
      economicGrowthGoal: "Economic growth",
      marketGrowthGoal: "Market strategy",
      socialStabilityGoal: "Social strategy",
      forceOrderGoal: "Force strategy",
      corruptionNetworkGoal: "Corruption strategy",
      balancedScenario: "Balanced city",
      crisisScenario: "Crisis mandate",
      growthScenario: "Economic leap",
      stabilityScenario: "Social stability",
      cityStatus: "City status",
      society: "Society",
      goalProgress: "Goal progress",
      daysRemaining: "Days remaining",
      factionPressure: "Faction pressure",
      scenario: "Scenario",
      scenarioNote: "Daily decisions do not change the city instantly: some effects start after several days.",
      detailedMetrics: "Detailed city metrics",
      detailedMetricsDescription: "Full analytics live here so the main screen can stay focused on play.",
      population: "Population",
      mood: "Mood",
      gdp: "GDP",
      budget: "Budget",
      unemployment: "Unemployment",
      health: "Health",
      businesses: "Businesses",
      migration: "Migration",
    },
  },
};

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: Dictionary;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: "ru",
  setLanguage: () => {},
  t: DICTIONARY.ru,
});

function getStoredLanguage(): Language {
  try {
    return localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "ru";
  } catch {
    return "ru";
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => getStoredLanguage());
  const value = useMemo<LanguageContextValue>(() => ({
    language,
    setLanguage: nextLanguage => {
      localStorage.setItem(STORAGE_KEY, nextLanguage);
      setLanguageState(nextLanguage);
    },
    t: DICTIONARY[language],
  }), [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext);
}
