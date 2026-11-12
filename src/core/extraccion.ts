import { fechasEnTexto, mesEnTexto, sumarMeses, ultimoDiaDelMes } from "./fechas.js"
import { parseMonto } from "./numeros.js"
import { MONEDAS, type Contrato, type Moneda, type Pais } from "./tipos.js"

/**
 * Extracción determinista (regex + heurísticas). Cada campo lleva una confianza:
 *  - 0.95–0.98: encontrado literalmente en la cláusula esperada
 *  - 0.8–0.9:   inferido de forma razonable (p. ej. país por domicilio)
 *  - < 0.8:     derivado o ambiguo (plazo en meses, valor por demanda) → revisión humana
 *  - 0:         ausente del texto → null, nunca inventado
 */

const NOMBRE_CONTRAPARTE = /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .&]+?),\s*(?:identificada con\s+)?(NIT|RUC|RTN)\s+([\d.\-]+)/g
const PALABRAS_MINUSCULA = new Set(["de", "del", "la", "y", "e", "el"])

const PAIS_POR_PALABRA: Array<{ pais: Pais; re: RegExp }> = [
  { pais: "CO", re: /Colombia|Bogot[áa]|Medell[íi]n|Barranquilla|Cali\b|Cartagena/i },
  { pais: "EC", re: /Ecuador|Quito|Guayaquil/i },
  { pais: "PE", re: /Per[úu]|Lima\b/i },
  { pais: "PA", re: /Panam[áa]/i },
  { pais: "HN", re: /Honduras|Tegucigalpa|San Pedro Sula/i },
]

const MONEDA_POR_PALABRA: Array<{ moneda: Moneda; re: RegExp }> = [
  { moneda: "COP", re: /\bpesos\b/i },
  { moneda: "USD", re: /d[óo]lares/i },
  { moneda: "PEN", re: /\bsoles\b/i },
  { moneda: "PAB", re: /balboas/i },
  { moneda: "HNL", re: /lempiras/i },
]

const TIPOS_POLIZA: Array<{ tipo: string; re: RegExp }> = [
  { tipo: "cumplimiento", re: /cumplimiento/i },
  { tipo: "calidad", re: /calidad/i },
  { tipo: "responsabilidad_civil", re: /responsabilidad civil/i },
  { tipo: "salarios_prestaciones", re: /salarios|prestaciones sociales/i },
  { tipo: "anticipo", re: /anticipo/i },
]

type Confianza = Record<string, number>

export function extraerContrato(texto: string): Contrato {
  if (!texto || !texto.trim()) throw new Error("El texto del contrato está vacío")
  const parrafos = texto.split(/\n\s*\n/).map((p) => p.trim())
  const conf: Confianza = {}
  const observaciones: string[] = []

  const es_otrosi = /^\s*OTROS[ÍI]/i.test(texto.slice(0, 200))
  const id = texto.match(/\b([A-Z]{1,4}-\d{4}-\d{1,4})\b/)?.[1] ?? null
  conf.id_contrato = id ? 0.98 : 0

  const contraparte = extraerContraparte(texto)
  conf.cliente = contraparte ? contraparte.confianza : 0
  conf.nit_cliente = contraparte ? 0.95 : 0
  const pais = contraparte ? paisDeDomicilio(texto, contraparte.finIndice) : null
  conf.pais = pais ? 0.9 : 0

  const objeto = extraerObjeto(parrafos)
  conf.objeto = objeto.texto ? objeto.confianza : 0

  const valor = extraerValor(parrafos, texto, observaciones)
  conf.valor = valor.confValor
  conf.moneda = valor.moneda ? valor.confMoneda : 0

  const plazo = extraerPlazo(parrafos, texto, observaciones)
  conf.fecha_inicio = plazo.inicio ? plazo.confInicio : 0
  conf.fecha_fin = plazo.fin ? plazo.confFin : 0

  const poliza = extraerPoliza(parrafos, texto, es_otrosi, observaciones)
  conf.requiere_poliza = poliza.requiere === null ? 0 : poliza.confianza
  conf.tipo_poliza = poliza.requiere === null ? 0 : poliza.confianza

  return {
    id_contrato: id,
    cliente: contraparte?.nombre ?? null,
    nit_cliente: contraparte?.nit ?? null,
    pais: pais ?? paisPorMoneda(valor.moneda, conf),
    objeto: objeto.texto,
    valor: valor.valor,
    valor_indeterminado: valor.indeterminado,
    moneda: valor.moneda,
    fecha_inicio: plazo.inicio,
    fecha_fin: plazo.fin,
    requiere_poliza: poliza.requiere,
    tipo_poliza: poliza.requiere === null ? null : poliza.tipos,
    es_otrosi,
    amplia_poliza: /deber[áa]n ampliarse|ampliar(?:se)?[^.]*vigencia/i.test(texto) && es_otrosi,
    observaciones,
    confianza: conf,
  }
}

