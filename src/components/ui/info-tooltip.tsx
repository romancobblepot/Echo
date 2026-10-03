"use client";

import { Info } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "./tooltip";

export function InfoTooltip({ text, className }: { text: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        className={`text-muted-foreground/60 hover:text-muted-foreground inline-flex ${className ?? ""}`}
      >
        <Info size={12} />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-left">{text}</TooltipContent>
    </Tooltip>
  );
}
