import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs"
import { dirname, extname, join } from "node:path"
import { parseCsv, serializarCsv } from "./csv.js"
import {
  ESTADOS_POLIZA, FUENTES, MONEDAS, PAISES,
  type Cambios, type Comercial, type Correo, type FilaMaestro,
} from "./tipos.js"

/** Todo el acceso a disco vive aquí: fixtures/ solo se lee, out/ es lo único que se escribe. */

export const COLUMNAS: ReadonlyArray<keyof FilaMaestro> = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin",
  "requiere_poliza", "tipo_poliza", "estado_poliza", "comercial", "ruta_sharepoint", "fecha_registro", "fuente",
]

export interface Rutas {
  fixtures: string
  buzon: string
  maestroFixture: string
  comerciales: string
  out: string
  sharepoint: string
  maestro: string
  historial: string
  procesados: string
  log: string
  alertas: string
}

export function rutas(directory: string): Rutas {
  const fixtures = join(directory, "fixtures", "reto-02")
  const out = join(directory, "out")
  const sharepoint = join(out, "sharepoint")
  return {
    fixtures,
    buzon: join(fixtures, "buzon"),
    maestroFixture: join(fixtures, "maestro-contratos.csv"),
    comerciales: join(fixtures, "comerciales.json"),
    out,
    sharepoint,
    maestro: join(sharepoint, "maestro-contratos.csv"),
    historial: join(sharepoint, "historial.jsonl"),
    procesados: join(out, "procesados.json"),
    log: join(out, "log.jsonl"),
    alertas: join(out, "alertas.md"),
  }
}

/** Borra out/ completo (demo determinista y reinicio del servidor). */
export function reiniciarOut(directory: string): void {
  rmSync(rutas(directory).out, { recursive: true, force: true })
}

/** RN6: la primera vez copia el fixture a out/sharepoint/; el fixture nunca se modifica. */
export function asegurarSharepoint(directory: string): void {
  const r = rutas(directory)
  mkdirSync(r.sharepoint, { recursive: true })
  if (!existsSync(r.maestro)) copyFileSync(r.maestroFixture, r.maestro)
}

// ---------- Maestro ----------

function aFila(cabecera: string[], celdas: string[]): FilaMaestro {
  const g = (c: string): string => celdas[cabecera.indexOf(c)] ?? ""
  const pais = g("pais")
  const moneda = g("moneda")
  const estado = g("estado_poliza")
  const fuente = g("fuente")
  if (!(PAISES as readonly string[]).includes(pais)) throw new Error(`Maestro: país inválido "${pais}" en ${g("id_contrato")}`)
  if (!(MONEDAS as readonly string[]).includes(moneda)) throw new Error(`Maestro: moneda inválida "${moneda}" en ${g("id_contrato")}`)
  if (!(ESTADOS_POLIZA as readonly string[]).includes(estado)) throw new Error(`Maestro: estado_poliza inválido "${estado}"`)
  if (!(FUENTES as readonly string[]).includes(fuente)) throw new Error(`Maestro: fuente inválida "${fuente}"`)
  return {
    id_contrato: g("id_contrato"),
    cliente: g("cliente"),
    nit_cliente: g("nit_cliente"),
    pais: pais as FilaMaestro["pais"],
    objeto: g("objeto"),
    valor: Number(g("valor")),
    moneda: moneda as FilaMaestro["moneda"],
    fecha_inicio: g("fecha_inicio"),
    fecha_fin: g("fecha_fin"),
    requiere_poliza: g("requiere_poliza") === "true",
    tipo_poliza: g("tipo_poliza"),
    estado_poliza: estado as FilaMaestro["estado_poliza"],
    comercial: g("comercial"),
    ruta_sharepoint: g("ruta_sharepoint"),
    fecha_registro: g("fecha_registro"),
    fuente: fuente as FilaMaestro["fuente"],
  }
}

export function leerMaestro(directory: string): FilaMaestro[] {
  asegurarSharepoint(directory)
  const [cabecera, ...filas] = parseCsv(readFileSync(rutas(directory).maestro, "utf8"))
  if (!cabecera) throw new Error("El maestro está vacío o no tiene encabezados")
  return filas.map((f) => aFila(cabecera, f))
}

export function escribirMaestro(directory: string, filas: FilaMaestro[]): void {
  const destino = rutas(directory).maestro
  const matriz = [[...COLUMNAS], ...filas.map((f) => COLUMNAS.map((c) => String(f[c])))]
  const temporal = `${destino}.tmp`
  writeFileSync(temporal, serializarCsv(matriz), "utf8")
  renameSync(temporal, destino)
}

// ---------- Procesados, historial y log ----------

export interface Procesado {
  ts: string
  accion: string
  id_contrato: string | null
  motivo?: string
}

