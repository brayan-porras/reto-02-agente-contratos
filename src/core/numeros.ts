/**
 * Convierte "265.000.000", "120,000.00" o "60.000" en número.
 * Regla: si hay ambos separadores, el último es el decimal; si hay uno solo y
 * deja exactamente 3 dígitos tras él (o aparece varias veces), es de miles.
 */
export function parseMonto(crudo: string): number | null {
  const s = crudo.replace(/[^\d.,]/g, "")
  if (!s) return null
  const punto = s.lastIndexOf(".")
  const coma = s.lastIndexOf(",")
  let decimal: "." | "," | null = null
  if (punto >= 0 && coma >= 0) {
    decimal = punto > coma ? "." : ","
  } else {
    const sep = punto >= 0 ? "." : coma >= 0 ? "," : null
    if (sep) {
      const partes = s.split(sep)
      if (partes.length === 2 && (partes[1] ?? "").length !== 3) decimal = sep
    }
  }
  const normalizado = decimal
    ? s.split(decimal === "." ? "," : ".").join("").replace(decimal, ".")
    : s.replace(/[.,]/g, "")
  const n = Number(normalizado)
  return Number.isFinite(n) ? n : null
}

export function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Similitud de Dice sobre bigramas de caracteres, en [0,1]. */
export function similitud(a: string, b: string): number {
  const na = normalizar(a)
  const nb = normalizar(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const bigramas = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ga = bigramas(na)
  const gb = bigramas(nb)
  let comunes = 0
  for (const [g, n] of ga) comunes += Math.min(n, gb.get(g) ?? 0)
  return (2 * comunes) / (na.length - 1 + (nb.length - 1))
}

const SUFIJOS_LEGALES = /\b(s a s|s a c|s a|s de r l|ltda|sas|sac)\b/g

export function slugCliente(cliente: string): string {
  return normalizar(cliente).replace(SUFIJOS_LEGALES, "").trim().replace(/\s+/g, "-")
}
