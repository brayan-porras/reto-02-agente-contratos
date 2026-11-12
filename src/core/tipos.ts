import { z } from "zod"

export const PAISES = ["CO", "EC", "PE", "PA", "HN"] as const
export const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const
export const ESTADOS_POLIZA = ["vigente", "pendiente", "vencida", "no_aplica"] as const
export const FUENTES = ["buzon", "manual", "migracion"] as const

export type Pais = (typeof PAISES)[number]
export type Moneda = (typeof MONEDAS)[number]
export type EstadoPoliza = (typeof ESTADOS_POLIZA)[number]
export type Fuente = (typeof FUENTES)[number]

/** Umbral por debajo del cual un campo exige revisión humana (RN5). */
export const UMBRAL_CONFIANZA = 0.8

const fechaIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "formato YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "fecha inválida")

/** Campos del contrato que llevan confianza propia. */
export const CAMPOS_CONTRATO = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
] as const
export type CampoContrato = (typeof CAMPOS_CONTRATO)[number]

export const ContratoSchema = z.object({
  id_contrato: z.string().nullable().describe("Número del contrato tal como aparece; null si no existe"),
  cliente: z.string().nullable().describe("Razón social de la contraparte (EL CONTRATANTE)"),
  nit_cliente: z.string().nullable().describe("Identificador tributario sin puntos ni dígito de verificación"),
  pais: z.enum(PAISES).nullable(),
  objeto: z.string().max(200).nullable().describe("Objeto del contrato, máx. 200 caracteres"),
  valor: z.number().nullable().describe("Valor sin separadores; 0 si es por demanda"),
  valor_indeterminado: z.boolean().describe("true si el contrato no tiene valor determinado"),
  moneda: z.enum(MONEDAS).nullable(),
  fecha_inicio: fechaIso.nullable(),
  fecha_fin: fechaIso.nullable(),
  requiere_poliza: z.boolean().nullable(),
  tipo_poliza: z.string().nullable().describe("Lista separada por ';'; vacío si no requiere"),
  es_otrosi: z.boolean().describe("true si el documento es un otrosí / modificación"),
  amplia_poliza: z.boolean().describe("true si el documento exige ampliar la vigencia de las pólizas"),
  observaciones: z.array(z.string()).describe("Advertencias de la extracción para el humano"),
  confianza: z
    .record(z.string(), z.number().min(0).max(1))
    .describe("Confianza [0,1] por campo; 0 cuando el campo no está en el texto"),
})
export type Contrato = z.infer<typeof ContratoSchema>

export interface FilaMaestro {
  id_contrato: string
  cliente: string
  nit_cliente: string
  pais: Pais
  objeto: string
  valor: number
  moneda: Moneda
  fecha_inicio: string
  fecha_fin: string
  requiere_poliza: boolean
  tipo_poliza: string
  estado_poliza: EstadoPoliza
  comercial: string
  ruta_sharepoint: string
  fecha_registro: string
  fuente: Fuente
}

export interface Correo {
  id: string
  de: string
  para: string
  asunto: string
  fecha: string
  cuerpo: string
  adjuntos: string[]
}

export interface Comercial {
  email: string
  nombre: string
  region: string
}

export interface Cambio {
  antes: string | number | boolean | null
  despues: string | number | boolean | null
}
export type Cambios = Record<string, Cambio>
