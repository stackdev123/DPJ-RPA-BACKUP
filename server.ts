import express, { Request, Response, NextFunction } from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import os from "os";

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        if (iface) {
            for (let i = 0; i < iface.length; i++) {
                const alias = iface[i];
                if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                    return alias.address;
                }
            }
        }
    }
    return '0.0.0.0';
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Health check
  app.get("/api/health", (req: Request, res: Response) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // Manual Trigger for testing (optional, but helpful)
  app.post("/api/admin/capture-stock", async (req: Request, res: Response) => {
     try {
       const [{ db }, { calculateStockValuation }] = await Promise.all([
         import("./apiClient"),
         import("./valuationService"),
       ]);
       const data = await db.getInitialData();
       const val = calculateStockValuation(data.invoices, data.currentStock);
       const dateStr = new Date().toISOString().split('T')[0];
       await db.upsertEarlyStock(dateStr, val, "MANUAL_TRIGGER");
       res.json({ success: true, date: dateStr, value: val });
     } catch (err: any) {
       res.status(500).json({ error: err.message });
     }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vitePromise = createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: "spa",
    });
    vitePromise.catch((err) => {
      console.error("Failed to initialize Vite dev server:", err);
    });
    app.use((req: Request, res: Response, next: NextFunction) => {
      vitePromise
        .then((vite) => vite.middlewares(req, res, next))
        .catch(next);
    });
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.use((req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    const localIP = getLocalIP();
    console.log(`\n  \x1b[32mDPJ RPA SYSTEM v1.0.0\x1b[0m\n`);
    console.log(`  ➜  Local:   \x1b[36mhttp://localhost:${PORT}/\x1b[0m`);
    console.log(`  ➜  Network: \x1b[36mhttp://${localIP}:${PORT}/\x1b[0m\n`);
  });
}

startServer();
