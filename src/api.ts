import type { Analysis, BenchmarkCase, BenchmarkResearch, BenchmarkRun, CaptureMetadata, Dashboard, Food, History, MealItem, LoggedFood, MealMemory, MealType, ProgressPhoto, ProgressPose, QuickAdd, ScaleReference, Settings, VisionModel } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  // The session cookie expired or was cleared: reload so the Worker serves the
  // login page instead of leaving the app showing stale data it cannot refresh.
  if (response.status === 401) {
    location.reload();
    throw new Error("Your session expired. Sign in again.");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  settings: () => request<Settings>("/api/settings"),
  updateSettings: (data: Record<string, unknown>) => request<Settings>("/api/settings", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(data)
  }),
  dashboard: (date: string) => request<Dashboard>(`/api/dashboard?date=${encodeURIComponent(date)}`),
  foods: (query = "") => request<Food[]>(`/api/foods?q=${encodeURIComponent(query)}`),
  analyze: (image: File | null, description: string, capture: CaptureMetadata | undefined, scaleReference: ScaleReference, loggedDate: string) => {
    const form = new FormData();
    if (image) form.append("image", image);
    form.append("description", description);
    if (capture) form.append("capture", JSON.stringify(capture));
    form.append("scaleReference", JSON.stringify(scaleReference));
    form.append("loggedDate", loggedDate);
    return request<Analysis>("/api/analyze", { method: "POST", body: form });
  },
  refineAnalysis: (analysis: Analysis, message: string) => request<Analysis>("/api/analyze/refine", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ analysis, message })
  }),
  memories: () => request<MealMemory[]>("/api/memories"),
  progressState: () => request<{ unlocked: boolean; unlockMinutes: number }>("/api/progress/state"),
  unlockPhotos: (password: string) => request<{ unlocked: boolean; unlockMinutes: number }>("/api/progress/unlock", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password })
  }),
  lockPhotos: () => request<{ unlocked: boolean }>("/api/progress/lock", { method: "POST" }),
  progressPhotos: () => request<ProgressPhoto[]>("/api/progress"),
  addProgressPhoto: (image: File, pose: ProgressPose, weightKg?: number, notes?: string) => {
    const form = new FormData();
    form.append("image", image);
    form.append("pose", pose);
    form.append("takenAt", new Date().toISOString());
    if (weightKg) form.append("weightKg", String(weightKg));
    if (notes?.trim()) form.append("notes", notes.trim());
    return request<ProgressPhoto>("/api/progress", { method: "POST", body: form });
  },
  deleteProgressPhoto: (id: string) => request<void>(`/api/progress/${id}`, { method: "DELETE" }),
  quickAdds: () => request<QuickAdd[]>("/api/quick-adds"),
  myFoods: (query = "") => request<LoggedFood[]>(`/api/my-foods?q=${encodeURIComponent(query)}`),
  deleteMemory: (id: string) => request<void>(`/api/memories/${id}`, { method: "DELETE" }),
  createMeal: (data: { loggedAt?: string; loggedDate?: string; mealType: MealType; title: string; imagePath?: string; imagePaths?: string[]; notes?: string; source?: string; confidence?: number; items: MealItem[] }) =>
    request<{ id: string }>("/api/meals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }),
  deleteMeal: (id: string) => request<void>(`/api/meals/${id}`, { method: "DELETE" }),
  repeatMeal: (id: string) => request<{ id: string }>(`/api/meals/${id}/duplicate`, { method: "POST" }),
  history: (days = 30) => request<History>(`/api/history?days=${days}`),
  addWeight: (weightKg: number) => request<{ id: string }>("/api/weight", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ weightKg })
  }),
  aiStatus: () => request<{ provider: string; available: boolean; model: string }>("/api/ai/status"),
  testTelegram: () => request<{ ok: boolean }>("/api/telegram/test", { method: "POST" }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" })
  , benchmarkCases: () => request<BenchmarkCase[]>("/api/benchmark/cases")
  , benchmarkModels: () => request<VisionModel[]>("/api/benchmark/models")
  , benchmarkResearch: () => request<BenchmarkResearch>("/api/benchmark/research")
  , runBenchmark: (caseId: string, model: string, strategy: "one-step" | "one-step-depth" | "one-step-predicted-depth" | "two-step" | "two-step-depth" | "two-step-predicted-depth") => request<BenchmarkRun>("/api/benchmark/run", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId, model, strategy })
  })
  , createBenchmarkCase: (form: FormData) => request<BenchmarkCase>("/api/benchmark/cases", { method: "POST", body: form })
};

export function localDate(date = new Date()) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

export function sumItems(items: MealItem[]) {
  return items.reduce((total, item) => ({
    calories: total.calories + item.calories,
    protein: total.protein + item.protein,
    carbs: total.carbs + item.carbs,
    fiber: total.fiber + (item.fiber ?? 0),
    fat: total.fat + item.fat
  }), { calories: 0, protein: 0, carbs: 0, fiber: 0, fat: 0 });
}
