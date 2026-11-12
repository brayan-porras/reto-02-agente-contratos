/**
 * Genera modulo/ (bonus 9.4) a partir de las MISMAS fuentes que usa la app:
 *   agent/prompt.md                      → modulo/agent.md (prompt + frontmatter)
 *   src/knowledge/registro-contratos.md  → modulo/skill/registro-contratos/SKILL.md
 *   src/tools/contratos.ts (+ src/core)  → modulo/tools/contratos.ts (un solo archivo, sin servidor)
 * Uso: npx tsx scripts/build-modulo.ts   (el test verifica que modulo/ esté sincronizado)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"

const normalizar = (s: string): string => s.replace(/\r\n/g, "\n")

const AGENT_FRONTMATTER = `---
description: Agente de registro de contratos vigentes. Lee el buzón, extrae y valida contratos, los registra en el maestro y genera alertas, pidiendo confirmación humana en campos de baja confianza.
mode: primary
permission:
  edit: deny
  bash: deny
---
`

const SKILL_FRONTMATTER = `---
name: registro-contratos
description: Proceso de registro de contratos vigentes - clasificación (nuevo, actualización, duplicado, rechazado), umbral de confianza 0.8, pólizas, remitentes y alertas de vencimiento.
---
`

export async function construirModulo(raiz: string): Promise<Record<string, string>> {
  const leer = (ruta: string): string => normalizar(readFileSync(join(raiz, ruta), "utf8"))
  const resultado = await build({
    entryPoints: [join(raiz, "src", "tools", "contratos.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    external: ["zod"],
    write: false,
    legalComments: "none",
    banner: { js: "// GENERADO por scripts/build-modulo.ts desde src/tools/contratos.ts y src/core/. No editar a mano.\n// Dependencia: zod (peer). Sin servidor HTTP ni proveedor LLM." },
  })
  const herramientas = normalizar(resultado.outputFiles[0]?.text ?? "")
  return {
    "agent.md": `${AGENT_FRONTMATTER}\n${leer("agent/prompt.md")}`,
    "skill/registro-contratos/SKILL.md": `${SKILL_FRONTMATTER}\n${leer("src/knowledge/registro-contratos.md")}`,
    "tools/contratos.ts": herramientas,
  }
}

async function main(): Promise<void> {
  const raiz = process.cwd()
  const archivos = await construirModulo(raiz)
  for (const [ruta, contenido] of Object.entries(archivos)) {
    const destino = join(raiz, "modulo", ruta)
    mkdirSync(dirname(destino), { recursive: true })
    writeFileSync(destino, contenido, "utf8")
    console.log(`modulo/${ruta}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
