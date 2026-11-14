import { useCallback, useEffect, useRef, useState } from "react";
import "./intro.css";

type Props = { canSkip: boolean; onDone: () => void };

/** Duração do vídeo oficial (`public/intro.mp4`, 6,08 s). */
export const VIDEO_MS = 6080;
/** Margem do timeout de segurança: se o vídeo não tocar/terminar, a intro segue mesmo assim. */
export const VIDEO_GRACE_MS = 1500;
/** Tempo em que o nome do app fica na tela depois do vídeo. Sincronizado com intro.css. */
export const IDENTITY_MS = 1600;
/** Duração total esperada (vídeo + nome). */
export const INTRO_MS = VIDEO_MS + IDENTITY_MS;
/** Movimento reduzido: só o nome, sem vídeo. */
export const REDUCED_MS = 1400;
/** Saída (fade) antes de chamar onDone. */
export const LEAVE_MS = 380;

type Phase = "video" | "identity";

/**
 * Introdução: vídeo oficial com a animação dos logos (Full Time → transição → banco bmg), em tela cheia e sem
 * nada por cima; ao terminar (evento `ended`), o nome "Fulltime Intelligent Consig" aparece por um instante e o
 * app abre. Se o vídeo não tocar (erro, codec, autoplay), um timeout de segurança garante a sequência.
 * Roda enquanto o processo nativo inicializa: não atrasa a inicialização.
 */
export function Intro({ canSkip, onDone }: Props) {
  const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [phase, setPhase] = useState<Phase>(reduced ? "identity" : "video");
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);

  const finish = useCallback(() => {
    if (done.current) return;
    done.current = true;
    setLeaving(true);
    window.setTimeout(onDone, LEAVE_MS);
  }, [onDone]);

  const showIdentity = useCallback(() => setPhase("identity"), []);

  // Fase do vídeo: espera o `ended`; o timeout de segurança cobre vídeo que não toca ou trava.
  useEffect(() => {
    if (phase !== "video") return;
    const t = window.setTimeout(showIdentity, VIDEO_MS + VIDEO_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [phase, showIdentity]);

  // Fase do nome: tempo fixo e então o app abre.
  useEffect(() => {
    if (phase !== "identity") return;
    const t = window.setTimeout(finish, reduced ? REDUCED_MS : IDENTITY_MS);
    return () => window.clearTimeout(t);
  }, [phase, finish, reduced]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (canSkip && (e.key === "Escape" || e.key === "Enter" || e.key === " ")) finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish, canSkip]);

  return (
    <div className={`intro is-${phase}${reduced ? " intro-reduced" : ""}${leaving ? " intro-leave" : ""}`} role="presentation"
      data-phase={phase}>
      {!reduced && (
        <video className="intro-video" src="/intro.mp4" autoPlay muted playsInline preload="auto" aria-hidden="true"
          onEnded={showIdentity} onError={showIdentity} />
      )}

      <div className="intro-identity" aria-hidden="true">
        <span className="intro-rule" />
        <p className="intro-wordmark">
          <span>Fulltime</span> Intelligent Consig
        </p>
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
