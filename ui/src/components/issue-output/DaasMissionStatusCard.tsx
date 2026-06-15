import { AlertTriangle, CheckCircle2, Clock, ExternalLink, ShieldCheck, ShieldX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDaasStatus, type DaasMissionOutput } from "@/lib/daas-mission-output";
import { cn } from "@/lib/utils";

interface DaasMissionStatusCardProps {
  output: DaasMissionOutput;
}

const toneClassNames = {
  success: "border-green-500/30 bg-green-500/[0.06] text-green-700 dark:text-green-300",
  warning: "border-amber-500/40 bg-amber-500/[0.08] text-amber-800 dark:text-amber-200",
  danger: "border-destructive/40 bg-destructive/[0.08] text-destructive",
  pending: "border-cyan-500/30 bg-cyan-500/[0.06] text-cyan-700 dark:text-cyan-300",
};

function ToneIcon({ tone }: { tone: DaasMissionOutput["tone"] }) {
  if (tone === "success") return <CheckCircle2 className="h-4 w-4" aria-hidden="true" />;
  if (tone === "warning") return <AlertTriangle className="h-4 w-4" aria-hidden="true" />;
  if (tone === "danger") return <ShieldX className="h-4 w-4" aria-hidden="true" />;
  return <Clock className="h-4 w-4" aria-hidden="true" />;
}

export function DaasMissionStatusCard({ output }: DaasMissionStatusCardProps) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="gap-1 px-2 py-0.5 text-[11px]">
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              Source: DAAS
            </Badge>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                toneClassNames[output.tone],
              )}
            >
              <ToneIcon tone={output.tone} />
              {formatDaasStatus(output.status)}
            </span>
          </div>
          <div className="space-y-1 text-xs text-muted-foreground">
            {output.missionId ? (
              <p>
                DAAS mission <span className="font-mono text-foreground">{output.missionId}</span>
              </p>
            ) : null}
            {output.routeStatus ? <p>Route status: {formatDaasStatus(output.routeStatus)}</p> : null}
            <p>Infrastructure execution is governed by DAAS mission status and evidence.</p>
          </div>
        </div>

        {output.evidenceUrl ? (
          <Button asChild variant="outline" size="sm" className="shrink-0 max-md:w-full">
            <a href={output.evidenceUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
              DAAS evidence
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
