import { useEffect, useRef } from "react";
import { robotOffline, type RequestStatus, type RobotState } from "@fic/contracts";
import type { Api } from "../../lib/api";
import { usePoll } from "../../lib/usePoll";

const SOUND_KEY = "fic.backoffice.sound";

export function soundEnabled(): boolean {
  try { return window.localStorage.getItem(SOUND_KEY) === "1"; } catch { return false; }
}
export function setSoundEnabled(on: boolean) {
  try { window.localStorage.setItem(SOUND_KEY, on ? "1" : "0"); } catch { /* armazenamento bloqueado */ }
}

function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } catch { /* sem áudio */ }
}

/**
 * Avisos do backoffice: quantos itens aguardam confirmação e se o robô está sem sinal (> 2 min).
 * Toca um sinal (opcional) quando um desses números piora.
 */
export function useBackofficeAlerts(api: Api, enabled: boolean) {
  const counts = usePoll<Partial<Record<RequestStatus, number>>>(() => (enabled ? api.dashboardCounts() : Promise.resolve({ ok: true as const, data: {} })), 5000, [enabled]);
  const robot = usePoll<RobotState | null>(
    () => (enabled ? api.robotState() : Promise.resolve({ ok: true as const, data: null })), 5000, [enabled]);
  const awaiting = counts.data?.awaiting_confirmation ?? 0;
  const offline = enabled && robot.data !== undefined && robotOffline(robot.data);

  const prev = useRef({ awaiting: 0, offline: false });
  useEffect(() => {
    if (!enabled) return;
    if ((awaiting > prev.current.awaiting || (offline && !prev.current.offline)) && soundEnabled()) beep();
    prev.current = { awaiting, offline };
  }, [awaiting, offline, enabled]);

  return { counts, robot, awaiting, offline };
}

export type BackofficeAlerts = ReturnType<typeof useBackofficeAlerts>;
