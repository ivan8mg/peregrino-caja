# Conectar la app con Google Sheets

Se hace una sola vez. La computadora y el celular quedan conectados a la misma hoja.

## 1. Crea la hoja
1. Entra a https://sheets.new con tu cuenta de Google.
2. Ponle de nombre **Peregrino datos**.

## 2. Pega el script
1. En la hoja, abre **Extensiones > Apps Script**.
2. Borra lo que aparece y pega todo el contenido de [Codigo.gs](https://github.com/ivan8mg/peregrino-caja/blob/main/google-sheets/Codigo.gs) (botón "Copy raw file" arriba a la derecha).
3. En la línea `const CLAVE = "cambia-esta-clave";` cambia el texto entre comillas por una palabra secreta, por ejemplo `"peregrino-libros-2026"`.
4. Guarda (ícono de disquete).

## 3. Publícalo
1. Arriba a la derecha: **Implementar > Nueva implementación**.
2. En el engrane de "Seleccionar tipo", elige **Aplicación web**.
3. Ejecutar como: **Yo**. Quién tiene acceso: **Cualquier persona**.
4. **Implementar** y autoriza con tu cuenta. Google dirá que la app no está verificada: da clic en **Configuración avanzada > Ir a … (no seguro)**. Es tu propio script.
5. Copia la **URL de la aplicación web** (termina en `/exec`).

## 4. Conecta cada equipo
1. En la app, pestaña **Respaldo > Google Sheets**.
2. Pega la URL y escribe la clave. **Conectar**.
3. El primer equipo que se conecta llena la hoja con el catálogo. Después conecta el otro equipo.
   Si en un equipo hiciste ventas de prueba, marca "Borrar las ventas de prueba" antes de conectar.

## Qué hay en la hoja
- **Productos**: catálogo con precio y existencia. Si cambias aquí un precio o una existencia, llega a los dos equipos en la siguiente sincronización.
- **Ventas**: una fila por venta. **Lineas**: una fila por libro vendido (buena para tablas dinámicas).
- **Movimientos**: cada entrada y salida de existencia.

No borres ni cambies el orden de las columnas, y no edites las hojas Ventas, Lineas ni Movimientos a mano.

Si algún día cambias el script, publícalo en **Implementar > Gestionar implementaciones > Editar > Nueva versión** para conservar la misma URL.
