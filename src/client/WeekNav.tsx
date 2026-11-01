import { IconButton, Text } from "@radix-ui/themes";
import { addDays, formatWeekRange } from "../shared/time.ts";
import { ActionButton, ChevronLeft, ChevronRight } from "./ui.tsx";

/** A week by its Monday, the one way it is written everywhere: "Oct 19 – 25, 2026". */
export const weekRange = (monday: string) => formatWeekRange(monday);

type Unit = "day" | "week" | "month";
const CURRENT: Record<Unit, string> = { day: "Today", week: "This week", month: "This month" };
const GROUP: Record<Unit, string> = { day: "Day", week: "Week", month: "Month" };

/**
 * The one control for moving between days, weeks or months, the same on every page (QA2-18):
 * ‹ This week › in one outlined group, in the page header. The middle button goes back to the
 * current one; while you're on it, it stays in place but does nothing.
 */
export function PeriodStepper({ unit, current, onStep, onCurrent }: { unit: Unit; current: boolean; onStep: (by: -1 | 1) => void; onCurrent: () => void }) {
  return (
    <div className="wl-stepper" role="group" aria-label={GROUP[unit]}>
      <IconButton aria-label={`Previous ${unit}`} variant="ghost" color="gray" size="2" onClick={() => onStep(-1)}>
        <ChevronLeft />
      </IconButton>
      <ActionButton variant="ghost" color="gray" size="2" disabled={current} onClick={onCurrent}>
        {CURRENT[unit]}
      </ActionButton>
      <IconButton aria-label={`Next ${unit}`} variant="ghost" color="gray" size="2" onClick={() => onStep(1)}>
        <ChevronRight />
      </IconButton>
    </div>
  );
}

/** A week chooser inside a page (Approvals' filter): the week's dates, then the stepper. Weeks are given by their Monday. */
export function WeekNav({ week, thisWeek, onChange }: { week: string; thisWeek: string; onChange: (monday: string) => void }) {
  return (
    <div className="wl-week-nav">
      <Text size="2" weight="medium" className="wl-num">{weekRange(week)}</Text>
      <PeriodStepper unit="week" current={week === thisWeek} onStep={(by) => onChange(addDays(week, 7 * by))} onCurrent={() => onChange(thisWeek)} />
    </div>
  );
}