function extraerContraparte(
  texto: string,
): { nombre: string; nit: string; confianza: number; finIndice: number } | null {
  for (const m of texto.matchAll(NOMBRE_CONTRAPARTE)) {
    const bruto = (m[1] ?? "").trim()
    if (/PERIFERIA/i.test(bruto)) continue
    const fin = (m.index ?? 0) + m[0].length
    const esContratante = /CONTRATANTE/.test(texto.slice(fin, fin + 400))
    return {
      nombre: tituloEmpresa(bruto),
      nit: limpiarIdentificador(m[3] ?? ""),
      confianza: esContratante ? 0.95 : 0.75,
      finIndice: fin,
    }
  }
  return null
}

/** "INDUSTRIAS DELTA S.A.S." → "Industrias Delta S.A.S." */
export function tituloEmpresa(mayusculas: string): string {
  return mayusculas
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      if (w.includes(".")) return w.toUpperCase()
      const bajo = w.toLocaleLowerCase("es")
      if (i > 0 && PALABRAS_MINUSCULA.has(bajo)) return bajo
      return bajo.charAt(0).toLocaleUpperCase("es") + bajo.slice(1)
    })
    .join(" ")
}

/** Sin puntos ni dígito de verificación ("890.900.111-4" → "890900111"). */
export function limpiarIdentificador(crudo: string): string {
  return (crudo.replace(/\./g, "").split("-")[0] ?? "").trim()
}

function paisDeDomicilio(texto: string, desde: number): Pais | null {
  const resto = texto.slice(desde)
  const corte = resto.search(/PERIFERIA/)
  const segmento = resto.slice(0, corte >= 0 ? corte : 300)
  let mejor: { pais: Pais; indice: number } | null = null
  for (const { pais, re } of PAIS_POR_PALABRA) {
    const idx = segmento.search(re)
    if (idx >= 0 && (!mejor || idx < mejor.indice)) mejor = { pais, indice: idx }
  }
  return mejor?.pais ?? null
}

function paisPorMoneda(moneda: Moneda | null, conf: Confianza): Pais | null {
  const mapa: Partial<Record<Moneda, Pais>> = { COP: "CO", PEN: "PE", PAB: "PA", HNL: "HN" }
  const pais = moneda ? mapa[moneda] : undefined
  if (pais) conf.pais = 0.6
  return pais ?? null
}

function extraerObjeto(parrafos: string[]): { texto: string | null; confianza: number } {
  const p = parrafos.find((x) => /\bOBJETO\b/.test(x))
  const crudo = p?.match(/OBJETO\.\s*(.+)/s)?.[1]
  if (!crudo) return { texto: null, confianza: 0 }
  let limpio = crudo
    .replace(/\s+/g, " ")
    .replace(/^EL CONTRATISTA\s+(?:se obliga a ejecutar|se obliga a prestar|prestará(?:\s+el servicio de|\s+servicios de)?)\s+/i, "")
    .replace(/\.$/, "")
    .trim()
  limpio = limpio.charAt(0).toLocaleUpperCase("es") + limpio.slice(1)
  if (limpio.length <= 200) return { texto: limpio, confianza: 0.9 }
  const corte = limpio.slice(0, 200)
  return { texto: corte.slice(0, corte.lastIndexOf(" ")).trimEnd(), confianza: 0.85 }
}

interface ValorExtraido {
  valor: number | null
  indeterminado: boolean
  moneda: Moneda | null
  confValor: number
  confMoneda: number
}

function esMoneda(c: string): c is Moneda {
  return (MONEDAS as readonly string[]).includes(c)
}

function extraerValor(parrafos: string[], texto: string, obs: string[]): ValorExtraido {
  const pValor = parrafos.find((x) => /\bVALOR\b/.test(x)) ?? ""
  if (/no tiene (?:un )?valor determinado|valor indeterminado|por demanda|cuant[íi]a indeterminada/i.test(pValor || texto)) {
    obs.push("Contrato por demanda: el valor se define en cada orden de servicio; se registra 0.")
    const m = monedaAproximada(texto)
    return { valor: 0, indeterminado: true, moneda: m, confValor: 0.5, confMoneda: m ? 0.85 : 0 }
  }
  const enParentesis = /\(\s*([A-Z]{3})\s*\$?\s*(\d[\d.,]*)\s*\)/g
  const enLinea = /\b(COP|USD|PEN|PAB|HNL)\s*\$?\s*(\d[\d.,]*)/g
  for (const [origen, re] of [[pValor, enParentesis], [texto, enParentesis], [texto, enLinea]] as const) {
    for (const m of origen.matchAll(re)) {
      const codigo = m[1] ?? ""
      if (["NIT", "RUC", "RTN", "IVA"].includes(codigo)) continue
      if (!esMoneda(codigo)) throw new Error(`Moneda desconocida: "${codigo}". Monedas válidas: ${MONEDAS.join(", ")}`)
      const valor = parseMonto(m[2] ?? "")
      if (valor === null) continue
      return { valor, indeterminado: false, moneda: codigo, confValor: 0.97, confMoneda: 0.97 }
    }
  }
  const m = monedaAproximada(texto)
  return { valor: null, indeterminado: false, moneda: m, confValor: 0, confMoneda: m ? 0.6 : 0 }
}

