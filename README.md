# Librería Peregrino · Caja

Punto de venta que funciona sin internet. Se instala como app en la computadora y en el celular desde https://ivan8mg.github.io/peregrino-caja/

- Cada equipo guarda todo en su navegador (IndexedDB) y funciona sin internet. Opcionalmente se sincroniza con una hoja de Google Sheets del dueño: ver [google-sheets/INSTRUCCIONES.md](google-sheets/INSTRUCCIONES.md).
- Haz un respaldo cada semana desde la pestaña **Respaldo**.
- `data/catalogo-inicial.js` es el catálogo con el que arranca la app, generado desde Excel con `python3 tools/importar_excel.py catalogo.xlsx inventario.xlsx data/catalogo-inicial.js`.
- Al cambiar archivos de la app, sube la versión en `sw.js` (`peregrino-vN`) para que los equipos instalados se actualicen.
