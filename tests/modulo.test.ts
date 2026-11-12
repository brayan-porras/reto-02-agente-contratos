import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import { construirModulo } from "../scripts/build-modulo.js"

describe("modulo/ (bonus) sincronizado con la app", () => {
  it("agent.md, SKILL.md y tools/contratos.ts son los generados desde las fuentes de la app", async () => {
    const raiz = process.cwd()
    const esperado = await construirModulo(raiz)
    for (const [ruta, contenido] of Object.entries(esperado)) {
      const actual = readFileSync(join(raiz, "modulo", ruta), "utf8").replace(/\r\n/g, "\n")
      assert.equal(actual, contenido, `modulo/${ruta} está desactualizado: ejecuta "npm run build:modulo"`)
    }
  })

  it("el prompt y el conocimiento del módulo contienen el texto exacto de la app", () => {
    const raiz = process.cwd()
    const leer = (r: string): string => readFileSync(join(raiz, r), "utf8").replace(/\r\n/g, "\n")
    assert.ok(leer("modulo/agent.md").includes(leer("agent/prompt.md")))
    assert.ok(leer("modulo/skill/registro-contratos/SKILL.md").includes(leer("src/knowledge/registro-contratos.md")))
  })
})
