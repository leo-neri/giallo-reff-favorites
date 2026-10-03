# Giallo reff favorites (app proxy)

Stateless Node app that reads and writes the customer metafield:

- namespace: `giallo`
- key: `favorite_reffs`
- value: `{ "handles": ["post-handle"] }`

## Setup

1. Create a custom app in the Shopify admin (or Partner Dashboard).
2. Grant Admin API scopes: `read_customers`, `write_customers`.
3. Create a customer metafield definition:
   - Namespace: `giallo`
   - Key: `favorite_reffs`
   - Type: JSON
4. Configure App proxy:
   - Subpath prefix: `apps`
   - Subpath: `reff-favorites`
   - Proxy URL: `https://YOUR-HOST/`
5. Deploy this folder (Render/Fly/Railway) with env vars from `.env.example`.
6. Install the app on the store and confirm `GET /apps/reff-favorites` returns JSON when logged in.

The theme calls `/apps/reff-favorites` on the shop domain. Shopify signs the request and forwards it here with `logged_in_customer_id`.
