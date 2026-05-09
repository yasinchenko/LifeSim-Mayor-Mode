export type DistrictCategory = "society" | "economy" | "government";
export type DistrictServiceType = "utility" | "police" | "fire";
export type DistrictInvestmentType = "beautification" | "safety" | "infrastructure" | "business_zone" | "social_support";
export type DistrictIncidentType = "fire" | "protest" | "utility_failure" | "staff_quit";
export type DistrictIncidentStatus = "active" | "resolved" | "ignored" | "expired";

export interface DistrictMetrics {
  safety: number;
  comfort: number;
  accidentRisk: number;
  mayorReputationResidents: number;
  businessTrust: number;
  poverty: number;
  infrastructure: number;
}

export type DistrictMetricOverrides = Partial<DistrictMetrics>;

export interface DistrictInvestmentEffect {
  residents: number;
  business: number;
  government: number;
}

export interface DistrictInvestmentDefinition {
  type: DistrictInvestmentType;
  label: string;
  cost: number;
  targetMetric: keyof DistrictMetrics;
  metricDelta: number;
  reputationEffect: DistrictInvestmentEffect;
}

export interface DistrictHiringQueueItem {
  service: DistrictServiceType;
  count: number;
  ticksRemaining: number;
}

export interface DistrictServiceStaff {
  utilityWorkers: number;
  policeOfficers: number;
  firefighters: number;
}

export interface DistrictServiceExpenses {
  utility: number;
  police: number;
  fire: number;
  salaries: number;
  inventory: number;
  total: number;
}

export interface DistrictServiceState {
  utilityWorkers: number;
  policeOfficers: number;
  firefighters: number;
  hiringQueue: DistrictHiringQueueItem[];
  ticksUntilNextStaff: number | null;
  expenses: DistrictServiceExpenses;
}

export interface DistrictIncident {
  id: string;
  districtId: string;
  type: DistrictIncidentType;
  status: DistrictIncidentStatus;
  createdTick: number;
  createdDay: number;
  deadlineTick: number;
  deadlineDay: number;
  severity: number;
  requiredService: DistrictServiceType | null;
  basePenalty: number;
  ignoredPenalty: number;
}

interface DistrictDefinition {
  id: string;
  name: string;
  category: DistrictCategory;
  mapX: string;
  mapY: string;
  boundaryPoints: string;
  metrics: DistrictMetrics;
  serviceStaff: DistrictServiceStaff;
  hiringQueue?: DistrictHiringQueueItem[];
}

export interface District extends Omit<DistrictDefinition, "serviceStaff" | "hiringQueue"> {
  services: DistrictServiceState;
  incidents: DistrictIncident[];
}

export const DISTRICT_INVESTMENTS: readonly DistrictInvestmentDefinition[] = [
  {
    type: "beautification",
    label: "Благоустройство",
    cost: 4200,
    targetMetric: "comfort",
    metricDelta: 6,
    reputationEffect: { residents: 1.2, business: 0.2, government: 0.4 },
  },
  {
    type: "safety",
    label: "Безопасность",
    cost: 5200,
    targetMetric: "safety",
    metricDelta: 6,
    reputationEffect: { residents: 0.9, business: 0.3, government: 0.7 },
  },
  {
    type: "infrastructure",
    label: "Инфраструктура",
    cost: 6400,
    targetMetric: "infrastructure",
    metricDelta: 7,
    reputationEffect: { residents: 0.6, business: 0.8, government: 0.6 },
  },
  {
    type: "business_zone",
    label: "Бизнес-зона",
    cost: 5600,
    targetMetric: "businessTrust",
    metricDelta: 7,
    reputationEffect: { residents: -0.2, business: 1.4, government: 0.4 },
  },
  {
    type: "social_support",
    label: "Соцподдержка",
    cost: 4600,
    targetMetric: "poverty",
    metricDelta: -6,
    reputationEffect: { residents: 1.3, business: -0.2, government: 0.3 },
  },
];

