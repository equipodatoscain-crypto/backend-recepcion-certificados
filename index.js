const express = require("express");
const sql = require("mssql");

const app = express();
app.use(express.json());

// ✅ (Opcional pero recomendado) CORS simple
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // luego lo restringimos a tu dominio
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ✅ Render usa PORT
const PORT = process.env.PORT || 10000;

// ✅ Config por variables de entorno (las que ya creaste en Render)
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  port: Number(process.env.DB_PORT || 1433),
  database: process.env.DB_NAME,
  options: {
    encrypt: false, // en on-prem normalmente false
    trustServerCertificate: true,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

let poolPromise;
function getPool() {
  if (!poolPromise) poolPromise = sql.connect(dbConfig);
  return poolPromise;
}

// ✅ Health
app.get("/", (req, res) => res.send("Backend activo ✅"));
app.get("/health", (req, res) => res.json({ ok: true }));

// ✅ Test DB
app.get("/test-db", async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query("SELECT 1 as ok");
    res.json({ ok: true, result: result.recordset });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* =========================================================
   ✅ SABANA_RUTAS (lectura)
   Tabla: dbo.sabana_rutas
   Columnas (según tu captura): id, created_at, año, mes, [Segmento Operación], Proveedor, [Código Ruta], Estado
========================================================= */
app.get("/sabana_rutas", async (req, res) => {
  try {
    const { anio, mes } = req.query;

    let where = [];
    if (anio) where.push("año = @anio");
    if (mes) where.push("UPPER(mes) = UPPER(@mes)");

    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const pool = await getPool();
    const request = pool.request();
    if (anio) request.input("anio", sql.Int, Number(anio));
    if (mes) request.input("mes", sql.VarChar(50), String(mes));

    const q = `
      SELECT *
      FROM dbo.sabana_rutas
      ${sqlWhere}
      ORDER BY id DESC
    `;

    const result = await request.query(q);
    res.json({ ok: true, data: result.recordset });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* =========================================================
   ✅ RECEPCION_CERTIFICADOS
   Tabla: dbo.recepcion_certificados
   Soporta:
   - POST: insertar registros (varios días) con el mismo id_grupo
   - GET por id_grupo (para area_operativa)
   - DELETE por id_grupo (para botón ELIMINAR)
========================================================= */

// ✅ Obtener siguiente id_grupo (máximo + 1)
app.get("/next-id-grupo", async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool
      .request()
      .query("SELECT ISNULL(MAX(id_grupo), 0) + 1 as nextId FROM dbo.recepcion_certificados");
    res.json({ ok: true, nextId: r.recordset[0].nextId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ✅ Insertar registros (array)
app.post("/recepcion_certificados", async (req, res) => {
  try {
    const rows = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ ok: false, error: "Body debe ser un array con registros" });
    }

    const pool = await getPool();

    // Insert uno por uno (simple y confiable)
    // Luego si quieres lo optimizamos a bulk insert.
    for (const r of rows) {
      const request = pool.request();

      request.input("fecha_creacion", sql.Date, r.fecha_creacion ? new Date(r.fecha_creacion) : new Date());
      request.input("anio", sql.Int, Number(r.año));
      request.input("mes", sql.NVarChar(255), r.mes);
      request.input("numero_de_contrato_oc", sql.NVarChar(255), r.numero_de_contrato_oc);
      request.input("numero_ruta", sql.NVarChar(255), r.numero_ruta);
      request.input("fecha_servicio", sql.Date, new Date(r.fecha_servicio));
      request.input("placa_recorrido_1", sql.NVarChar(255), r.placa_recorrido_1 ?? null);
      request.input("placa_recorrido_2", sql.NVarChar(255), r.placa_recorrido_2 ?? null);
      request.input("observacion", sql.NVarChar(255), r.observacion ?? null);
      request.input("observacion_general", sql.NVarChar(255), r.observacion_general ?? null);
      request.input("responsable", sql.NVarChar(255), r.responsable ?? null);
      request.input("estado", sql.NVarChar(255), r.estado ?? null);

      request.input("vehiculo1", sql.NVarChar(255), r.vehiculo1 ?? null);
      request.input("vehiculo2", sql.NVarChar(255), r.vehiculo2 ?? null);

      request.input("id_grupo", sql.Int, Number(r.id_grupo));
      request.input("maximo_transportado", sql.Int, r.maximo_transportado ?? null);

      request.input("ocupacion_0_r1", sql.NVarChar(255), r.ocupacion_0_r1 ?? null);
      request.input("ocupacion_0_r2", sql.NVarChar(255), r.ocupacion_0_r2 ?? null);

      await request.query(`
        INSERT INTO dbo.recepcion_certificados
        (fecha_creacion, año, mes, numero_de_contrato_oc, numero_ruta, fecha_servicio,
         placa_recorrido_1, placa_recorrido_2, observacion, observacion_general, responsable, estado,
         vehiculo1, vehiculo2, id_grupo, maximo_transportado, ocupacion_0_r1, ocupacion_0_r2)
        VALUES
        (@fecha_creacion, @anio, @mes, @numero_de_contrato_oc, @numero_ruta, @fecha_servicio,
         @placa_recorrido_1, @placa_recorrido_2, @observacion, @observacion_general, @responsable, @estado,
         @vehiculo1, @vehiculo2, @id_grupo, @maximo_transportado, @ocupacion_0_r1, @ocupacion_0_r2)
      `);
    }

    res.json({ ok: true, inserted: rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ✅ Consultar por id_grupo
app.get("/recepcion_certificados/grupo/:id_grupo", async (req, res) => {
  try {
    const id_grupo = Number(req.params.id_grupo);
    const pool = await getPool();

    const result = await pool
      .request()
      .input("id_grupo", sql.Int, id_grupo)
      .query(`
        SELECT *
        FROM dbo.recepcion_certificados
        WHERE id_grupo = @id_grupo
        ORDER BY fecha_servicio ASC
      `);

    res.json({ ok: true, data: result.recordset });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ✅ Eliminar todo el grupo
app.delete("/recepcion_certificados/grupo/:id_grupo", async (req, res) => {
  try {
    const id_grupo = Number(req.params.id_grupo);
    const pool = await getPool();

    const result = await pool
      .request()
      .input("id_grupo", sql.Int, id_grupo)
      .query(`DELETE FROM dbo.recepcion_certificados WHERE id_grupo = @id_grupo`);

    res.json({ ok: true, deleted: result.rowsAffected?.[0] ?? 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});
