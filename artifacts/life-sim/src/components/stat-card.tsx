import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { type LucideIcon } from "lucide-react";

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  icon?: LucideIcon;
  accent?: "teal" | "amber" | "crimson" | "blue" | "purple";
  className?: string;
  sparklineData?: number[];
  running?: boolean;
}

const accentMap: Record<string, string> = {
  teal: "text-[hsl(173,80%,40%)]",
  amber: "text-[hsl(43,100%,50%)]",
  crimson: "text-[hsl(348,83%,47%)]",
  blue: "text-[hsl(210,100%,50%)]",
  purple: "text-[hsl(280,80%,60%)]",
};

const accentStrokeMap: Record<string, string> = {
  teal: "hsl(173,80%,40%)",
  amber: "hsl(43,100%,50%)",
  crimson: "hsl(348,83%,47%)",
  blue: "hsl(210,100%,50%)",
  purple: "hsl(280,80%,60%)",
};

const accentGlowMap: Record<string, string> = {
  teal: "hsl(173 80% 40% / 0.6)",
  amber: "hsl(43 100% 50% / 0.6)",
  crimson: "hsl(348 83% 47% / 0.6)",
  blue: "hsl(210 100% 50% / 0.6)",
  purple: "hsl(280 80% 60% / 0.6)",
};

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;

  const w = 64;
  const h = 24;
  const pad = 1;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0 opacity-70">
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  accent = "teal",
  className,
  sparklineData,
  running,
}: StatCardProps) {
  const showSparkline = running && sparklineData && sparklineData.length >= 2;
  const prevValue = useRef<string | number | undefined>(undefined);
  const [flashKey, setFlashKey] = useState(0);

  useEffect(() => {
    if (prevValue.current !== undefined && prevValue.current !== value) {
      setFlashKey(k => k + 1);
    }
    prevValue.current = value;
  }, [value]);

  return (
    <div
      className={cn("relative bg-card border border-card-border rounded p-4 flex flex-col gap-1", className)}
    >
      {flashKey > 0 && (
        <span
          key={flashKey}
          className="stat-card-flash"
          style={{ "--stat-glow-color": accentGlowMap[accent] } as React.CSSProperties}
        />
      )}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">{label}</span>
        {Icon && <Icon className={cn("w-3.5 h-3.5", accentMap[accent])} />}
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className={cn("text-2xl font-bold tabular-nums", accentMap[accent])}>{value}</span>
          {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
        </div>
        {showSparkline && (
          <Sparkline data={sparklineData} color={accentStrokeMap[accent]} />
        )}
      </div>
    </div>
  );
}
