import { useCallback, useEffect, useRef, useState } from "react";
import "./intro.css";

type Props = { canSkip: boolean; onDone: () => void };

/** Duração total da sequência (ms). Sincronizada com intro.css. */
export const INTRO_MS = 6200;
const REDUCED_MS = 1400;

/**
 * Introdução: fundo abstrato gerado no Higgsfield (sem marcas) + logos OFICIAIS de SRC/
 * sobre uma faixa clara, na ordem Fulltime → Banco BMG → Fulltime Intelligent Consig.
 * Roda enquanto o processo nativo inicializa: não atrasa a inicialização.
 */
export function Intro({ canSkip, onDone }: Props) {
  const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);

  const finish = useCallback(() => {
    if (done.current) return;
    done.current = true;
    setLeaving(true);
    window.setTimeout(onDone, 380);
  }, [onDone]);

  useEffect(() => {
    const t = window.setTimeout(finish, reduced ? REDUCED_MS : INTRO_MS);
    const onKey = (e: KeyboardEvent) => {
      if (canSkip && (e.key === "Escape" || e.key === "Enter" || e.key === " ")) finish();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [finish, canSkip, reduced]);

  return (
    <div className={`intro ${reduced ? "intro-reduced" : ""} ${leaving ? "intro-leave" : ""}`} role="presentation">
      {!reduced && <video className="intro-bg" src="/intro-bg.mp4" autoPlay muted playsInline preload="auto" aria-hidden="true" />}
      <div className="intro-vignette" aria-hidden="true" />

      <div className="intro-plate" aria-hidden="true">
        <img className="intro-logo intro-logo-fulltime" src="/fulltime.png" alt="" />
        <img className="intro-logo intro-logo-bmg" src="/bmg.png" alt="" />
      </div>

      <div className="intro-identity">
        <span className="intro-rule" aria-hidden="true" />
        <h1 className="intro-wordmark">
          <span>Fulltime</span> Intelligent Consig
        </h1>
        <p className="intro-tagline">Automação de propostas · Backoffice</p>
      </div>

      <span className="visually-hidden">Fulltime, Banco BMG, Fulltime Intelligent Consig</span>
      {canSkip && (
        <button className="intro-skip" onClick={finish}>
          Pular <kbd>Esc</kbd>
        </button>
      )}
    </div>
  );
}
