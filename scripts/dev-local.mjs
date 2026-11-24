// Local development server for sandboxes where workerd cannot reach the internet directly but Node can
// (for example through an HTTPS proxy). Same as `wrangler dev`, except the Worker's outbound fetches
// (Turnstile siteverify, Access certs) are made by Node's fetch. Production is unaffected.
//
//   npm run build && NODE_USE_ENV_PROXY=1 node scripts/dev-local.mjs
import { unstable_startWorker } from "wrangler";

const port = Number(process.env.PORT ?? 8787);
const worker = await unstable_startWorker({
  config: "wrangler.jsonc",
  dev: {
    server: { hostname: "127.0.0.1", port },
    inspector: false,
    outboundService: (request) => globalThis.fetch(request.url, request),
  },
});
await worker.ready;
console.log(`Ready on http://localhost:${port}`);
process.on("SIGINT", async () => {
  await worker.dispose();
  process.exit(0);
});
