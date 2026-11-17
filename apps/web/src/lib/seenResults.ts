// Propostas geradas que o operador já viu. Só no navegador (sem backend): trocar de navegador pode fazer o
// selo "Nova" reaparecer, o que é aceitável. Guarda apenas UUIDs técnicos, nenhum dado pessoal.

const key = (uid: string) => `fic:propostas-vistas:${uid}`;

/** `null` = este usuário nunca abriu o portal neste navegador. */
export function readSeen(uid: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(key(uid));
    if (raw === null) return null;
    const ids = JSON.parse(raw);
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeSeen(uid: string, ids: Iterable<string>) {
  try {
    localStorage.setItem(key(uid), JSON.stringify([...ids]));
  } catch {
    // Armazenamento cheio ou bloqueado: o selo apenas não persiste.
  }
}
