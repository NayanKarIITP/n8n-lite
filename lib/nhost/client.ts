// lib/nhost/client.ts
//
// Single Nhost client instance shared by the whole frontend. Uses
// NEXT_PUBLIC_* env vars because this file is imported into client
// components (see README Environment Variables).

import { NhostClient } from "@nhost/nhost-js";

export const nhost = new NhostClient({
  subdomain: process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || "local",
  region: process.env.NEXT_PUBLIC_NHOST_REGION || "",
});
