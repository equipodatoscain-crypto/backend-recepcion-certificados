const express = require("express");
const sql = require("mssql");

const app = express();

app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

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
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    },
    requestTimeout: 120000
  };
}

let poolPromise = null;
async function getPool() {
  if (!poolPromise) poolPromise = sql.connect(getSqlConfig());
  return poolPromise;
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/test-db", async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query("SELECT 1 AS ok");
    res.json({ ok: true, result: r.recordset });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/next-id-grupo", async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT ISNULL(MAX(id_grupo),0)+1 AS next_id_grupo
      FROM dbo.recepcion_certificados
    `);
    res.json({ ok: true, id_grupo: r.recordset[0].next_id_grupo });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =====================================================
   ✅ VEHICULOS (SOLO EXISTENCIA)
===================================================== */
app.get("/vehiculo-existe/:placa", async (req, res) => {
  const placa = (req.params.placa || "").toUpperCase().trim();

  try {
    const pool = await getPool();
    const r = await pool.request()
      .input("placa", sql.NVarChar(20), placa)
      .query(`SELECT 1 FROM dbo.vehiculos WHERE placa = @placa`);

    res.json({ ok: true, exists: r.recordset.length > 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =====================================================
   CONDUCTORES
===================================================== */
app.get("/existe-conductor/:cedula", async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input("cedula", sql.VarChar(50), req.params.cedula)
      .query(`SELECT 1 FROM dbo.conductores WHERE cedulaconductor = @cedula`);

    res.json({ ok: true, exists: r.recordset.length > 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =====================================================
   AAR
===================================================== */
app.get("/existe-aar/:cedula", async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input("cedula", sql.VarChar(50), req.params.cedula)
      .query(`SELECT 1 FROM dbo.aar WHERE cedulaaar = @cedula`);

    res.json({ ok: true, exists: r.recordset.length > 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =====================================================
   RECEPCION CERTIFICADOS (✅ AHORA GUARDA CONDUCTORES/AAR Y ESTADOS)
   ⚠ IMPORTANTE: en SQL Server deben existir estas columnas en dbo.recepcion_certificados:
   - conductor1..conductor5 (INT)
   - aar1..aar5 (INT)
   - estadoconductor1..estadoconductor5 (NVARCHAR)
   - estadoaar1..estadoaar5 (NVARCHAR)
===================================================== */
app.post("/recepcion-certificados", async (req, res) => {
  try {
    const { id_grupo, registros } = req.body;
    if (!Array.isArray(registros) || registros.length === 0) {
      return res.status(400).json({ ok: false, error: "No hay registros" });
    }

    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      for (const row of registros) {
        const r = new sql.Request(tx);

        // === Campos base ===
        r.input("fecha_creacion", sql.Date, new Date());
        r.input("anio", sql.Int, row.año);
        r.input("mes", sql.NVarChar(50), row.mes);
        r.input("numero_de_contrato_oc", sql.NVarChar(50), row.numero_de_contrato_oc);
        r.input("numero_ruta", sql.NVarChar(50), row.numero_ruta);
        r.input("fecha_servicio", sql.Date, row.fecha_servicio ? new Date(row.fecha_servicio) : null);
        r.input("placa_recorrido_1", sql.NVarChar(20), row.placa_recorrido_1);
        r.input("placa_recorrido_2", sql.NVarChar(20), row.placa_recorrido_2);
        r.input("observacion", sql.NVarChar(255), row.observacion);
        r.input("observacion_general", sql.NVarChar(255), row.observacion_general);
        r.input("responsable", sql.NVarChar(100), row.responsable);
        r.input("estado", sql.NVarChar(50), row.estado);
        r.input("id_grupo", sql.Int, row.id_grupo ?? id_grupo);
        r.input("maximo_transportado", sql.Int, row.maximo_transportado);
        r.input("ocupacion_0_r1", sql.NVarChar(5), row.ocupacion_0_r1);
        r.input("ocupacion_0_r2", sql.NVarChar(5), row.ocupacion_0_r2);

        // === ✅ NUEVO: conductores / aar (INT) ===
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

        // === ✅ NUEVO: estados (NVARCHAR) ===
        r.input("estadoconductor1", sql.NVarChar(50), row.estadoconductor1 ?? null);
        r.input("estadoconductor2", sql.NVarChar(50), row.estadoconductor2 ?? null);
        r.input("estadoconductor3", sql.NVarChar(50), row.estadoconductor3 ?? null);
        r.input("estadoconductor4", sql.NVarChar(50), row.estadoconductor4 ?? null);
        r.input("estadoconductor5", sql.NVarChar(50), row.estadoconductor5 ?? null);

        r.input("estadoaar1", sql.NVarChar(50), row.estadoaar1 ?? null);
        r.input("estadoaar2", sql.NVarChar(50), row.estadoaar2 ?? null);
        r.input("estadoaar3", sql.NVarChar(50), row.estadoaar3 ?? null);
        r.input("estadoaar4", sql.NVarChar(50), row.estadoaar4 ?? null);
        r.input("estadoaar5", sql.NVarChar(50), row.estadoaar5 ?? null);

        // === ✅ INSERT con nuevas columnas ===
        await r.query(`
          INSERT INTO dbo.recepcion_certificados (
            fecha_creacion, año, mes, numero_de_contrato_oc, numero_ruta,
            fecha_servicio, placa_recorrido_1, placa_recorrido_2,
            observacion, observacion_general, responsable, estado,
            id_grupo, maximo_transportado, ocupacion_0_r1, ocupacion_0_r2,

            conductor1, conductor2, conductor3, conductor4, conductor5,
            aar1, aar2, aar3, aar4, aar5,
            estadoconductor1, estadoconductor2, estadoconductor3, estadoconductor4, estadoconductor5,
            estadoaar1, estadoaar2, estadoaar3, estadoaar4, estadoaar5
          ) VALUES (
            @fecha_creacion, @anio, @mes, @numero_de_contrato_oc, @numero_ruta,
            @fecha_servicio, @placa_recorrido_1, @placa_recorrido_2,
            @observacion, @observacion_general, @responsable, @estado,
            @id_grupo, @maximo_transportado, @ocupacion_0_r1, @ocupacion_0_r2,

            @conductor1, @conductor2, @conductor3, @conductor4, @conductor5,
            @aar1, @aar2, @aar3, @aar4, @aar5,
            @estadoconductor1, @estadoconductor2, @estadoconductor3, @estadoconductor4, @estadoconductor5,
            @estadoaar1, @estadoaar2, @estadoaar3, @estadoaar4, @estadoaar5
          )
        `);
      }

      await tx.commit();
      res.json({ ok: true });

    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor corriendo en puerto", PORT));
