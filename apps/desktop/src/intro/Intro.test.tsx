import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { IDENTITY_MS, Intro, LEAVE_MS, REDUCED_MS, VIDEO_GRACE_MS, VIDEO_MS } from "./Intro";

const root = () => document.querySelector<HTMLElement>(".intro")!;
const video = () => document.querySelector<HTMLVideoElement>("video");

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Intro", () => {
  it("toca o vídeo novo sozinho (sem faixa de logos por cima), oculto do leitor de tela", () => {
    render(<Intro canSkip={false} onDone={() => {}} />);
    expect(video()?.getAttribute("src")).toBe("/intro.mp4");
    expect(video()?.getAttribute("aria-hidden")).toBe("true");
    expect(video()?.muted).toBe(true);
    expect(document.querySelector(".intro-plate, .intro-logo, img")).toBeNull();
    expect(root().dataset.phase).toBe("video");
    expect(document.querySelector(".visually-hidden")?.textContent).toMatch(/Fulltime Intelligent Consig/);
  });

  it("no fim do vídeo (ended) mostra o nome do app e depois abre o app", () => {
    const onDone = vi.fn();
    render(<Intro canSkip={false} onDone={onDone} />);
    act(() => { fireEvent.ended(video()!); });
    expect(root().dataset.phase).toBe("identity");
    act(() => { vi.advanceTimersByTime(IDENTITY_MS - 1); });
    expect(onDone).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1 + LEAVE_MS); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("fundo bege até a saída: remove `intro-pending` do <html> quando a intro começa a sair", () => {
    document.documentElement.classList.add("intro-pending");
    render(<Intro canSkip onDone={() => {}} />);
    expect(document.documentElement.classList.contains("intro-pending")).toBe(true);
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    expect(document.documentElement.classList.contains("intro-pending")).toBe(false);
  });

  it("timeout de segurança se o vídeo não terminar", () => {
    const onDone = vi.fn();
    render(<Intro canSkip={false} onDone={onDone} />);
    act(() => { vi.advanceTimersByTime(VIDEO_MS + VIDEO_GRACE_MS); });
    expect(root().dataset.phase).toBe("identity");
    act(() => { vi.advanceTimersByTime(IDENTITY_MS + LEAVE_MS); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("erro ao carregar o vídeo vai direto para o nome", () => {
    render(<Intro canSkip={false} onDone={() => {}} />);
    act(() => { fireEvent.error(video()!); });
    expect(root().dataset.phase).toBe("identity");
  });

  it("pular com Esc/Enter/Espaço só a partir da segunda execução", () => {
    const first = vi.fn();
    render(<Intro canSkip={false} onDone={first} />);
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); vi.advanceTimersByTime(LEAVE_MS); });
    expect(first).not.toHaveBeenCalled();
    expect(document.querySelector(".intro-skip")).toBeNull();
    cleanup();

    for (const key of ["Escape", "Enter", " "]) {
      const onDone = vi.fn();
      render(<Intro canSkip onDone={onDone} />);
      act(() => { fireEvent.keyDown(window, { key }); vi.advanceTimersByTime(LEAVE_MS); });
      expect(onDone).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it("movimento reduzido: sem vídeo, só o nome por pouco tempo", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
    const onDone = vi.fn();
    render(<Intro canSkip={false} onDone={onDone} />);
    expect(video()).toBeNull();
    expect(root().dataset.phase).toBe("identity");
    act(() => { vi.advanceTimersByTime(REDUCED_MS + LEAVE_MS); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
