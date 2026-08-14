export type MealType = "Breakfast" | "Lunch" | "Merienda" | "Dinner" | "Treat";
export type MealTypeChoice = "Auto" | MealType;

export type ScaleReference = {
  mode: "default-plate" | "custom-plate" | "none";
  diameterCm: number | null;
};

export type MealTypeSuggestion = {
  type: MealType;
  confidence: number;
  explanation: string;
};

export type Reminder = { id: string; label: string; time: string; enabled: boolean };

export type Settings = {
  name: string;
  onboardingComplete: boolean;
  calorieTarget: number;
  proteinTarget: number;
  carbsTarget: number;
  fatTarget: number;
  fiberTarget: number;
  weightKg: number;
  heightCm: number;
  age: number;
  sex: string;
  activity: string;
  goal: string;
  theme: string;
  plateDiameterCm: number;
  openrouterConfigured: boolean;
  openrouterKeySource: "environment" | "saved" | "none";
  openrouterModel: string;
  telegramTokenConfigured: boolean;
  telegramChatId: string;
  timezone: string;
  reminders: Reminder[];
  today: string;
  now: string;
  localTime: string;
  greeting: "morning" | "afternoon" | "evening";
  dayStartedAt: string;
  dayEndsAt: string;
};

export type Nutrients = { calories: number; protein: number; carbs: number; fiber: number; fat: number };

export type NutrientRange = { low: number; high: number };

export type EstimateRange = {
  calories: NutrientRange;
  protein: NutrientRange;
  carbs: NutrientRange;
  fiber: NutrientRange;
  fat: NutrientRange;
};

export type CaptureMetadata = {
  width: number;
  height: number;
  brightness: number;
  contrast: number;
  sharpness: number;
  qualityScore: number;
  issues: string[];
};

export type MeasurementAssessment = {
  referenceMode: ScaleReference["mode"];
  plateDiameterCm: number | null;
  plateProfile: "round-flat" | null;
  plateVisible: boolean;
  wholePlateVisible: boolean;
  plateUsedAsScale: boolean;
  viewAngleDeg: number | null;
  scaleConfidence: "high" | "medium" | "low" | "none";
  captureQuality: "good" | "usable" | "poor";
  explanation: string;
};

// Fibre is optional on a single item so hand-entered quick-adds and older saved
// meals stay valid; sumItems treats a missing value as 0.
export type MealItem = Omit<Nutrients, "fiber"> & {
  fiber?: number;
  id?: string;
  foodId?: number | null;
  name: string;
  grams: number;
  emoji?: string;
  confidence?: number;
  visualEvidence?: string;
  portionBasis?: string;
  gramsLow?: number;
  gramsHigh?: number;
  uncertaintyReasons?: string[];
};

export type Meal = {
  id: string;
  loggedAt: string;
  mealType: MealType;
  title: string;
  imagePath?: string | null;
  imagePaths?: string[];
  notes: string;
  source: string;
  confidence?: number | null;
  items: MealItem[];
};

export type Dashboard = {
  date: string;
  settings: Settings;
  totals: Nutrients;
  meals: Meal[];
};

export type Food = Nutrients & {
  id: number;
  name: string;
  brand: string;
  category: string;
  emoji: string;
  servingLabel: string;
  servingGrams: number;
};

export type Analysis = {
  title: string;
  confidence: number;
  provider: "rules" | "openrouter";
  imagePath?: string;
  imagePaths?: string[];
  items: MealItem[];
  assumptions: string[];
  warnings: string[];
  range?: EstimateRange;
  measurement?: MeasurementAssessment;
  mealTypeSuggestion?: MealTypeSuggestion;
  highImpactQuestion?: string;
  pipelineVersion?: string;
  capture?: CaptureMetadata;
  usage?: { model: string; costUsd: number; latencyMs: number };
  assistantReply?: string;
  appliedMemories?: string[];
  memorySaved?: string;
};

/** A previously quick-added entry, offered for one-tap repeat logging. */
export type QuickAdd = Nutrients & { name: string; grams: number; timesUsed: number; lastLoggedAt: string };

export type MealMemory = { id: string; subject: string; note: string; timesUsed: number; createdAt: string; updatedAt: string };

export type HistoryDay = Nutrients & { date: string; meals: number };
export type WeightEntry = { id: string; recordedAt: string; weightKg: number };
export type History = { nutrition: HistoryDay[]; weights: WeightEntry[] };

export type BenchmarkMetric = { predicted: number; truth: number; absolute: number; absolutePercent: number };
export type BenchmarkRun = {
  id: string;
  caseId: string;
  model: string;
  strategy: "one-step" | "one-step-depth" | "one-step-predicted-depth" | "two-step" | "two-step-depth" | "two-step-predicted-depth";
  promptVersion: string;
  latencyMs: number;
  createdAt: string;
  macroAbsoluteError: number;
  usage: { costUsd: number; inputTokens: number; outputTokens: number; reasoningTokens: number };
  metrics: { mass: BenchmarkMetric; calories: BenchmarkMetric; protein: BenchmarkMetric; carbs: BenchmarkMetric; fat: BenchmarkMetric };
};
export type BenchmarkCase = {
  id: string;
  name: string;
  imagePath: string;
  depthPath?: string | null;
  predictedDepthPath?: string | null;
  source: string;
  sourceId?: string | null;
  sourceUrl?: string | null;
  ingredients: string[];
  truth: { mass: number; calories: number; protein: number; carbs: number; fat: number };
  runs: BenchmarkRun[];
};
export type VisionModel = { id: string; name: string; contextLength?: number | null; pricing?: Record<string, string> | null; supportedParameters?: string[] };
export type BenchmarkResearch = {
  dataset: { name: string; dishes: number; rgbdDishes: number; license: string; url: string; note: string };
  findings: Array<{ label: string; value: string; url: string }>;
  depthStudy?: {
    model: string;
    cases: number;
    meanMaeMeters: number;
    meanAbsoluteRelativeError: number;
    meanScaleAlignedMaeMeters: number;
    meanLatencySeconds: number;
  } | null;
  methodology: string;
};
