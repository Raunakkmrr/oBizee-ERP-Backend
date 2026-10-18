import { handle } from "hono/aws-lambda";
import { createTenantApp } from "./tenant/app.ts";

export const handler = handle(createTenantApp());
