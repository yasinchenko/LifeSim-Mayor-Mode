import { Music2, Volume2, VolumeX } from "lucide-react";
import { useAudio } from "@/contexts/audio-context";
import { cn } from "@/lib/utils";

export default function AudioSettingsPanel() {
  const audio = useAudio();

  return (
    <div className="grid gap-3">
      <AudioToggleRow
        icon={Music2}
        label="Музыка"
        description="Фоновые треки меню и города."
        enabled={audio.musicEnabled}
        volume={audio.musicVolume}
        onToggle={audio.setMusicEnabled}
        onVolume={audio.setMusicVolume}
      />
      <AudioToggleRow
        icon={audio.soundEnabled ? Volume2 : VolumeX}
        label="Системные звуки"
        description="Городской фон по времени суток и сигналы происшествий."
        enabled={audio.soundEnabled}
        volume={audio.soundVolume}
        onToggle={audio.setSoundEnabled}
        onVolume={audio.setSoundVolume}
      />
      {!audio.isAudioUnlocked && (
        <button
          type="button"
          onClick={audio.unlockAudio}
          className="rounded border border-primary/40 bg-primary/12 px-3 py-2 text-left text-xs font-medium text-primary hover:bg-primary/18"
        >
          Включить звук в браузере
        </button>
      )}
    </div>
  );
}

function AudioToggleRow({
  icon: Icon,
  label,
  description,
  enabled,
  volume,
  onToggle,
  onVolume,
}: {
  icon: typeof Music2;
  label: string;
  description: string;
  enabled: boolean;
  volume: number;
  onToggle: (enabled: boolean) => void;
  onVolume: (volume: number) => void;
}) {
  return (
    <div className="rounded border border-border/70 bg-black/24 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">{label}</p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onToggle(!enabled)}
          className={cn(
            "shrink-0 rounded border px-2.5 py-1 text-[11px] font-semibold transition-colors",
            enabled
              ? "border-primary/45 bg-primary/14 text-primary hover:bg-primary/20"
              : "border-border bg-secondary text-muted-foreground hover:text-foreground"
          )}
        >
          {enabled ? "Вкл" : "Выкл"}
        </button>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          disabled={!enabled}
          onChange={event => onVolume(parseFloat(event.target.value))}
          className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary disabled:cursor-not-allowed disabled:opacity-45"
        />
        <span className="w-10 text-right text-xs font-semibold tabular-nums text-primary">
          {Math.round(volume * 100)}%
        </span>
      </div>
    </div>
  );
}
