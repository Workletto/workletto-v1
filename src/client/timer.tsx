import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { announce } from "./a11y.tsx";
import { api, type TimeEntry } from "./api.ts";
import { formatEntryDuration } from "../shared/time.ts";

// The signed-in person's running timer, shared by the header and the Time page.
// `version` goes up whenever entries change, so pages know to reload.

type StartBody = { entryId: string } | { projectId: string; taskId: string | null; date: string; notes: string; billable: boolean; customFields?: Record<string, string> };

type Timer = {
  running: TimeEntry | null;
  version: number;
  start: (body: StartBody) => Promise<void>;
  stop: () => Promise<void>;
  /** Call after adding, editing or deleting an entry. */
  changed: () => Promise<void>;
};

const TimerContext = createContext<Timer | null>(null);

export function TimerProvider({ children }: { children: ReactNode }) {
  const [running, setRunning] = useState<TimeEntry | null>(null);
  const [version, setVersion] = useState(0);
  const runningNow = useRef(running);
  runningNow.current = running;

  const changed = useCallback(async () => {
    const { entry } = await api<{ entry: TimeEntry | null }>("/api/timer");
    setRunning(entry);
    setVersion((v) => v + 1);
  }, []);

  // Load on start, and again when the window comes back into focus, since the
  // timer may have been started or stopped in another tab.
  useEffect(() => {
    const reload = () => void changed().catch(() => undefined);
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [changed]);

  const start = useCallback(async (body: StartBody) => {
    const { entry } = await api<{ entry: TimeEntry }>("/api/timer/start", body);
    setRunning(entry);
    setVersion((v) => v + 1);
    announce(`Timer started on ${entry.project.name}.`);
  }, []);

  const stop = useCallback(async () => {
    const stopped = runningNow.current;
    await api("/api/timer/stop", {});
    setRunning(null);
    setVersion((v) => v + 1);
    announce(stopped ? `Timer stopped on ${stopped.project.name}. ${formatEntryDuration(elapsed(stopped, Date.now()))} tracked.` : "Timer stopped.");
  }, []);

  return <TimerContext value={{ running, version, start, stop, changed }}>{children}</TimerContext>;
}

export function useTimer(): Timer {
  const timer = useContext(TimerContext);
  if (!timer) throw new Error("useTimer needs a TimerProvider.");
  return timer;
}

/** The current time, updated every second while `ticking` is true. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}

/** An entry's seconds so far, including a running timer's time since it started. */
export function elapsed(entry: TimeEntry, now: number): number {
  if (!entry.startedAt) return entry.seconds;
  return entry.seconds + Math.max(0, Math.floor((now - Date.parse(entry.startedAt)) / 1000));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Today in this browser's time zone, as "YYYY-MM-DD". */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Formats a "YYYY-MM-DD" day in the browser's language. */
export function formatDay(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, options);
}
