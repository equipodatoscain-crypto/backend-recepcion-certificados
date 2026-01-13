const express = require("express");
const sql = require("mssql");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Config SQL Server desde variables de entorno (Render)
const dbConfig = {
  server: process.env.DB_SERVER,
  port: parseInt(process.env.DB_PORT || "1433", 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: String(process.env.DB_ENCRYPT || "false").toLowerCase() === "true",
    trustServerCertificate: true, // evita errores de certificado cuando encrypt=false o certificados internos
  },
  pool: {
    max: 5,
    min: 0,
    idleTimeoutMillis: 30000,
  },
  connectionTimeout: 15000,
  requestTimeout: 15000,
};

// Ruta básica para confirmar que el backend vive
app.get("/", (req, res) => {
  res.send("Backend activo");
});

// Ruta de prueba de conexión a SQL Server
app.get("/test-db", async (req, res) => {
  try {
    const pool = await sql.connect(dbConfig);
    const result = await pool.request().query("SELECT 1 AS ok");
    res.json({ ok: true, result: result.recordset });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  } finally {
    // Cierra conexiones abiertas para evitar fugas
    try { await sql.close(); } catch (e) {}
  }
});

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});
