'use strict';

const crypto = require('crypto');
const express = require('express');

const PORT = Number(process.env.PORT || 3000);
const SHOP = (process.env.SHOPIFY_SHOP || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const STATIC_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN || '';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY || '';
const API_SECRET = process.env.SHOPIFY_API_SECRET || '';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
const METAFIELD_NAMESPACE = process.env.METAFIELD_NAMESPACE || 'giallo';
const METAFIELD_KEY = process.env.METAFIELD_KEY || 'favorite_reffs';

let cachedToken = STATIC_ADMIN_TOKEN || '';
let cachedTokenExpiresAt = STATIC_ADMIN_TOKEN ? Number.POSITIVE_INFINITY : 0;

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '32kb' }));

async function getAdminToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) {
    return cachedToken;
  }

  if (STATIC_ADMIN_TOKEN) {
    cachedToken = STATIC_ADMIN_TOKEN;
    cachedTokenExpiresAt = Number.POSITIVE_INFINITY;
    return cachedToken;
  }

  if (!SHOP || !CLIENT_ID || !API_SECRET) {
    const err = new Error('missing_shop_credentials');
    err.status = 500;
    throw err;
  }

  const response = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: API_SECRET
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const err = new Error('token_request_failed');
    err.status = 502;
    err.details = payload;
    throw err;
  }

  cachedToken = payload.access_token;
  cachedTokenExpiresAt = Date.now() + Number(payload.expires_in || 86399) * 1000;
  return cachedToken;
}

function sendJson(res, status, body) {
  res.status(status).type('application/json').send(JSON.stringify(body));
}

function verifyAppProxySignature(query) {
  if (!API_SECRET) return false;
  const signature = query.signature;
  if (!signature || typeof signature !== 'string') return false;

  const pairs = Object.keys(query)
    .filter((key) => key !== 'signature')
    .sort()
    .map((key) => {
      const value = query[key];
      const normalized = Array.isArray(value) ? value.join(',') : String(value);
      return `${key}=${normalized}`;
    })
    .join('');

  const digest = crypto.createHmac('sha256', API_SECRET).update(pairs).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(signature, 'utf8'));
  } catch (e) {
    return false;
  }
}

function requireProxyAuth(req, res, next) {
  if (!verifyAppProxySignature(req.query)) {
    return sendJson(res, 401, { error: 'invalid_signature' });
  }

  const customerId = String(req.query.logged_in_customer_id || '').trim();
  if (!customerId || customerId === '0') {
    return sendJson(res, 401, { error: 'login_required' });
  }

  req.customerId = customerId;
  next();
}

async function shopifyAdminGraphql(query, variables) {
  if (!SHOP) {
    const err = new Error('missing_shop_credentials');
    err.status = 500;
    throw err;
  }

  const adminToken = await getAdminToken();
  const response = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminToken
    },
    body: JSON.stringify({ query, variables })
  });

  const payload = await response.json();
  if (!response.ok || payload.errors) {
    const err = new Error('shopify_admin_error');
    err.status = 502;
    err.details = payload.errors || payload;
    throw err;
  }
  return payload.data;
}

function normalizeHandles(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (e) {
      return [];
    }
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const list = Array.isArray(parsed.handles) ? parsed.handles : [];
  const seen = new Set();
  const handles = [];
  list.forEach((item) => {
    const handle = String(item || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\-_/]/g, '');
    if (!handle || seen.has(handle)) return;
    seen.add(handle);
    handles.push(handle);
  });
  return handles;
}

async function readFavoriteState(customerId) {
  const data = await shopifyAdminGraphql(
    `query FavoriteReffs($id: ID!, $namespace: String!, $key: String!) {
      customer(id: $id) {
        id
        metafield(namespace: $namespace, key: $key) {
          id
          value
          compareDigest
        }
      }
    }`,
    {
      id: `gid://shopify/Customer/${customerId}`,
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY
    }
  );

  const metafield = data && data.customer ? data.customer.metafield : null;
  return {
    handles: normalizeHandles(metafield && metafield.value),
    compareDigest: metafield && metafield.compareDigest ? metafield.compareDigest : null
  };
}

