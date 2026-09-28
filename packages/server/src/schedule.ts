// packages/server/src/schedule.ts — "run this every day at HH:MM local time".

export function parseHHMM(at: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!m) throw new Error(`invalid time "${at}" (expected HH:MM)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`invalid time "${at}"`);
  return { h, m: min };
}

export function msUntilNext(at: string, now = new Date()): number {
  const { h, m } = parseHHMM(at);
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export interface DailyJob {
  stop(): void;
}

export function scheduleDaily(at: string, fn: () => Promise<unknown> | unknown, onError: (e: unknown) => void): DailyJob {
  parseHHMM(at); // validate eagerly
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try { await fn(); } catch (e) { onError(e); }
      arm();
    }, msUntilNext(at));
    timer.unref?.();
  };
  arm();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
