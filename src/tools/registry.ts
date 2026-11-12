import { z } from "zod"
import * as contratos from "./contratos.js"
import type { ContextoHerramienta } from "./contratos.js"

export type { ContextoHerramienta }

export interface Herramienta {
  /** Nombre que ve el modelo: <archivo>_<export> */
  nombre: string
  description: string
  jsonSchema: Record<string, unknown>
  ejecutar(argsCrudos: unknown, ctx: ContextoHerramienta): Promise<string>
}

interface DefinicionCruda {
  description: string
  args: z.ZodRawShape
  execute: (args: never, ctx: ContextoHerramienta) => Promise<string>
}

/** Convierte cada export de src/tools/contratos.ts en una herramienta validada con zod. */
export function cargarHerramientas(): Herramienta[] {
  return Object.entries(contratos as Record<string, DefinicionCruda>).map(([exportado, def]) => {
    const schema = z.object(def.args)
    const { $schema: _omitido, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>
    return {
      nombre: `contratos_${exportado}`,
      description: def.description,
      jsonSchema,
      async ejecutar(argsCrudos: unknown, ctx: ContextoHerramienta): Promise<string> {
        const parsed = schema.safeParse(argsCrudos ?? {})
        if (!parsed.success) {
          const detalle = parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
          return JSON.stringify({ ok: false, error: `Argumentos inválidos para contratos_${exportado}: ${detalle}` })
        }
        return def.execute(parsed.data as never, ctx)
      },
    }
  })
}
