# PriceFlow storage API

The public page can use a server-backed storage API instead of keeping the full backend database in IndexedDB. Set `PRICEFLOW_STORAGE_API_URL` in `storage-config.js` to enable it.

The API must support these endpoints:

- `GET /backend/count` -> `{ "count": 123456 }`
- `POST /backend/import` with a multipart form field named `file` -> `{ "count": 123456 }`
- `GET /backend/export` -> CSV file download

The API should parse CSV/XLSX, normalize and upsert rows by ASIN, and stream the export. The browser may send `Authorization: Bearer <public client token>` when `PRICEFLOW_STORAGE_API_KEY` is configured.

Required public deployment protections:

- Keep database credentials and service-role secrets on the server only.
- Validate file size, file type, row count, and ASIN format on the server.
- Restrict CORS to the website origin.
- Add authentication, rate limiting, and audit logging to import endpoints.
- Use a database or object-storage pipeline designed for bulk records; do not return the full dataset from `/backend/count`.

When the API URL is blank or unavailable, the page falls back to its existing browser IndexedDB store.

## Cloudflare setup

The starter Worker is in `cloudflare-worker/`. Create an R2 bucket named `priceflow-backend` and a KV namespace, then replace the KV namespace ID in `cloudflare-worker/wrangler.toml`. Deploy with Wrangler:

```text
npx wrangler login
npx wrangler r2 bucket create priceflow-backend
npx wrangler kv namespace create BACKEND_META
npx wrangler secret put STORAGE_API_KEY
npx wrangler deploy
```

Set the deployed Worker URL in `storage-config.js`. Set `ALLOWED_ORIGIN` to the exact public website origin. The Worker accepts CSV uploads and counts rows while streaming the file into R2.
