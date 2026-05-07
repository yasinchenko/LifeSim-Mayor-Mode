import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

type EventSeverity = "positive" | "negative" | "neutral";
type EventType =
  | "good_harvest"
  | "bad_harvest"
  | "wealthy_migration"
  | "epidemic"
  | "economic_boom"
  | "government_subsidy"
  | "auto";

interface WorldEvent {
  id: string;
  type: EventType;
  name: string;
  description: string;
  icon: string;
  startDay: number;
  endDay: number;
  severity: EventSeverity;
}

interface EventLogEntry {
  id: string;
  day: number;
  tick: number;
  type: EventType;
  name: string;
  description: string;
  icon: string;
  severity: EventSeverity;
}

interface EventsResponse {
  active: WorldEvent[];
  log: EventLogEntry[];
}

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

async function fetchEvents(): Promise<EventsResponse> {
  const res = await fetch(`${BASE_URL}/api/events`);
  if (!res.ok) throw new Error("Failed to fetch events");
  return res.json() as Promise<EventsResponse>;
}

function severityColor(s: EventSeverity) {
  if (s === "positive") return "hsl(173,80%,40%)";
  if (s === "negative") return "hsl(348,83%,52%)";
  return "hsl(45,95%,55%)";
}

function ActiveEventBadge({ event, currentDay }: { event: WorldEvent; currentDay: number }) {
  const daysLeft = event.endDay - currentDay + 1;
  const color = severityColor(event.severity);
  return (
    <div
      className="flex items-start gap-2 p-2.5 rounded border"
      style={{ borderColor: `${color}40`, background: `${color}0d` }}
    >
      <span className="text-lg leading-none mt-0.5">{event.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1">
          <span className="text-[11px] font-semibold leading-tight" style={{ color }}>
            {event.name}
          </span>
          <span
            className="text-[9px] font-mono tabular-nums px-1.5 py-0.5 rounded shrink-0"
            style={{ background: `${color}25`, color }}
          >
            {daysLeft} {daysLeft === 1 ? "день" : daysLeft < 5 ? "дня" : "дней"}
          </span>
        </div>
        <p className="text-[10px] text-muted-foreground leading-tight mt-0.5 line-clamp-2">
          {event.description}
        </p>
      </div>
    </div>
  );
}

function LogEntry({ entry }: { entry: EventLogEntry }) {
  const color = severityColor(entry.severity);
  const isAuto = entry.type === "auto";
  return (
    <div className={cn("flex items-start gap-2 py-1.5", !isAuto && "py-2")}>
      <span className="text-base leading-none mt-0.5 shrink-0">{entry.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className="text-[10px] font-semibold leading-tight"
            style={{ color }}
          >
            {entry.name}
          </span>
          <span className="text-[9px] text-muted-foreground/70">
            день {entry.day}
          </span>
        </div>
        <p className="text-[10px] text-muted-foreground leading-tight mt-0.5 line-clamp-2">
          {entry.description}
        </p>
      </div>
    </div>
  );
}

export default function EventFeed({
  currentDay,
  running,
}: {
  currentDay: number;
  running: boolean;
}) {
  const { data } = useQuery<EventsResponse>({
    queryKey: ["events"],
    queryFn: fetchEvents,
    refetchInterval: running ? 8000 : 30000,
  });

  const active = data?.active ?? [];
  const log = data?.log ?? [];

  return (
    <div className="bg-card border border-card-border rounded p-4 space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">
          Мировые события
        </h3>
        {running && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold tracking-wider bg-[hsl(173,80%,40%)]/15 text-[hsl(173,80%,40%)] border border-[hsl(173,80%,40%)]/25">
            <span className="w-1.5 h-1.5 rounded-full bg-[hsl(173,80%,40%)] animate-pulse inline-block" />
            LIVE
          </span>
        )}
      </div>

      {active.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[9px] uppercase tracking-widest text-muted-foreground/60">
            Активные события
          </p>
          {active.map(ev => (
            <ActiveEventBadge key={ev.id} event={ev} currentDay={currentDay} />
          ))}
        </div>
      )}

      {active.length === 0 && (
        <div className="text-[10px] text-muted-foreground/50 italic py-1">
          Нет активных событий
        </div>
      )}

      {log.length > 0 && (
        <div className="space-y-0">
          <p className="text-[9px] uppercase tracking-widest text-muted-foreground/60 mb-1">
            История событий
          </p>
          <div className="divide-y divide-border/30">
            {log.slice(0, 12).map(entry => (
              <LogEntry key={entry.id} entry={entry} />
            ))}
          </div>
        </div>
      )}

      {log.length === 0 && (
        <div className="text-[10px] text-muted-foreground/50 italic">
          События ещё не происходили
        </div>
      )}
    </div>
  );
}
