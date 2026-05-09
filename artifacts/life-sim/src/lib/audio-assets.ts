import type { DayPhase } from "@/lib/day-phase";

const ASSETS_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const audioPath = (path: string) => `${ASSETS_BASE}/assets/audio/${path}`;

export const AUDIO_ASSETS: {
  city: Record<DayPhase, string>;
  system: {
    incidentAlert: string;
  };
  music: {
    mainMenu: string;
    city: string[];
  };
} = {
  city: {
    morning: audioPath("city/city-morning.mp3"),
    day: audioPath("city/city-day.mp3"),
    evening: audioPath("city/city-evening.mp3"),
    night: audioPath("city/city-night.mp3"),
  },
  system: {
    incidentAlert: audioPath("system/incident-alert.mp3"),
  },
  music: {
    mainMenu: audioPath("music/main-menu-theme.mp3"),
    city: [
      audioPath("music/music-1.mp3"),
      audioPath("music/music-2.mp3"),
      audioPath("music/music-3.mp3"),
    ],
  },
};
