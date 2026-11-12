import { similitud } from "./numeros.js"
import {
  UMBRAL_CONFIANZA,
  type Cambios, type CampoContrato, type Comercial, type Contrato, type FilaMaestro,
} from "./tipos.js"

export type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado"

export interface Remitente {
  email: string
  comercial: string | null
  conocido: boolean
}

export interface ResultadoValidacion {
  clasificacion: Clasificacion
  id_contrato_existente?: string
  requiere_revision: string[]
  diferencias?: Cambios
  motivo?: string
  remitente: Remitente
  observaciones: string[]
}

/** Campos que un contrato nuevo necesita con confianza suficiente (RN5). */
export const CAMPOS_OBLIGATORIOS: readonly CampoContrato[] = [
  "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza",
]

/** Campos que una actualización puede cambiar en la fila existente (RN1/RN2). */
export const CAMPOS_COMPARABLES = ["valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza"] as const
type CampoComparable = (typeof CAMPOS_COMPARABLES)[number]

const UMBRAL_OBJETO = 0.9

export function resolverRemitente(email: string, comerciales: Comercial[]): Remitente {
  const c = comerciales.find((x) => x.email.toLowerCase() === email.trim().toLowerCase())
  return { email, comercial: c?.nombre ?? null, conocido: Boolean(c) }
}

export function validarContrato(
  contrato: Contrato | null,
  motivoSinContrato: string | null,
  maestro: FilaMaestro[],
  remitente: Remitente,
): ResultadoValidacion {
  const base = { requiere_revision: [], remitente, observaciones: [] as string[] }
  const avisos = remitente.conocido ? [] : [`Remitente no registrado en comerciales.json: ${remitente.email}`]

  if (!contrato) {
    return { ...base, clasificacion: "rechazado", motivo: motivoSinContrato ?? "Sin adjunto de contrato", observaciones: avisos }
  }
  if (!contrato.cliente && !contrato.objeto) {
    return {
      ...base,
      clasificacion: "rechazado",
      motivo: "El texto no contiene partes ni objeto identificables",
      observaciones: avisos,
    }
  }

  const observaciones = [...avisos, ...contrato.observaciones]
  const existente = buscarExistente(contrato, maestro)
  if (!existente) {
    return { ...base, clasificacion: "nuevo", requiere_revision: revisarNuevo(contrato), observaciones }
  }

  const diferencias = compararConFila(contrato, existente)
  const hayCambios = Object.keys(diferencias).length > 0
  const conflictos = conflictosConMaestro(contrato, existente)
  const identificacion = { id_contrato_existente: existente.id_contrato, observaciones }

  if (!hayCambios) {
    return { ...base, ...identificacion, clasificacion: "duplicado", requiere_revision: [], motivo: "Ya existe con los mismos valor y fechas" }
  }
  return {
    ...base,
    ...identificacion,
    clasificacion: "actualizacion",
    diferencias,
    requiere_revision: [...revisarCamposPresentes(contrato), ...conflictos],
  }
}

function buscarExistente(c: Contrato, maestro: FilaMaestro[]): FilaMaestro | undefined {
  if (c.id_contrato) {
    const porId = maestro.find((f) => f.id_contrato === c.id_contrato)
    if (porId) return porId
  }
  if (!c.nit_cliente || !c.objeto) return undefined
  const objeto = c.objeto
  return maestro.find((f) => f.nit_cliente === c.nit_cliente && similitud(f.objeto, objeto) >= UMBRAL_OBJETO)
}

function etiqueta(campo: string, conf: number): string {
  return `${campo} (confianza ${conf.toFixed(2)})`
}

function revisarNuevo(c: Contrato): string[] {
  const dudosos = CAMPOS_OBLIGATORIOS.filter((campo) => (c.confianza[campo] ?? 0) < UMBRAL_CONFIANZA)
  const revision = dudosos.map((campo) => etiqueta(campo, c.confianza[campo] ?? 0))
  if (c.fecha_inicio && c.fecha_fin && c.fecha_fin < c.fecha_inicio) {
    revision.push("fecha_fin: es anterior a fecha_inicio")
  }
  return revision
}

function revisarCamposPresentes(c: Contrato): string[] {
  return CAMPOS_COMPARABLES.filter((campo) => c[campo] !== null && (c.confianza[campo] ?? 0) < UMBRAL_CONFIANZA).map(
    (campo) => etiqueta(campo, c.confianza[campo] ?? 0),
  )
}

function conflictosConMaestro(c: Contrato, f: FilaMaestro): string[] {
  const conflictos: string[] = []
  if (c.nit_cliente && c.nit_cliente !== f.nit_cliente) {
    conflictos.push(`conflicto: nit_cliente ${c.nit_cliente} difiere del maestro (${f.nit_cliente})`)
  }
  const fin = c.fecha_fin ?? f.fecha_fin
  const inicio = c.fecha_inicio ?? f.fecha_inicio
  if (fin < inicio) conflictos.push("conflicto: fecha_fin resultante es anterior a fecha_inicio")
  return conflictos
}

const conjunto = (s: string): string => s.split(";").map((x) => x.trim()).filter(Boolean).sort().join(";")

/** Solo compara lo que el documento trae (un otrosí no repite todos los campos). */
export function compararConFila(c: Contrato, f: FilaMaestro): Cambios {
  const cambios: Cambios = {}
  for (const campo of CAMPOS_COMPARABLES) {
    const nuevo = c[campo]
    if (nuevo === null || nuevo === undefined) continue
    if (campo === "tipo_poliza" && conjunto(String(nuevo)) === "") continue
    const actual: FilaMaestro[CampoComparable] = f[campo]
    const igual = campo === "tipo_poliza" ? conjunto(String(nuevo)) === conjunto(String(actual)) : nuevo === actual
    if (!igual) cambios[campo] = { antes: actual, despues: nuevo }
  }
  return cambios
}
