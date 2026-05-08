import type { SimulationState } from "@workspace/api-client-react";

export interface SaveSlotSummary {
  tick: number;
  gameDay: number;
  gameHour: number;
  scenarioType: string;
  goalType: string;
  gameStatus: string;
  goalProgress: number;
  population: number;
  governmentBudget: number;
}

export interface SaveSlot {
  id: string;
  name: string;
  summary: SaveSlotSummary | null;
  createdAt: string;
  updatedAt: string;
}

function apiBase() {
  return import.meta.env.BASE_URL.replace(/\/$/, "");
}

async function parseResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data?.error === "string" ? data.error : response.statusText;
    throw new Error(message);
  }
  return data as T;
}

export async function listSaves(): Promise<SaveSlot[]> {
  const response = await fetch(`${apiBase()}/api/simulation/saves`);
  return parseResponse<SaveSlot[]>(response);
}

export async function saveGame(slotId: string, name: string): Promise<SaveSlot> {
  const response = await fetch(`${apiBase()}/api/simulation/saves`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slotId, name }),
  });
  return parseResponse<SaveSlot>(response);
}

export async function loadSave(slotId: string): Promise<SimulationState> {
  const response = await fetch(`${apiBase()}/api/simulation/saves/${encodeURIComponent(slotId)}/load`, {
    method: "POST",
  });
  return parseResponse<SimulationState>(response);
}

export async function deleteSave(slotId: string): Promise<{ deleted: boolean }> {
  const response = await fetch(`${apiBase()}/api/simulation/saves/${encodeURIComponent(slotId)}`, {
    method: "DELETE",
  });
  return parseResponse<{ deleted: boolean }>(response);
}
