import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AUDIO_ASSETS } from "@/lib/audio-assets";
import type { DayPhase } from "@/lib/day-phase";

const STORAGE_KEY = "lifesim-audio-settings-v1";
const FADE_STEP_MS = 80;
const FADE_DURATION_MS = 700;

type MusicMode = "none" | "menu" | "city";

interface AudioSettings {
  musicEnabled: boolean;
  soundEnabled: boolean;
  musicVolume: number;
  soundVolume: number;
}

interface AudioContextValue extends AudioSettings {
  isAudioUnlocked: boolean;
  setMusicEnabled: (enabled: boolean) => void;
  setSoundEnabled: (enabled: boolean) => void;
  setMusicVolume: (volume: number) => void;
  setSoundVolume: (volume: number) => void;
  unlockAudio: () => void;
  playIncidentAlert: () => void;
  setMusicMode: (mode: MusicMode) => void;
  setCityPhase: (phase: DayPhase | null) => void;
}

const DEFAULT_SETTINGS: AudioSettings = {
  musicEnabled: true,
  soundEnabled: true,
  musicVolume: 0.38,
  soundVolume: 0.58,
};

const AudioContext = createContext<AudioContextValue | null>(null);

function readSettings(): AudioSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AudioSettings>;
    return {
      musicEnabled: typeof parsed.musicEnabled === "boolean" ? parsed.musicEnabled : DEFAULT_SETTINGS.musicEnabled,
      soundEnabled: typeof parsed.soundEnabled === "boolean" ? parsed.soundEnabled : DEFAULT_SETTINGS.soundEnabled,
      musicVolume: clampVolume(parsed.musicVolume ?? DEFAULT_SETTINGS.musicVolume),
      soundVolume: clampVolume(parsed.soundVolume ?? DEFAULT_SETTINGS.soundVolume),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function clampVolume(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function fadeTo(audio: HTMLAudioElement, targetVolume: number, onDone?: () => void) {
  const startVolume = audio.volume;
  const steps = Math.max(1, Math.round(FADE_DURATION_MS / FADE_STEP_MS));
  let step = 0;
  const intervalId = window.setInterval(() => {
    step += 1;
    const progress = Math.min(1, step / steps);
    audio.volume = startVolume + (targetVolume - startVolume) * progress;
    if (progress >= 1) {
      window.clearInterval(intervalId);
      onDone?.();
    }
  }, FADE_STEP_MS);
  return () => window.clearInterval(intervalId);
}

function safePlay(audio: HTMLAudioElement) {
  const promise = audio.play();
  if (promise) {
    promise.catch(() => {
      // Browser autoplay rules and missing placeholder assets are expected while audio is being prepared.
    });
  }
}

export function AudioProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AudioSettings>(() => readSettings());
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(false);
  const musicModeRef = useRef<MusicMode>("none");
  const cityPhaseRef = useRef<DayPhase | null>(null);
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  const cityAudioRef = useRef<HTMLAudioElement | null>(null);
  const cityTrackRef = useRef<string | null>(null);
  const musicIndexRef = useRef(0);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const unlockAudio = useCallback(() => {
    setIsAudioUnlocked(true);
  }, []);

  useEffect(() => {
    if (isAudioUnlocked) return undefined;
    const unlock = () => setIsAudioUnlocked(true);
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [isAudioUnlocked]);

  const stopMusic = useCallback(() => {
    const audio = musicAudioRef.current;
    if (!audio) return;
    fadeTo(audio, 0, () => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    });
  }, []);

  const playMusicTrack = useCallback((mode: MusicMode) => {
    if (!isAudioUnlocked || !settings.musicEnabled || settings.musicVolume <= 0 || mode === "none") {
      stopMusic();
      return;
    }

    const tracks = mode === "menu" ? [AUDIO_ASSETS.music.mainMenu] : AUDIO_ASSETS.music.city;
    if (tracks.length === 0) return;

    const nextTrack = tracks[musicIndexRef.current % tracks.length];
    let audio = musicAudioRef.current;
    if (!audio) {
      audio = new Audio();
      audio.preload = "auto";
      musicAudioRef.current = audio;
    }

    audio.loop = mode === "menu" || tracks.length === 1;
    audio.onended = () => {
      if (musicModeRef.current !== mode || audio?.loop) return;
      musicIndexRef.current = (musicIndexRef.current + 1) % tracks.length;
      playMusicTrack(mode);
    };

    if (audio.src !== nextTrack) {
      audio.pause();
      audio.src = nextTrack;
      audio.currentTime = 0;
    }
    audio.volume = settings.musicVolume;
    safePlay(audio);
  }, [isAudioUnlocked, settings.musicEnabled, settings.musicVolume, stopMusic]);

  const setMusicMode = useCallback((mode: MusicMode) => {
    if (musicModeRef.current !== mode) {
      musicModeRef.current = mode;
      musicIndexRef.current = 0;
    }
    playMusicTrack(mode);
  }, [playMusicTrack]);

  const stopCityAmbience = useCallback(() => {
    const audio = cityAudioRef.current;
    if (!audio) return;
    fadeTo(audio, 0, () => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      cityTrackRef.current = null;
    });
  }, []);

  const setCityPhase = useCallback((phase: DayPhase | null) => {
    cityPhaseRef.current = phase;
    if (!phase || !isAudioUnlocked || !settings.soundEnabled || settings.soundVolume <= 0) {
      stopCityAmbience();
      return;
    }

    const nextTrack = AUDIO_ASSETS.city[phase];
    let audio = cityAudioRef.current;
    if (!audio) {
      audio = new Audio();
      audio.preload = "auto";
      audio.loop = true;
      cityAudioRef.current = audio;
    }

    if (cityTrackRef.current === nextTrack) {
      audio.volume = settings.soundVolume;
      safePlay(audio);
      return;
    }

    cityTrackRef.current = nextTrack;
    audio.pause();
    audio.src = nextTrack;
    audio.currentTime = 0;
    audio.volume = 0;
    safePlay(audio);
    fadeTo(audio, settings.soundVolume);
  }, [isAudioUnlocked, settings.soundEnabled, settings.soundVolume, stopCityAmbience]);

  const playIncidentAlert = useCallback(() => {
    if (!isAudioUnlocked || !settings.soundEnabled || settings.soundVolume <= 0) return;
    const audio = new Audio(AUDIO_ASSETS.system.incidentAlert);
    audio.preload = "auto";
    audio.volume = settings.soundVolume;
    safePlay(audio);
  }, [isAudioUnlocked, settings.soundEnabled, settings.soundVolume]);

  useEffect(() => {
    playMusicTrack(musicModeRef.current);
  }, [playMusicTrack]);

  useEffect(() => {
    setCityPhase(cityPhaseRef.current);
  }, [setCityPhase]);

  useEffect(() => () => {
    musicAudioRef.current?.pause();
    cityAudioRef.current?.pause();
  }, []);

  const value = useMemo<AudioContextValue>(() => ({
    ...settings,
    isAudioUnlocked,
    unlockAudio,
    playIncidentAlert,
    setMusicMode,
    setCityPhase,
    setMusicEnabled: musicEnabled => setSettings(current => ({ ...current, musicEnabled })),
    setSoundEnabled: soundEnabled => setSettings(current => ({ ...current, soundEnabled })),
    setMusicVolume: musicVolume => setSettings(current => ({ ...current, musicVolume: clampVolume(musicVolume) })),
    setSoundVolume: soundVolume => setSettings(current => ({ ...current, soundVolume: clampVolume(soundVolume) })),
  }), [isAudioUnlocked, playIncidentAlert, setCityPhase, setMusicMode, settings, unlockAudio]);

  return <AudioContext.Provider value={value}>{children}</AudioContext.Provider>;
}

export function useAudio() {
  const context = useContext(AudioContext);
  if (!context) {
    throw new Error("useAudio must be used inside AudioProvider");
  }
  return context;
}
