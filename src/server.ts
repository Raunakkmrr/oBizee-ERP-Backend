import { serve } from "@hono/node-server";
import { app } from "./app.ts";

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`oBizee ERP API on :${port} · otp provider ${process.env.OTP_PROVIDER}`);