export const DISTRICTS: readonly DistrictDefinition[] = [
  {
    id: "residential",
    name: "Кварталы",
    category: "society",
    mapX: "60%",
    mapY: "43%",
    boundaryPoints: "1480,360 1875,345 2155,500 2065,720 1610,805 1345,625",
    metrics: {
      safety: 58,
      comfort: 62,
      accidentRisk: 38,
      mayorReputationResidents: 55,
      businessTrust: 42,
      poverty: 46,
      infrastructure: 56,
    },
    serviceStaff: {
      utilityWorkers: 4,
      policeOfficers: 3,
      firefighters: 2,
    },
  },
  {
    id: "city-hall",
    name: "Ратуша",
    category: "government",
    mapX: "39%",
    mapY: "48%",
    boundaryPoints: "820,515 1095,425 1335,555 1355,730 1195,865 905,800 740,665",
    metrics: {
      safety: 66,
      comfort: 58,
      accidentRisk: 26,
      mayorReputationResidents: 52,
      businessTrust: 54,
      poverty: 32,
      infrastructure: 64,
    },
    serviceStaff: {
      utilityWorkers: 3,
      policeOfficers: 5,
      firefighters: 2,
    },
  },
  {
    id: "business",
    name: "Деловой район",
    category: "economy",
    mapX: "83%",
    mapY: "27%",
    boundaryPoints: "2110,145 2790,145 2865,360 2685,555 2240,505 2045,335",
    metrics: {
      safety: 63,
      comfort: 52,
      accidentRisk: 31,
      mayorReputationResidents: 43,
      businessTrust: 68,
      poverty: 24,
      infrastructure: 70,
    },
    serviceStaff: {
      utilityWorkers: 5,
      policeOfficers: 4,
      firefighters: 3,
    },
  },
  {
    id: "market",
    name: "Рынок",
    category: "economy",
    mapX: "35%",
    mapY: "62%",
    boundaryPoints: "675,875 1065,855 1385,930 1520,1110 1295,1240 820,1165 565,1005",
    metrics: {
      safety: 51,
      comfort: 57,
      accidentRisk: 43,
      mayorReputationResidents: 49,
      businessTrust: 61,
      poverty: 39,
      infrastructure: 55,
    },
    serviceStaff: {
      utilityWorkers: 3,
      policeOfficers: 3,
      firefighters: 2,
    },
  },
  {
    id: "services",
    name: "Службы",
    category: "society",
    mapX: "20%",
    mapY: "56%",
    boundaryPoints: "45,250 445,165 755,330 705,580 525,805 170,790 35,600",
    metrics: {
      safety: 60,
      comfort: 54,
      accidentRisk: 35,
      mayorReputationResidents: 50,
      businessTrust: 45,
      poverty: 41,
      infrastructure: 59,
    },
    serviceStaff: {
      utilityWorkers: 6,
      policeOfficers: 4,
      firefighters: 4,
    },
  },
];

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildServiceState(
  serviceStaff: DistrictServiceStaff,
  hiringQueue: DistrictHiringQueueItem[] | undefined,
  baseSalary: number,
): DistrictServiceState {
  const queue = (hiringQueue ?? []).map(item => ({ ...item }));
  const utilitySalaries = serviceStaff.utilityWorkers * baseSalary;
  const policeSalaries = serviceStaff.policeOfficers * baseSalary;
  const fireSalaries = serviceStaff.firefighters * baseSalary;
  const salaries = utilitySalaries + policeSalaries + fireSalaries;
  const inventory = salaries * 0.1;

  return {
    ...serviceStaff,
    hiringQueue: queue,
    ticksUntilNextStaff: queue.length > 0 ? Math.min(...queue.map(item => item.ticksRemaining)) : null,
    expenses: {
      utility: roundMoney(utilitySalaries * 1.1),
      police: roundMoney(policeSalaries * 1.1),
      fire: roundMoney(fireSalaries * 1.1),
      salaries: roundMoney(salaries),
      inventory: roundMoney(inventory),
      total: roundMoney(salaries + inventory),
    },
  };
}

export function getDistricts(baseSalary: number): District[] {
  return getDistrictsWithServices(baseSalary);
}

export function getDistrictsWithServices(
  baseSalary: number,
  serviceStates?: Map<string, { staff: DistrictServiceStaff; hiringQueue: DistrictHiringQueueItem[] }>,
  incidentsByDistrict?: Map<string, DistrictIncident[]>,
  metricOverridesByDistrict?: Map<string, DistrictMetricOverrides>,
): District[] {
  return DISTRICTS.map(district => {
    const overrides = metricOverridesByDistrict?.get(district.id) ?? {};
    return {
      id: district.id,
      name: district.name,
      category: district.category,
      mapX: district.mapX,
      mapY: district.mapY,
      boundaryPoints: district.boundaryPoints,
      metrics: { ...district.metrics, ...overrides },
      services: buildServiceState(
        serviceStates?.get(district.id)?.staff ?? district.serviceStaff,
        serviceStates?.get(district.id)?.hiringQueue ?? district.hiringQueue,
        baseSalary,
      ),
      incidents: (incidentsByDistrict?.get(district.id) ?? []).map(incident => ({ ...incident })),
    };
  });
}

export function getDistrictById(
  id: string,
  baseSalary: number,
  serviceStates?: Map<string, { staff: DistrictServiceStaff; hiringQueue: DistrictHiringQueueItem[] }>,
  incidentsByDistrict?: Map<string, DistrictIncident[]>,
  metricOverridesByDistrict?: Map<string, DistrictMetricOverrides>,
): District | undefined {
  return getDistrictsWithServices(baseSalary, serviceStates, incidentsByDistrict, metricOverridesByDistrict).find(district => district.id === id);
}