export function leerProcesados(directory: string): Record<string, Procesado> {
  const ruta = rutas(directory).procesados
  if (!existsSync(ruta)) return {}
  return JSON.parse(readFileSync(ruta, "utf8")) as Record<string, Procesado>
}

export function marcarProcesado(directory: string, mensajeId: string, dato: Omit<Procesado, "ts">): void {
  const r = rutas(directory)
  mkdirSync(r.out, { recursive: true })
  const actual = leerProcesados(directory)
  actual[mensajeId] = { ts: new Date().toISOString(), ...dato }
  writeFileSync(r.procesados, JSON.stringify(actual, null, 2), "utf8")
}

export interface EntradaHistorial {
  id_contrato: string
  accion: string
  cambios: Cambios
  mensaje_id: string
}

export function agregarHistorial(directory: string, e: EntradaHistorial): void {
  asegurarSharepoint(directory)
  appendFileSync(rutas(directory).historial, JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n", "utf8")
}

export function agregarLog(
  directory: string,
  e: { herramienta: string; mensaje_id: string | null; ok: boolean; resumen: string },
): void {
  const r = rutas(directory)
  mkdirSync(r.out, { recursive: true })
  appendFileSync(r.log, JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n", "utf8")
}

// ---------- Buzón (solo lectura) ----------

const ID_MENSAJE = /^[A-Za-z0-9_-]+$/

export function listarIdsBuzon(directory: string): string[] {
  const { buzon } = rutas(directory)
  if (!existsSync(buzon)) return []
  return readdirSync(buzon, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

export function leerCorreo(directory: string, mensajeId: string): Correo {
  if (!ID_MENSAJE.test(mensajeId)) throw new Error(`mensaje_id inválido: "${mensajeId}"`)
  const ruta = join(rutas(directory).buzon, mensajeId, "correo.json")
  if (!existsSync(ruta)) throw new Error(`No existe el mensaje "${mensajeId}" en el buzón`)
  const c = JSON.parse(readFileSync(ruta, "utf8")) as Partial<Correo>
  return {
    id: c.id ?? mensajeId,
    de: c.de ?? "",
    para: c.para ?? "",
    asunto: c.asunto ?? "",
    fecha: c.fecha ?? "",
    cuerpo: c.cuerpo ?? "",
    adjuntos: Array.isArray(c.adjuntos) ? c.adjuntos : [],
  }
}

export interface AdjuntoContrato {
  nombre: string
  rutaAbsoluta: string
  texto: string
}

export interface ResultadoAdjuntos {
  contrato: AdjuntoContrato | null
  motivo: string | null
}

const NOMBRE_CONTRATO = /contrato|otros[ií]|adenda|prorroga/i
const TEXTO_CONTRATO = /^\s*(CONTRATO|OTROS[ÍI]|ADENDA|PR[ÓO]RROGA)/i

/** Decide cuál adjunto es el contrato (por nombre o por encabezado del texto) o por qué no hay ninguno. */
export function buscarContrato(directory: string, correo: Correo): ResultadoAdjuntos {
  if (correo.adjuntos.length === 0) return { contrato: null, motivo: "El correo no trae adjuntos" }
  const carpeta = join(rutas(directory).buzon, correo.id)
  let hayCotizacion = false
  for (const nombre of correo.adjuntos) {
    const ruta = join(carpeta, nombre)
    if (!ID_ADJUNTO.test(nombre) || !existsSync(ruta)) continue
    const texto = readFileSync(ruta, "utf8")
    if (/cotizaci/i.test(nombre) || /^\s*COTIZACI[ÓO]N/i.test(texto)) hayCotizacion = true
    else if (NOMBRE_CONTRATO.test(nombre) || TEXTO_CONTRATO.test(texto)) {
      return { contrato: { nombre, rutaAbsoluta: ruta, texto }, motivo: null }
    }
  }
  const motivo = hayCotizacion
    ? "El adjunto es una cotización, no un contrato firmado"
    : `Ningún adjunto es un contrato u otrosí (adjuntos: ${correo.adjuntos.join(", ")})`
  return { contrato: null, motivo }
}
const ID_ADJUNTO = /^\w[\w .-]*$/

export function leerComerciales(directory: string): Comercial[] {
  return JSON.parse(readFileSync(rutas(directory).comerciales, "utf8")) as Comercial[]
}

// ---------- Archivo SharePoint simulado ----------

/** Copia el documento a out/sharepoint/<rutaRelativa>; devuelve la ruta relativa. */
export function archivar(directory: string, origen: string, rutaRelativa: string): string {
  const destino = join(rutas(directory).sharepoint, rutaRelativa)
  mkdirSync(dirname(destino), { recursive: true })
  copyFileSync(origen, destino)
  return rutaRelativa
}

export function extensionDe(nombre: string): string {
  return extname(nombre) || ".txt"
}
