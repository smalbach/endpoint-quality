import { JSDOM } from "jsdom";
import handlebarsSource from "handlebars/dist/handlebars.min.js?raw";

import { frameDocument } from "@/lib/visualizer-frame";

/** The frame's page, run as a browser would run it: its scripts included. */
function render(template: string, data: unknown, options = "{}") {
  const dom = new JSDOM(frameDocument({ template, data: JSON.stringify(data), options }, handlebarsSource), {
    runScripts: "dangerously",
  });
  return dom.window;
}

describe("el documento del visualizador", () => {
  test("dibuja la plantilla con sus datos, y escapa lo que viene de la respuesta", () => {
    const window = render("<ul>{{#each items}}<li>{{name}}</li>{{/each}}</ul>", {
      items: [{ name: "Ana" }, { name: "<b>Luis</b>" }],
    });
    const items = [...window.document.querySelectorAll("li")].map((item) => item.innerHTML);
    expect(items).toEqual(["Ana", "&lt;b&gt;Luis&lt;/b&gt;"]);
  });

  test("un </script> en los datos o en la plantilla no cierra el script que los lleva", () => {
    const window = render("<p id='t'>{{texto}}</p>", { texto: "</script><script>window.roto = 1</script>" });
    expect(window.document.getElementById("t")?.textContent).toBe("</script><script>window.roto = 1</script>");
    expect((window as unknown as { roto?: number }).roto).toBeUndefined();
  });

  test("pm.getData entrega los datos a los scripts de la plantilla, como en Postman", async () => {
    const window = render(
      "<p id='t'></p><script>pm.getData(function (error, data) { document.getElementById('t').textContent = data.total; });</script>",
      { total: 7 },
    );
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    expect(window.document.getElementById("t")?.textContent).toBe("7");
  });

  test("una plantilla rota dice por qué, dentro del marco", () => {
    const window = render("{{#each items}}sin cerrar", { items: [] });
    expect(window.document.body.textContent).toMatch(/La plantilla no se pudo dibujar/);
  });

  test("las opciones llegan a Handlebars", () => {
    const window = render("<p id='t'>{{html}}</p>", { html: "<i>x</i>" }, '{"noEscape":true}');
    expect(window.document.getElementById("t")?.innerHTML).toBe("<i>x</i>");
  });
});
