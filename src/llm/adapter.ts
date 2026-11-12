/**
 * Interfaz propia del proveedor LLM. El ciclo del agente solo conoce estos tipos:
 * cambiar de proveedor = escribir otra implementación de ProveedorLLM, sin tocar el ciclo.
 */

export type Bloque =
  | { tipo: "texto"; texto: string }
  | { tipo: "herramienta"; id: string; nombre: string; args: unknown }
  | { tipo: "resultado"; id: string; contenido: string; error?: boolean }

export interface MensajeLLM {
  rol: "system" | "user" | "assistant"
  contenido: Bloque[]
  /** Contenido nativo del proveedor (p. ej. bloques de razonamiento) que debe devolverse tal cual. Opaco para el ciclo. */
  crudo?: unknown
}

export interface HerramientaLLM {
  nombre: string
  descripcion: string
  esquema: Record<string, unknown>
}

export type MotivoFin = "fin" | "herramientas" | "limite_tokens" | "rechazo"

export interface RespuestaLLM {
  mensaje: MensajeLLM
  fin: MotivoFin
  uso: { entrada: number; salida: number }
}

export interface OpcionesEnvio {
  /** Impide nuevas llamadas a herramientas (para cerrar el turno al llegar al tope de iteraciones). */
  sinHerramientas?: boolean
}

export interface ProveedorLLM {
  readonly nombre: string
  readonly modelo: string
  enviar(mensajes: MensajeLLM[], herramientas: HerramientaLLM[], opciones?: OpcionesEnvio): Promise<RespuestaLLM>
}

/** Error del proveedor con mensaje ya redactado para el usuario (nunca incluye claves). */
export class ErrorProveedor extends Error {
  constructor(mensaje: string, public readonly reintentable = false) {
    super(mensaje)
    this.name = "ErrorProveedor"
  }
}