function monedaAproximada(texto: string): Moneda | null {
  const codigo = texto.match(/\b(COP|USD|PEN|PAB|HNL)\b/)?.[1]
  if (codigo && esMoneda(codigo)) return codigo
  return MONEDA_POR_PALABRA.find(({ re }) => re.test(texto))?.moneda ?? null
}

interface PlazoExtraido {
  inicio: string | null
  fin: string | null
  confInicio: number
  confFin: number
}

function extraerPlazo(parrafos: string[], texto: string, obs: string[]): PlazoExtraido {
  const vacio: PlazoExtraido = { inicio: null, fin: null, confInicio: 0, confFin: 0 }
  const p = parrafos.find((x) => /\bPLAZO\b/.test(x))
  if (!p) return vacio
  const fechas = fechasEnTexto(p)
  const meses = Number(p.match(/\((\d{1,3})\)\s+mes/i)?.[1] ?? 0)
  if (/desde/i.test(p) && fechas.length >= 2) {
    return { inicio: fechas[0] ?? null, fin: fechas[1] ?? null, confInicio: 0.95, confFin: 0.95 }
  }
  if (fechas.length === 1 && !/desde/i.test(p)) {
    return { ...vacio, fin: fechas[0] ?? null, confFin: 0.95 }
  }
  if (meses > 0) return plazoPorMeses(parrafos, texto, meses, obs)
  return vacio
}

/** Plazo en meses "a partir de la firma": inicio y fin se derivan, así que bajan de confianza. */
function plazoPorMeses(parrafos: string[], texto: string, meses: number, obs: string[]): PlazoExtraido {
  const pFirma = parrafos.find((x) => /se firma|para constancia/i.test(x)) ?? texto
  const completa = fechasEnTexto(pFirma)[0]
  if (completa) {
    obs.push(`Plazo de ${meses} meses desde la firma (${completa}); fecha_fin derivada.`)
    return { inicio: completa, fin: sumarMeses(completa, meses), confInicio: 0.9, confFin: 0.6 }
  }
  const mes = mesEnTexto(pFirma)
  if (!mes) return { inicio: null, fin: null, confInicio: 0, confFin: 0 }
  const inicio = ultimoDiaDelMes(mes.anio, mes.mes)
  obs.push(
    `Solo se indica el mes de firma (${mes.anio}-${String(mes.mes).padStart(2, "0")}): fecha_inicio asumida = ${inicio}; ` +
      `fecha_fin = inicio + ${meses} meses. Confirmar con el comercial.`,
  )
  return { inicio, fin: sumarMeses(inicio, meses), confInicio: 0.8, confFin: 0.5 }
}

interface PolizaExtraida {
  requiere: boolean | null
  tipos: string
  confianza: number
}

function extraerPoliza(parrafos: string[], texto: string, esOtrosi: boolean, obs: string[]): PolizaExtraida {
  const tiposDe = (s: string): string => TIPOS_POLIZA.filter(({ re }) => re.test(s)).map((t) => t.tipo).join(";")
  if (esOtrosi) {
    const p = parrafos.find((x) => /garant[íi]as|p[óo]liza/i.test(x))
    if (!p) return { requiere: null, tipos: "", confianza: 0 }
    obs.push("El otrosí indica que las garantías existentes deben ampliarse en vigencia.")
    return { requiere: true, tipos: tiposDe(p), confianza: 0.85 }
  }
  const pGarantia = parrafos.find((x) => /\bGARANT[ÍI]AS\b/.test(x)) ?? ""
  const menciona = /p[óo]liza/i.test(pGarantia)
  if (!menciona) {
    return { requiere: false, tipos: "", confianza: /p[óo]liza/i.test(texto) ? 0.5 : 0.85 }
  }
  if (/cuyo valor supere|para cada orden/i.test(pGarantia)) {
    obs.push("La póliza es condicional (solo para órdenes de servicio sobre cierto monto); no aplica al contrato marco.")
    return { requiere: false, tipos: "", confianza: 0.8 }
  }
  return { requiere: true, tipos: tiposDe(pGarantia), confianza: 0.95 }
}

