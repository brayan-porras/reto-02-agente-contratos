const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}
const MES_RE = Object.keys(MESES).join("|")

const pad = (n: number): string => String(n).padStart(2, "0")

export function diasEnMes(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate()
}

/** Construye YYYY-MM-DD validando que la fecha exista de verdad. */
export function aIso(anio: number, mes: number, dia: number): string {
  const valida = mes >= 1 && mes <= 12 && dia >= 1 && dia <= diasEnMes(anio, mes)
  if (!valida) throw new Error(`Fecha inválida: ${dia}/${mes}/${anio}`)
  return `${anio}-${pad(mes)}-${pad(dia)}`
}

interface Hallazgo {
  indice: number
  iso: string
}

/** Todas las fechas completas del texto, en orden de aparición. Lanza si alguna no existe. */
export function fechasEnTexto(texto: string): string[] {
  const patrones = [
    new RegExp(`\\((\\d{1,2})\\)\\s+de\\s+(${MES_RE})\\s+de\\s+(\\d{4})`, "gi"),
    new RegExp(`\\((\\d{1,2})\\)\\s+d[íi]as?\\s+del\\s+mes\\s+de\\s+(${MES_RE})\\s+de\\s+(\\d{4})`, "gi"),
    new RegExp(`(?<![\\d(])(\\d{1,2})\\s+de\\s+(${MES_RE})\\s+de\\s+(\\d{4})`, "gi"),
  ]
  const hallazgos: Hallazgo[] = []
  for (const re of patrones) {
    for (const m of texto.matchAll(re)) {
      const mes = MESES[(m[2] ?? "").toLowerCase()] ?? 0
      hallazgos.push({ indice: m.index ?? 0, iso: aIso(Number(m[3]), mes, Number(m[1])) })
    }
  }
  for (const m of texto.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    hallazgos.push({ indice: m.index ?? 0, iso: aIso(Number(m[1]), Number(m[2]), Number(m[3])) })
  }
  return hallazgos.sort((a, b) => a.indice - b.indice).map((h) => h.iso)
}

/** "en el mes de agosto de 2026" → { anio, mes } (sin día). */
export function mesEnTexto(texto: string): { anio: number; mes: number } | null {
  const m = new RegExp(`mes\\s+de\\s+(${MES_RE})\\s+de\\s+(\\d{4})`, "i").exec(texto)
  if (!m) return null
  return { anio: Number(m[2]), mes: MESES[(m[1] ?? "").toLowerCase()] ?? 0 }
}

export function ultimoDiaDelMes(anio: number, mes: number): string {
  return aIso(anio, mes, diasEnMes(anio, mes))
}

/** Suma meses conservando el día (recortado al último día del mes destino). */
export function sumarMeses(iso: string, meses: number): string {
  const [a, m, d] = iso.split("-").map(Number) as [number, number, number]
  const total = a * 12 + (m - 1) + meses
  const anio = Math.floor(total / 12)
  const mes = (total % 12) + 1
  return aIso(anio, mes, Math.min(d, diasEnMes(anio, mes)))
}

export function diasEntre(desde: string, hasta: string): number {
  const ms = Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}

export function esFechaIso(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [a, m, d] = s.split("-").map(Number) as [number, number, number]
  return m >= 1 && m <= 12 && d >= 1 && d <= diasEnMes(a, m)
}

export function hoyIso(): string {
  return new Date().toISOString().slice(0, 10)
}