async function writeFavoriteHandles(customerId, handles, compareDigest) {
  const metafieldInput = {
    ownerId: `gid://shopify/Customer/${customerId}`,
    namespace: METAFIELD_NAMESPACE,
    key: METAFIELD_KEY,
    type: 'json',
    value: JSON.stringify({ handles: handles })
  };

  if (compareDigest === null || typeof compareDigest === 'string') {
    metafieldInput.compareDigest = compareDigest;
  }

  const data = await shopifyAdminGraphql(
    `mutation SetFavoriteReffs($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          value
          compareDigest
        }
        userErrors {
          field
          message
          code
        }
      }
    }`,
    { metafields: [metafieldInput] }
  );

  const result = data.metafieldsSet;
  const errors = (result && result.userErrors) || [];
  if (errors.length) {
    const conflict = errors.some(
      (error) =>
        error.code === 'COMPARE_DIGEST_MISMATCH' ||
        /compare.?digest/i.test(error.message || '')
    );
    const err = new Error(conflict ? 'conflict' : 'metafield_write_failed');
    err.status = conflict ? 409 : 502;
    err.details = errors;
    throw err;
  }

  const metafield = result.metafields && result.metafields[0];
  return {
    handles: normalizeHandles(metafield && metafield.value),
    compareDigest: metafield && metafield.compareDigest ? metafield.compareDigest : null
  };
}

async function mutateFavorites(customerId, handle, action) {
  const normalizedHandle = String(handle || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_/]/g, '');
  if (!normalizedHandle) {
    const err = new Error('invalid_handle');
    err.status = 400;
    throw err;
  }
  if (action !== 'add' && action !== 'remove' && action !== 'toggle') {
    const err = new Error('invalid_action');
    err.status = 400;
    throw err;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readFavoriteState(customerId);
    const set = new Set(current.handles);
    const had = set.has(normalizedHandle);
    let nextAction = action;
    if (action === 'toggle') {
      nextAction = had ? 'remove' : 'add';
    }

    if (nextAction === 'add') set.add(normalizedHandle);
    if (nextAction === 'remove') set.delete(normalizedHandle);

    const nextHandles = Array.from(set);
    if (nextHandles.length === current.handles.length && nextHandles.every((h, i) => h === current.handles[i])) {
      return {
        handles: current.handles,
        saved: set.has(normalizedHandle),
        handle: normalizedHandle
      };
    }

    try {
      const written = await writeFavoriteHandles(
        customerId,
        nextHandles,
        current.compareDigest
      );
      return {
        handles: written.handles,
        saved: written.handles.indexOf(normalizedHandle) !== -1,
        handle: normalizedHandle
      };
    } catch (err) {
      if (err.status === 409 && attempt < 2) continue;
      throw err;
    }
  }

  const err = new Error('conflict');
  err.status = 409;
  throw err;
}

app.get('/health', function (_req, res) {
  sendJson(res, 200, { ok: true });
});

function listHandler(req, res) {
  readFavoriteState(req.customerId)
    .then((state) => sendJson(res, 200, { handles: state.handles }))
    .catch((err) => {
      console.error('[reff-favorites] list failed', err.details || err.message || err);
      sendJson(res, err.status || 500, { error: err.message || 'server_error' });
    });
}

function mutateHandler(req, res) {
  const handle = req.body && req.body.handle;
  const action = (req.body && req.body.action) || 'toggle';
  mutateFavorites(req.customerId, handle, action)
    .then((state) => sendJson(res, 200, state))
    .catch((err) => {
      console.error('[reff-favorites] mutate failed', err.details || err.message || err);
      sendJson(res, err.status || 500, {
        error: err.message || 'server_error',
        details: err.details || undefined
      });
    });
}

// App proxy can forward to "/", "/apps/reff-favorites", or nested paths.
app.get(['/', '/apps/reff-favorites', '/apps/reff-favorites/'], requireProxyAuth, listHandler);
app.post(['/', '/apps/reff-favorites', '/apps/reff-favorites/'], requireProxyAuth, mutateHandler);
app.get('/proxy', requireProxyAuth, listHandler);
app.post('/proxy', requireProxyAuth, mutateHandler);

app.use(function (_req, res) {
  sendJson(res, 404, { error: 'not_found' });
});

app.listen(PORT, function () {
  console.log(`[reff-favorites] listening on :${PORT}`);
  if (!SHOP || !API_SECRET || (!STATIC_ADMIN_TOKEN && !CLIENT_ID)) {
    console.warn(
      '[reff-favorites] missing SHOPIFY_SHOP, SHOPIFY_API_SECRET, and either SHOPIFY_ADMIN_API_ACCESS_TOKEN or SHOPIFY_CLIENT_ID'
    );
  }
});
