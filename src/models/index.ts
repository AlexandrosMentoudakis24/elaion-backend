export const SOIL_TYPES = ["Clay-loam", "Sandy", "Limestone", "Silty", "Rocky", "Loam"] as const;
export type SoilType = (typeof SOIL_TYPES)[number];

export const IRRIGATION_TYPES = ["Drip", "Rain-fed", "Sprinkler", "Flood", "Mixed"] as const;
export type IrrigationType = (typeof IRRIGATION_TYPES)[number];

export const HARVEST_STATUSES = ["Completed", "In Progress"] as const;
export type HarvestStatus = (typeof HARVEST_STATUSES)[number];

export const EXPENSE_CATEGORIES = [
  "Milling",
  "Equipment",
  "Transport",
  "Pesticides",
  "Electricity",
  "Watering",
  "Labor",
  "Other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export interface User {
  username: string;
  password: string;
  name: string;
  role: string;
}

export type UserCreate = {
  username: string;
  password: string;
  name?: string;
  role?: string;
};

export interface UserRecord extends User {
  id: number;
  /** Bumped on password/role/username changes; outstanding tokens die. */
  tokenVersion?: number;
}

export type UserProfile = Omit<UserRecord, "id" | "password" | "tokenVersion">;

export interface AuthLoginRequest {
  username: string;
  password: string;
}

export interface AuthRefreshRequest {
  token: string;
}

export interface AuthLoginResponse {
  token: string;
  user: UserProfile;
}

export interface Field {
  id: number;
  name: string;
  area: number;
  trees: number;
  variety: string;
  location: string;
  soil: SoilType;
  irrigation: IrrigationType;
  notes: string;
}

export type FieldCreate = {
  name: string;
  area: number;
  trees: number;
  variety: string;
  location: string;
  soil?: SoilType;
  irrigation?: IrrigationType;
  notes?: string;
};

export interface Employee {
  id: number;
  name: string;
  role: string;
  phone: string;
  email: string | null;
  notes: string | null;
}

export type EmployeeCreate = {
  name: string;
  role: string;
  phone?: string;
  email?: string | null;
  notes?: string | null;
};

export interface Harvest {
  id: number;
  year: number;
  name: string;
  status: HarvestStatus;
  startDate: string;
  endDate: string | null;
  notes: string;
  weather: string;
}

export type HarvestCreate = {
  year: number;
  name: string;
  status?: HarvestStatus;
  startDate: string;
  endDate?: string | null;
  notes?: string;
  weather?: string;
};

export interface WorkerPay {
  employeeId: number;
  pay: number;
}

export interface HarvestDay {
  id: number;
  harvestId: number;
  date: string;
  fieldId: number;
  sacks: number;
  workers: WorkerPay[];
  notes: string;
}

export type HarvestDayCreate = {
  harvestId: number;
  date: string;
  fieldId: number;
  sacks: number;
  workers?: WorkerPay[];
  notes?: string;
};

export interface Grind {
  id: number;
  harvestId: number;
  date: string;
  factoryName: string;
  olivesKg: number;
  oilProducedL: number;
  taxKeptL: number;
  acidity: number;
  notes: string;
}

export type GrindCreate = {
  harvestId: number;
  date: string;
  factoryName: string;
  olivesKg: number;
  oilProducedL: number;
  taxKeptL?: number;
  acidity?: number;
  notes?: string;
};

export interface Sale {
  id: number;
  harvestId: number;
  date: string;
  buyerName: string;
  oilL: number;
  pricePerL: number;
  notes: string;
}

export type SaleCreate = {
  harvestId: number;
  date: string;
  buyerName: string;
  oilL: number;
  pricePerL: number;
  notes?: string;
};

export interface Expense {
  id: number;
  harvestId: number;
  date: string;
  category: ExpenseCategory;
  description: string;
  amount: number;
}

export type ExpenseCreate = {
  harvestId: number;
  date: string;
  category?: ExpenseCategory;
  description: string;
  amount: number;
};

export const Collections = {
  Users: "users",
  Fields: "fields",
  Employees: "employees",
  Harvests: "harvests",
  HarvestDays: "harvest_days",
  Grinds: "grinds",
  Sales: "sales",
  Expenses: "expenses",
  Counters: "counters",
  RevokedTokens: "revoked_tokens",
  IdempotencyKeys: "idempotency_keys",
  AuditLogs: "audit_logs",
  SchemaMigrations: "schema_migrations",
} as const;

export interface AuditLogEntry {
  actor: string | null;
  action: "create" | "update" | "delete" | "login" | "logout";
  entity: string;
  entityId: number | string | null;
  requestId: string | null;
  at: string;
  before?: unknown;
  after?: unknown;
}

export type CollectionName = (typeof Collections)[keyof typeof Collections];
