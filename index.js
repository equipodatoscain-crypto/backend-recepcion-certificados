const express = require("express");
const sql = require("mssql");

const app = express();

// --- Middleware
app.use(express.json({ limit: "10mb" }));

// CORS simple
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// --- Config SQL Server (Render Environment)
function getSqlConfig() {
  return {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT || "1433", 10),
    database: process.env.DB_NAME,
    options: {
      encrypt: false,
      trustServerCertificate: true
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 120000
  };
}

// --- Pool
let poolPromise = null;
async function getPool() {
  if (!poolPromise) poolPromise = sql.connect(getSqlConfig());
  return poolPromise;
}

// Helpers
function toIntOrNull(v) {
  const s = (v ?? "").toString().trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}
function upper(v) {
  return (v ?? "").toString().trim().toUpperCase();
}

// --- Rutas base
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/test-db", async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query("SELECT 1 AS ok");
    res.json({ ok: true, result: result.recordset });
  } catch (err) {
    console.error("test-db error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/next-id-grupo", async (req, res) => {
  try {
    const pool = await getPool();
    const q = `
      SELECT ISNULL(MAX(id_grupo), 0) + 1 AS next_id_grupo
      FROM dbo.recepcion_certificados
    `;
    const r = await pool.request().query(q);
    res.json({ ok: true, id_grupo: r.recordset?.[0]?.next_id_grupo || 1 });
  } catch (err) {
    console.error("next-id-grupo error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =====================================================
   ✅ NUEVO: ENDPOINTS DE EXISTENCIA (SIN TRAER ESTADO)
===================================================== */

// vehiculos: existe por placa
app.get("/existe-vehiculo/:placa", async (req, res) => {
  try {
    const placa = upper(req.params.placa).replace(/[^A-Z0-9]/g, "");
    if (!placa) return res.json({ ok: true, exists: false });

    const pool = await getPool();
    const r = await pool.request()
      .input("placa", sql.VarChar(20), placa)
      .query(`SELECT TOP 1 placa FROM dbo.vehiculos WHERE placa = @placa`);

    return res.json({ ok: true, exists: (r.recordset?.length || 0) > 0 });
  } catch (err) {
    console.error("existe-vehiculo error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// conductores: existe por cedula
app.get("/existe-conductor/:cedula", async (req, res) => {
  try {
    const cedula = toIntOrNull(req.params.cedula);
    if (cedula === null) return res.json({ ok: true, exists: false });

    const pool = await getPool();
    const r = await pool.request()
      .input("cedula", sql.Int, cedula)
      .query(`SELECT TOP 1 cedulaconductor FROM dbo.conductores WHERE cedulaconductor = @cedula`);

    return res.json({ ok: true, exists: (r.recordset?.length || 0) > 0 });
  } catch (err) {
    console.error("existe-conductor error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// aar: existe por cedula
app.get("/existe-aar/:cedula", async (req, res) => {
  try {
    const cedula = toIntOrNull(req.params.cedula);
    if (cedula === null) return res.json({ ok: true, exists: false });

    const pool = await getPool();
    const r = await pool.request()
      .input("cedula", sql.Int, cedula)
      .query(`SELECT TOP 1 cedulaaar FROM dbo.aar WHERE cedulaaar = @cedula`);

    return res.json({ ok: true, exists: (r.recordset?.length || 0) > 0 });
  } catch (err) {
    console.error("existe-aar error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =====================================================
   ✅ POST /recepcion-certificados (INSERT + campos nuevos)
===================================================== */
app.post("/recepcion-certificados", async (req, res) => {
  try {
    const { id_grupo, registros } = req.body || {};

    if (!Array.isArray(registros) || registros.length === 0) {
      return res.status(400).json({ ok: false, error: "Body inválido: registros debe ser un array con datos." });
    }

    const pool = await getPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      for (const row of registros) {
        const r = new sql.Request(transaction);

        r.input("fecha_creacion", sql.Date, row.fecha_creacion ? new Date(row.fecha_creacion) : new Date());
        r.input("anio", sql.Int, row.año ?? row.anio ?? null);
        r.input("mes", sql.NVarChar(255), row.mes ?? null);
        r.input("numero_de_contrato_oc", sql.NVarChar(255), row.numero_de_contrato_oc ?? null);
        r.input("numero_ruta", sql.NVarChar(255), row.numero_ruta ?? null);
        r.input("fecha_servicio", sql.Date, row.fecha_servicio ? new Date(row.fecha_servicio) : null);
        r.input("placa_recorrido_1", sql.NVarChar(255), row.placa_recorrido_1 ?? null);
        r.input("placa_recorrido_2", sql.NVarChar(255), row.placa_recorrido_2 ?? null);
        r.input("observacion", sql.NVarChar(255), row.observacion ?? null);
        r.input("observacion_general", sql.NVarChar(255), row.observacion_general ?? null);
        r.input("responsable", sql.NVarChar(255), row.responsable ?? null);
        r.input("estado", sql.NVarChar(255), row.estado ?? null);
        r.input("vehiculo1", sql.NVarChar(255), row.vehiculo1 ?? null);
        r.input("vehiculo2", sql.NVarChar(255), row.vehiculo2 ?? null);
        r.input("id_grupo", sql.Int, row.id_grupo ?? id_grupo ?? null);
        r.input("maximo_transportado", sql.Int, row.maximo_transportado ?? null);
        r.input("ocupacion_0_r1", sql.NVarChar(255), row.ocupacion_0_r1 ?? null);
        r.input("ocupacion_0_r2", sql.NVarChar(255), row.ocupacion_0_r2 ?? null);

        // ✅ cédulas a guardar (si ya las tienes en la tabla)
        r.input("conductor1", sql.Int, row.conductor1 ?? null);
        r.input("conductor2", sql.Int, row.conductor2 ?? null);
        r.input("conductor3", sql.Int, row.conductor3 ?? null);
        r.input("conductor4", sql.Int, row.conductor4 ?? null);
        r.input("conductor5", sql.Int, row.conductor5 ?? null);

        r.input("aar1", sql.Int, row.aar1 ?? null);
        r.input("aar2", sql.Int, row.aar2 ?? null);
        r.input("aar3", sql.Int, row.aar3 ?? null);
        r.input("aar4", sql.Int, row.aar4 ?? null);
        r.input("aar5", sql.Int, row.aar5 ?? null);

        // ✅ NUEVO: estados a guardar (los campos que vas a crear)
        r.input("estadoconductor1", sql.NVarChar(255), row.estadoconductor1 ?? null);
        r.input("estadoconductor2", sql.NVarChar(255), row.estadoconductor2 ?? null);
        r.input("estadoconductor3", sql.NVarChar(255), row.estadoconductor3 ?? null);
        r.input("estadoconductor4", sql.NVarChar(255), row.estadoconductor4 ?? null);
        r.input("estadoconductor5", sql.NVarChar(255), row.estadoconductor5 ?? null);

        r.input("estadoaar1", sql.NVarChar(255), row.estadoaar1 ?? null);
        r.input("estadoaar2", sql.NVarChar(255), row.estadoaar2 ?? null);
        r.input("estadoaar3", sql.NVarChar(255), row.estadoaar3 ?? null);
        r.input("estadoaar4", sql.NVarChar(255), row.estadoaar4 ?? null);
        r.input("estadoaar5", sql.NVarChar(255), row.estadoaar5 ?? null);

        const insertQ = `
          INSERT INTO dbo.recepcion_certificados
          (
            fecha_creacion, año, mes, numero_de_contrato_oc, numero_ruta, fecha_servicio,
            placa_recorrido_1, placa_recorrido_2, observacion, observacion_general,
            responsable, estado, vehiculo1, vehiculo2, id_grupo, maximo_transportado,
            ocupacion_0_r1, ocupacion_0_r2,

            conductor1, conductor2, conductor3, conductor4, conductor5,
            aar1, aar2, aar3, aar4, aar5,

            estadoconductor1, estadoconductor2, estadoconductor3, estadoconductor4, estadoconductor5,
            estadoaar1, estadoaar2, estadoaar3, estadoaar4, estadoaar5
          )
          VALUES
          (
            @fecha_creacion, @anio, @mes, @numero_de_contrato_oc, @numero_ruta, @fecha_servicio,
            @placa_recorrido_1, @placa_recorrido_2, @observacion, @observacion_general,
            @responsable, @estado, @vehiculo1, @vehiculo2, @id_grupo, @maximo_transportado,
            @ocupacion_0_r1, @ocupacion_0_r2,

            @conductor1, @conductor2, @conductor3, @conductor4, @conductor5,
            @aar1, @aar2, @aar3, @aar4, @aar5,

            @estadoconductor1, @estadoconductor2, @estadoconductor3, @estadoconductor4, @estadoconductor5,
            @estadoaar1, @estadoaar2, @estadoaar3, @estadoaar4, @estadoaar5
          )
        `;

        await r.query(insertQ);
      }

      await transaction.commit();
      res.json({ ok: true, inserted: registros.length, id_grupo: id_grupo ?? registros[0]?.id_grupo ?? null });

    } catch (e) {
      await transaction.rollback();
      throw e;
    }

  } catch (err) {
    console.error("POST /recepcion-certificados error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 404 handler
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Ruta no encontrada", path: req.path });
});

// --- Listen
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor corriendo en puerto", PORT));
