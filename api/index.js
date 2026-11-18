const https = require('https');
const url = require('url');
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

// Carrega variáveis locais de ambiente se existirem
try {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.resolve(__dirname, '../.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        content.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const idx = trimmed.indexOf('=');
            if (idx > 0) {
                const k = trimmed.substring(0, idx).trim();
                const v = trimmed.substring(idx + 1).trim();
                if (!process.env[k]) process.env[k] = v;
            }
        });
    }
} catch (e) { }

const MP_BASE_URL = process.env.MP_BASE_URL || 'https://api.mercadopago.com';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const PLAN_ID = process.env.PLAN_ID || 'plano_unico_29';
const PLAN_NAME = process.env.PLAN_NAME || 'Plano Acesso Completo Cine Ultimate';
const PLAN_AMOUNT = parseFloat(process.env.PLAN_AMOUNT || '29.00');
const LEGACY_TEN_CUTOFF_MS = Date.parse('2026-11-15T06:00:00.000Z');

function formatBrl(amount) {
    const num = Number(amount);
    return Number.isFinite(num)
        ? `R$ ${num.toFixed(2).replace('.', ',')}`
        : 'R$ 29,00';
}

function isPaymentAmountValid(amount, createdAtIso = null) {
    const num = parseFloat(amount || '0');
    if (num >= (PLAN_AMOUNT - 0.05)) return true;
    // Proteção de transição: mantém válidos PIX de R$ 10,00 criados antes da mudança para R$ 29,00
    if (PLAN_AMOUNT > 10.00 && num >= 9.95 && createdAtIso) {
        const ts = Date.parse(createdAtIso);
        if (Number.isFinite(ts) && ts < LEGACY_TEN_CUTOFF_MS) {
            return true;
        }
    }
    return false;
}

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ivtpdmkyywoojbqnyusj.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

const TRIAL_PLAN_ID = 'trial_20d';
const TRIAL_DURATION_DAYS = 20;
const TRIAL_DURATION_MS = TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000;
const TRIAL_DEVICE_PREFIX = 'trial_dev:';

function hashDeviceFingerprint(rawDeviceId) {
    const clean = String(rawDeviceId || '').trim();
    if (clean.length < 8) return '';
    const crypto = require('crypto');
    return crypto
        .createHash('sha256')
        .update(`cine_ultimate_trial_v1|${clean}`)
        .digest('hex')
        .slice(0, 40);
}

function evaluateTrialEntitlement(ent) {
    if (!ent || ent.plan_id !== TRIAL_PLAN_ID || ent.status === 'active') {
        return {
            isTrial: false,
            isTrialActive: false,
            isTrialExpired: false,
            trialStartedAt: null,
            trialExpiresAt: null,
            trialExpiresAtMs: null,
            trialDaysRemaining: 0
        };
    }
    const startMs = Date.parse(ent.activated_at || ent.created_at || '');
    if (!Number.isFinite(startMs)) {
        return {
            isTrial: true,
            isTrialActive: false,
            isTrialExpired: true,
            trialStartedAt: null,
            trialExpiresAt: null,
            trialExpiresAtMs: 0,
            trialDaysRemaining: 0
        };
    }
    const expiresMs = startMs + TRIAL_DURATION_MS;
    const remainingMs = expiresMs - Date.now();
    const isTrialActive = remainingMs > 0;
    const trialDaysRemaining = isTrialActive
        ? Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)))
        : 0;
    return {
        isTrial: true,
        isTrialActive,
        isTrialExpired: !isTrialActive,
        trialStartedAt: new Date(startMs).toISOString(),
        trialExpiresAt: new Date(expiresMs).toISOString(),
        trialExpiresAtMs: expiresMs,
        trialDaysRemaining
    };
}

async function findDeviceTrialEntitlement(deviceHash) {
    if (!deviceHash) return null;
    const marker = `${TRIAL_DEVICE_PREFIX}${deviceHash}`;
    const res = await supaRest(
        `user_entitlements?select=email,status,user_id,plan_id,amount,activated_at,created_at,last_mp_payment_id&last_mp_payment_id=eq.${encodeURIComponent(marker)}&limit=1`
    ).catch(() => null);
    return (Array.isArray(res?.data) && res.data[0]) || null;
}

const recentSessions = new Map();
const approvedPaymentCache = new Map();
const approvedEmailCache = new Map();
const CACHE_TTL_MS = 2 * 60 * 1000;

function trimMapLimit(map, limit = 1000) {
    while (map.size > limit) {
        const oldestKey = map.keys().next().value;
        if (!oldestKey) break;
        map.delete(oldestKey);
    }
}

function rememberCheckoutSession(sessionId, mpPaymentId, email, extra = {}) {
    if (!sessionId) return;
    const prev = recentSessions.get(sessionId) || {};
    recentSessions.set(sessionId, {
        ...prev,
        ...(mpPaymentId ? { mpPaymentId: String(mpPaymentId) } : {}),
        ...(email ? { email: normalizeEmail(email) } : {}),
        ...extra,
        createdAt: prev.createdAt || Date.now(),
        updatedAt: Date.now()
    });
    trimMapLimit(recentSessions, 500);
}

function markSessionApprovedInMemory(mpPaymentId, email, hasAccount = null) {
    const pid = mpPaymentId ? String(mpPaymentId) : '';
    const normEmail = normalizeEmail(email);
    const now = Date.now();
    if (pid) {
        approvedPaymentCache.set(pid, { email: normEmail, ts: now });
        trimMapLimit(approvedPaymentCache, 1000);
        for (const [sid, entry] of recentSessions.entries()) {
            if (entry.mpPaymentId === pid || (normEmail && entry.email === normEmail)) {
                recentSessions.set(sid, {
                    ...entry,
                    mpPaymentId: pid,
                    email: normEmail || entry.email,
                    approved: true,
                    ...(hasAccount !== null ? { hasAccount: Boolean(hasAccount) } : {}),
                    updatedAt: now
                });
            }
        }
    }
    if (normEmail) {
        const prev = approvedEmailCache.get(normEmail);
        approvedEmailCache.set(normEmail, {
            isActive: true,
            hasAccount: hasAccount !== null ? Boolean(hasAccount) : Boolean(prev?.hasAccount),
            planId: prev?.planId || PLAN_ID,
            ts: now
        });
        trimMapLimit(approvedEmailCache, 1000);
    }
}

function getCachedApprovedPayment(paymentId) {
    const entry = approvedPaymentCache.get(String(paymentId || '').trim());
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        approvedPaymentCache.delete(String(paymentId || '').trim());
        return null;
    }
    return entry;
}

function getCachedApprovedEmail(email) {
    const key = normalizeEmail(email);
    const entry = approvedEmailCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        approvedEmailCache.delete(key);
        return null;
    }
    return entry;
}

async function activateApprovedPayment(mpPaymentId, email, knownHasAccount = null, existingEnt = null) {
    const cleanEmail = normalizeEmail(email);
    markSessionApprovedInMemory(mpPaymentId, cleanEmail, knownHasAccount);
    const now = new Date().toISOString();
    const writes = [];
    if (mpPaymentId) {
        writes.push(supaRest(`pix_payments?mp_payment_id=eq.${encodeURIComponent(String(mpPaymentId))}`, 'PATCH', {
            status: 'approved',
            approved_at: now,
            updated_at: now
        }));
    }
    if (cleanEmail) {
        const preserveDeviceMarker = String(existingEnt?.last_mp_payment_id || '').startsWith(TRIAL_DEVICE_PREFIX);
        writes.push(supaRest('user_entitlements?on_conflict=email', 'POST', {
            email: cleanEmail,
            plan_id: PLAN_ID,
            amount: PLAN_AMOUNT,
            status: 'active',
            ...(mpPaymentId && !preserveDeviceMarker ? { last_mp_payment_id: String(mpPaymentId) } : {}),
            activated_at: now,
            updated_at: now
        }, { 'Prefer': 'resolution=merge-duplicates' }));
    }
    if (writes.length > 0) {
        await Promise.all(writes);
    }
}

async function verifyPaymentEntitlement(email, hintPaymentId = null) {
    const cleanEmail = normalizeEmail(email);
    const cleanHintId = String(hintPaymentId || '').trim();

    let fallbackSessionMpId = '';
    for (const entry of recentSessions.values()) {
        if (normalizeEmail(entry.email) === cleanEmail && entry.mpPaymentId) {
            fallbackSessionMpId = entry.mpPaymentId;
        }
    }
    const directMpIdToCheck = cleanHintId || fallbackSessionMpId;

    // Executa consultas ao Supabase e (se houver paymentId) ao Mercado Pago em PARALELO (1 único RTT)
    const [entRes, payRes, directMpRes] = await Promise.all([
        supaRest(`user_entitlements?select=status,user_id,plan_id,amount,activated_at,created_at,last_mp_payment_id&email=eq.${encodeURIComponent(cleanEmail)}&limit=1`),
        supaRest(`pix_payments?select=mp_payment_id,email,amount,status,created_at&email=eq.${encodeURIComponent(cleanEmail)}&order=created_at.desc&limit=5`),
        directMpIdToCheck
            ? callMercadoPago('GET', `/v1/payments/${encodeURIComponent(directMpIdToCheck)}`).catch(() => null)
            : Promise.resolve(null)
    ]);

    const ent = Array.isArray(entRes?.data) && entRes.data[0];
    const hasAccount = Boolean(ent?.user_id);
    let isActive = ent?.status === 'active';

    if (isActive) {
        markSessionApprovedInMemory(null, cleanEmail, hasAccount);
        return {
            isActive: true,
            isPaid: true,
            isTrial: false,
            isTrialExpired: false,
            trialExpiresAt: null,
            trialExpiresAtMs: null,
            trialDaysRemaining: 0,
            ent,
            hasAccount
        };
    }

    const trialState = evaluateTrialEntitlement(ent);

    try {
        if (directMpRes) {
            const amountReceived = parseFloat(directMpRes?.transaction_amount || '0');
            const mpEmail = normalizeEmail(directMpRes?.metadata?.client_email || directMpRes?.payer?.email);
            if (
                directMpRes.status === 'approved' &&
                isPaymentAmountValid(amountReceived, directMpRes.date_created) &&
                (!mpEmail || mpEmail === cleanEmail)
            ) {
                isActive = true;
                await activateApprovedPayment(directMpIdToCheck, cleanEmail, hasAccount, ent);
                return {
                    isActive: true,
                    isPaid: true,
                    isTrial: false,
                    isTrialExpired: false,
                    trialExpiresAt: null,
                    trialExpiresAtMs: null,
                    trialDaysRemaining: 0,
                    ent,
                    hasAccount
                };
            }
        }

        const payments = Array.isArray(payRes?.data) ? payRes.data : [];
        const localApproved = payments.find(
            p => p && p.status === 'approved' && isPaymentAmountValid(p.amount, p.created_at)
        );
        if (localApproved) {
            isActive = true;
            await activateApprovedPayment(localApproved.mp_payment_id, cleanEmail, hasAccount, ent);
            return {
                isActive: true,
                isPaid: true,
                isTrial: false,
                isTrialExpired: false,
                trialExpiresAt: null,
                trialExpiresAtMs: null,
                trialDaysRemaining: 0,
                ent,
                hasAccount
            };
        }

        const mpIds = payments
            .map(p => p?.mp_payment_id)
            .filter(id => id && String(id) !== directMpIdToCheck)
            .slice(0, 3);
        if (mpIds.length > 0) {
            const mpResults = await Promise.all(
                mpIds.map(id => callMercadoPago('GET', `/v1/payments/${encodeURIComponent(id)}`).catch(() => null))
            );
            const validMp = mpResults.find(mpRes => {
                if (!mpRes || mpRes.status !== 'approved') return false;
                const amountReceived = parseFloat(mpRes.transaction_amount || '0');
                const mpEmail = normalizeEmail(mpRes.metadata?.client_email || mpRes.payer?.email);
                return isPaymentAmountValid(amountReceived, mpRes.date_created) && (!mpEmail || mpEmail === cleanEmail);
            });
            if (validMp) {
                isActive = true;
                await activateApprovedPayment(String(validMp.id), cleanEmail, hasAccount, ent);
                return {
                    isActive: true,
                    isPaid: true,
                    isTrial: false,
                    isTrialExpired: false,
                    trialExpiresAt: null,
                    trialExpiresAtMs: null,
                    trialDaysRemaining: 0,
                    ent,
                    hasAccount
                };
            }
        } else if (!trialState.isTrialActive) {
            // Último recurso se ainda não houver linha em pix_payments
            const searchRes = await callMercadoPago(
                'GET',
                `/v1/payments/search?status=approved&sort=date_created&criteria=desc&limit=15`
            ).catch(() => null);
            const candidates = Array.isArray(searchRes?.results) ? searchRes.results : [];
            const matched = candidates.find(p => {
                if (!p || p.status !== 'approved') return false;
                const amountReceived = parseFloat(p.transaction_amount || '0');
                const mpEmail = normalizeEmail(p.metadata?.client_email || p.payer?.email);
                return isPaymentAmountValid(amountReceived, p.date_created) && mpEmail === cleanEmail;
            });
            if (matched) {
                isActive = true;
                await activateApprovedPayment(String(matched.id), cleanEmail, hasAccount, ent);
                return {
                    isActive: true,
                    isPaid: true,
                    isTrial: false,
                    isTrialExpired: false,
                    trialExpiresAt: null,
                    trialExpiresAtMs: null,
                    trialDaysRemaining: 0,
                    ent,
                    hasAccount
                };
            }
        }
    } catch (e) { }

    if (trialState.isTrial) {
        return {
            isActive: trialState.isTrialActive,
            isPaid: false,
            isTrial: true,
            isTrialExpired: trialState.isTrialExpired,
            trialExpiresAt: trialState.trialExpiresAt,
            trialExpiresAtMs: trialState.trialExpiresAtMs,
            trialDaysRemaining: trialState.trialDaysRemaining,
            ent,
            hasAccount
        };
    }

    return {
        isActive,
        isPaid: isActive,
        isTrial: false,
        isTrialExpired: false,
        trialExpiresAt: null,
        trialExpiresAtMs: null,
        trialDaysRemaining: 0,
        ent,
        hasAccount
    };
}

// ── Chamada HTTPS Genérica ───────────────────────────────────────────────────
function httpRequest(targetUrl, options = {}, bodyObj = null) {
    return new Promise((resolve, reject) => {
        const parsed = new url.URL(targetUrl);
        const headers = options.headers || {};
        let payload = null;

        if (bodyObj) {
            payload = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
            headers['Content-Type'] = headers['Content-Type'] || 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const timeoutMs = options.timeoutMs || 6500;
        const req = https.request(parsed, {
            method: options.method || 'GET',
            headers,
            agent: httpsAgent,
            timeout: timeoutMs
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsedJson = null;
                try {
                    parsedJson = data ? JSON.parse(data) : {};
                } catch (e) {
                    parsedJson = { raw: data };
                }
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    data: parsedJson
                });
            });
        });

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Timeout após ${timeoutMs}ms`));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// ── Cliente Supabase REST (Privilegiado via service_role) ────────────────────
async function supaRest(pathWithQuery, method = 'GET', bodyObj = null, extraHeaders = {}) {
    const target = `${SUPABASE_URL}/rest/v1/${pathWithQuery.replace(/^\//, '')}`;
    const headers = {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        ...extraHeaders
    };
    return httpRequest(target, { method, headers }, bodyObj);
}

// ── Cliente Mercado Pago ─────────────────────────────────────────────────────
async function callMercadoPago(method, apiPath, bodyObj = null, idempotencyKey = null) {
    const target = apiPath.startsWith('http') ? apiPath : `${MP_BASE_URL}${apiPath}`;
    const crypto = require('crypto');
    const headers = {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Accept': 'application/json',
        'User-Agent': 'CineUltimate-Vercel/1.0'
    };
    if (method === 'POST') {
        headers['X-Idempotency-Key'] = idempotencyKey || crypto.randomUUID();
    }
    const res = await httpRequest(target, {
        method,
        headers
    }, bodyObj);

    if (res.status >= 200 && res.status < 300) {
        return res.data;
    }
    const errMsg = res.data?.message
        || (Array.isArray(res.data?.cause) && res.data.cause[0]?.description)
        || `Erro Mercado Pago (${res.status})`;
    const err = new Error(errMsg);
    err.status = res.status;
    err.details = res.data;
    throw err;
}

// ── Helper para ler o body da requisição HTTP (Vercel/Node) ──────────────────
function getRequestBody(req) {
    return new Promise((resolve) => {
        if (req.body && typeof req.body === 'object') {
            return resolve(req.body);
        }
        if (typeof req.body === 'string') {
            try { return resolve(JSON.parse(req.body)); } catch (e) { }
        }
        let raw = '';
        req.on('data', chunk => raw += chunk);
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch (e) {
                resolve({});
            }
        });
    });
}

function sendJson(res, statusCode, data) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
    res.end(JSON.stringify(data));
}

// ── HANDLER PRINCIPAL (Compatível com Vercel Serverless) ─────────────────────
module.exports = async function handler(req, res) {
    // Tratamento de CORS Preflight (OPTIONS)
    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
        res.end();
        return;
    }

    const parsedUrl = new url.URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';

    try {
        // 1. Health check
        if (pathname === '/api' || pathname === '/api/health') {
            return sendJson(res, 200, {
                status: 'online',
                app: 'Cine Ultimate Serverless Backend',
                region: 'sa-east-1 (São Paulo)',
                mercadopago: MP_ACCESS_TOKEN ? 'configured' : 'missing_token',
                supabase: SUPABASE_URL ? 'connected' : 'missing_url',
                plan: {
                    id: PLAN_ID,
                    name: PLAN_NAME,
                    amount: PLAN_AMOUNT,
                    formattedAmount: formatBrl(PLAN_AMOUNT)
                },
                now: new Date().toISOString()
            });
        }

        // 1.0.5 Fallback de versão de APK para auto-updater (GET /api/app/latest)
        if (pathname === '/api/app/latest' && req.method === 'GET') {
            const latestVersion = String(process.env.APP_LATEST_VERSION || '').trim();
            const latestApkUrl = String(process.env.APP_LATEST_APK_URL || '').trim();
            if (!latestVersion || !latestApkUrl) {
                return sendJson(res, 404, { ok: false, error: 'Nenhuma atualização direta configurada.' });
            }
            const channel = String(parsedUrl.searchParams.get('channel') || 'stable').toLowerCase();
            const latestName = String(process.env.APP_LATEST_NAME || `Cine Ultimate ${latestVersion}`).trim();
            const latestNotes = String(process.env.APP_LATEST_NOTES || '').trim();
            const latestSize = Number(process.env.APP_LATEST_APK_SIZE || 0) || null;
            const payload = {
                tag_name: latestVersion,
                name: latestName,
                body: latestNotes,
                draft: false,
                prerelease: Boolean(String(latestVersion).includes('-')),
                html_url: latestApkUrl,
                assets: [
                    {
                        name: String(process.env.APP_LATEST_APK_NAME || `cine-ultimate-${latestVersion}-universal.apk`).trim(),
                        browser_download_url: latestApkUrl,
                        size: latestSize,
                        content_type: 'application/vnd.android.package-archive'
                    }
                ]
            };
            return sendJson(res, 200, channel === 'beta' ? [payload] : payload);
        }

        // 1.1 Servir HTML caso a rota raiz caia no serverless
        if (pathname === '' || pathname === '/' || pathname === '/index.html') {
            try {
                const fs = require('fs');
                const path = require('path');
                let htmlPath = path.resolve(__dirname, '../public/index.html');
                if (!fs.existsSync(htmlPath)) htmlPath = path.resolve(__dirname, '../index.html');
                if (fs.existsSync(htmlPath)) {
                    const html = fs.readFileSync(htmlPath, 'utf8');
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/html; charset=utf-8');
                    res.end(html);
                    return;
                }
            } catch (e) { }
            return sendJson(res, 200, { status: 'online', app: 'Cine Ultimate' });
        }

        // 2. CRIAR COBRANÇA PIX (POST /api/pix/create)
        if (pathname === '/api/pix/create' && req.method === 'POST') {
            const body = await getRequestBody(req);
            const name = String(body.name || '').trim();
            const email = normalizeEmail(body.email);
            const lockedTrialEmail = normalizeEmail(body.lockedTrialEmail);
            const phone = String(body.phone || '').trim();
            const sessionId = String(body.sessionId || '').trim();
            const phoneDigits = phone.replace(/\D/g, '');

            if (name.length < 2) {
                return sendJson(res, 400, { ok: false, error: 'Informe seu nome completo.' });
            }
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return sendJson(res, 400, { ok: false, error: 'Informe um Gmail válido. Ele será seu login no aplicativo.' });
            }
            if (lockedTrialEmail && email !== lockedTrialEmail) {
                return sendJson(res, 403, {
                    ok: false,
                    code: 'TRIAL_EMAIL_MISMATCH',
                    error: `Para liberar seu acesso após o teste grátis, você deve usar obrigatoriamente o mesmo Gmail cadastrado no teste (${lockedTrialEmail}).`
                });
            }
            if (phoneDigits.length < 8) {
                return sendJson(res, 400, { ok: false, error: 'Informe um telefone/WhatsApp válido com DDD.' });
            }

            const nameParts = name.split(/\s+/);
            const firstName = nameParts[0] || 'Cliente';
            const lastName = nameParts.slice(1).join(' ') || 'CineUltimate';

            const reqHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
            const reqProto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
            const isPublicHost = reqHost && !reqHost.includes('localhost') && !reqHost.startsWith('127.0.0.1');
            const notificationUrl = isPublicHost ? `${reqProto}://${reqHost}/api/pix/webhook` : '';

            const mpPayload = {
                transaction_amount: PLAN_AMOUNT,
                description: `${PLAN_NAME} - Acesso para ${email}`,
                payment_method_id: 'pix',
                ...(notificationUrl ? { notification_url: notificationUrl } : {}),
                ...(sessionId ? { external_reference: sessionId } : {}),
                payer: {
                    email,
                    first_name: firstName,
                    last_name: lastName,
                    phone: {
                        area_code: phoneDigits.slice(0, 2) || '11',
                        number: phoneDigits.slice(2) || '999999999'
                    }
                },
                metadata: {
                    plan_id: PLAN_ID,
                    plan_name: PLAN_NAME,
                    app_name: 'Cine Ultimate',
                    client_email: email,
                    client_name: name,
                    client_phone: phone,
                    ...(sessionId ? { checkout_session_id: sessionId } : {})
                }
            };

            const mpRes = await callMercadoPago('POST', '/v1/payments', mpPayload);
            const poi = mpRes.point_of_interaction?.transaction_data || {};
            const qrCode = poi.qr_code || '';
            const qrCodeBase64 = poi.qr_code_base64 || '';
            const ticketUrl = poi.ticket_url || mpRes.transaction_details?.external_resource_url || '';
            const mpPaymentId = String(mpRes.id);
            const now = new Date().toISOString();
            const sessionTag = sessionId ? `#session=${encodeURIComponent(sessionId)}` : '';
            const storedTicketUrl = ticketUrl
                ? `${ticketUrl.split('#')[0]}${sessionTag}`
                : (sessionId ? `https://cine-ultimate.local/${sessionTag}` : '');

            rememberCheckoutSession(sessionId, mpPaymentId, email);

            // Salva no Supabase em paralelo (pix_payments + consulta de entitlement existente)
            const [, existingEntRes] = await Promise.all([
                supaRest('pix_payments?on_conflict=mp_payment_id', 'POST', {
                    mp_payment_id: mpPaymentId,
                    email,
                    payer_name: name,
                    payer_phone: phone,
                    plan_id: PLAN_ID,
                    amount: PLAN_AMOUNT,
                    status: mpRes.status || 'pending',
                    qr_code: qrCode,
                    qr_code_base64: qrCodeBase64,
                    ticket_url: storedTicketUrl,
                    expires_at: mpRes.date_of_expiration || null,
                    created_at: now,
                    updated_at: now
                }, { 'Prefer': 'resolution=merge-duplicates' }),
                supaRest(`user_entitlements?select=status,user_id,plan_id,last_mp_payment_id&email=eq.${encodeURIComponent(email)}&limit=1`)
            ]);

            // Não rebaixa uma assinatura já ativa nem apaga o vínculo de teste grátis enquanto o PIX ainda estiver pendente
            const existingEnt = Array.isArray(existingEntRes.data) && existingEntRes.data[0];
            if (existingEnt?.status !== 'active') {
                const isExistingTrial = existingEnt?.plan_id === TRIAL_PLAN_ID && mpRes.status !== 'approved';
                const preserveDeviceMarker = String(existingEnt?.last_mp_payment_id || '').startsWith(TRIAL_DEVICE_PREFIX);
                await supaRest('user_entitlements?on_conflict=email', 'POST', {
                    email,
                    payer_name: name,
                    payer_phone: phone,
                    plan_id: isExistingTrial ? TRIAL_PLAN_ID : PLAN_ID,
                    amount: isExistingTrial ? 0 : PLAN_AMOUNT,
                    status: mpRes.status === 'approved' ? 'active' : 'pending',
                    ...(preserveDeviceMarker ? {} : { last_mp_payment_id: mpPaymentId }),
                    updated_at: now
                }, { 'Prefer': 'resolution=merge-duplicates' });
            }

            return sendJson(res, 200, {
                ok: true,
                payment: {
                    paymentId: mpPaymentId,
                    mpPaymentId,
                    email,
                    name,
                    phone,
                    amount: PLAN_AMOUNT,
                    status: mpRes.status || 'pending',
                    qrCode,
                    qrCodeBase64,
                    ticketUrl,
                    expiresAt: mpRes.date_of_expiration
                }
            });
        }

        // 3. CONSULTAR STATUS DO PIX EM TEMPO REAL (GET /api/pix/status)
        if (pathname === '/api/pix/status' && req.method === 'GET') {
            const paymentId = String(parsedUrl.searchParams.get('paymentId') || '').trim();
            const email = normalizeEmail(parsedUrl.searchParams.get('email'));

            if (!paymentId || !email) {
                return sendJson(res, 400, { ok: false, error: 'paymentId e email são obrigatórios.' });
            }

            const cachedPid = getCachedApprovedPayment(paymentId);
            if (cachedPid && (!cachedPid.email || cachedPid.email === email)) {
                const cachedEnt = getCachedApprovedEmail(email);
                return sendJson(res, 200, {
                    ok: true,
                    paymentId,
                    email,
                    status: 'approved',
                    approved: true,
                    hasAccount: Boolean(cachedEnt?.hasAccount)
                });
            }

            // Consulta Supabase (pix_payments + user_entitlements) e Mercado Pago EM PARALELO (1 único RTT)
            const [dbRes, entLookupRes, mpRes] = await Promise.all([
                supaRest(`pix_payments?select=mp_payment_id,email,amount,status,created_at&mp_payment_id=eq.${encodeURIComponent(paymentId)}&limit=1`).catch(() => ({ data: [] })),
                supaRest(`user_entitlements?select=status,user_id&email=eq.${encodeURIComponent(email)}&limit=1`).catch(() => ({ data: [] })),
                callMercadoPago('GET', `/v1/payments/${encodeURIComponent(paymentId)}`).catch(() => null)
            ]);
            const localPayment = Array.isArray(dbRes?.data) && dbRes.data[0];
            const entRow = Array.isArray(entLookupRes?.data) && entLookupRes.data[0];
            const hasAccount = Boolean(entRow?.user_id);

            if (localPayment?.email && normalizeEmail(localPayment.email) !== email) {
                return sendJson(res, 403, { ok: false, error: 'Este pagamento PIX pertence a outro Gmail.' });
            }

            const localApproved = Boolean(
                localPayment &&
                normalizeEmail(localPayment.email) === email &&
                localPayment.status === 'approved' &&
                isPaymentAmountValid(localPayment.amount, localPayment.created_at)
            );

            const mpEmail = normalizeEmail(mpRes?.metadata?.client_email || mpRes?.payer?.email);
            const emailMatches = (localPayment?.email && normalizeEmail(localPayment.email) === email)
                || (mpEmail && mpEmail === email);

            if (mpRes && !emailMatches && (mpEmail || localPayment?.email)) {
                return sendJson(res, 403, { ok: false, error: 'Este pagamento PIX pertence a outro Gmail.' });
            }

            const mpApproved = Boolean(
                mpRes &&
                emailMatches &&
                mpRes.status === 'approved' &&
                isPaymentAmountValid(mpRes.transaction_amount, mpRes.date_created)
            );

            const isApproved = localApproved || mpApproved;
            if (isApproved) {
                if (mpApproved && !localApproved) {
                    await activateApprovedPayment(paymentId, email, hasAccount);
                } else if (entRow?.status !== 'active') {
                    await activateApprovedPayment(paymentId, email, hasAccount);
                } else {
                    markSessionApprovedInMemory(paymentId, email, hasAccount);
                }
            }

            return sendJson(res, 200, {
                ok: true,
                paymentId,
                email,
                status: isApproved ? 'approved' : 'pending',
                approved: isApproved,
                hasAccount
            });
        }

        // 3.5 CONSULTAR STATUS POR SESSÃO DO APP (GET /api/pix/session-status?sessionId=...)
        if (pathname === '/api/pix/session-status' && req.method === 'GET') {
            const sessionId = String(parsedUrl.searchParams.get('sessionId') || '').trim();
            if (!sessionId || sessionId.length < 8) {
                return sendJson(res, 400, { ok: false, error: 'sessionId inválido.' });
            }

            try {
                // 1) Fast path: se esta sessão já foi aprovada em memória nesta instância, responde em <5ms
                const cachedSession = recentSessions.get(sessionId);
                if (cachedSession?.approved && cachedSession?.email) {
                    const cachedEnt = getCachedApprovedEmail(cachedSession.email);
                    return sendJson(res, 200, {
                        ok: true,
                        approved: true,
                        email: cachedSession.email,
                        paymentId: cachedSession.mpPaymentId || '',
                        hasAccount: Boolean(cachedEnt?.hasAccount ?? cachedSession.hasAccount)
                    });
                }

                let targetPaymentId = cachedSession?.mpPaymentId || '';
                let targetEmail = normalizeEmail(cachedSession?.email || '');

                // 2) Se já conhecemos paymentId em memória, consulta MP + user_entitlements em PARALELO
                if (targetPaymentId) {
                    const [directMp, entRes] = await Promise.all([
                        callMercadoPago('GET', `/v1/payments/${encodeURIComponent(targetPaymentId)}`).catch(() => null),
                        targetEmail
                            ? supaRest(`user_entitlements?select=status,user_id&email=eq.${encodeURIComponent(targetEmail)}&limit=1`).catch(() => null)
                            : Promise.resolve(null)
                    ]);
                    if (directMp && directMp.status === 'approved' && isPaymentAmountValid(directMp.transaction_amount, directMp.date_created)) {
                        const email = normalizeEmail(targetEmail || directMp.metadata?.client_email || directMp.payer?.email);
                        let ent = Array.isArray(entRes?.data) && entRes.data[0];
                        if (!ent && email && email !== targetEmail) {
                            const entAlt = await supaRest(`user_entitlements?select=status,user_id&email=eq.${encodeURIComponent(email)}&limit=1`).catch(() => null);
                            ent = Array.isArray(entAlt?.data) && entAlt.data[0];
                        }
                        const hasAccount = Boolean(ent?.user_id);
                        await activateApprovedPayment(targetPaymentId, email, hasAccount);
                        return sendJson(res, 200, {
                            ok: true,
                            approved: true,
                            email,
                            paymentId: targetPaymentId,
                            hasAccount
                        });
                    }
                    return sendJson(res, 200, {
                        ok: true,
                        approved: false,
                        email: '',
                        hasAccount: false
                    });
                }

                // 3) Cold lambda: busca paymentId no Supabase (ticket_url #session=...)
                const sessFilter = encodeURIComponent(`*#session=${encodeURIComponent(sessionId)}*`);
                const sessDbRes = await supaRest(`pix_payments?select=mp_payment_id,email,amount,status,created_at&ticket_url=ilike.${sessFilter}&order=created_at.desc&limit=1`).catch(() => null);
                const localSessionPayment = Array.isArray(sessDbRes?.data) && sessDbRes.data[0];

                if (localSessionPayment?.mp_payment_id) {
                    targetPaymentId = String(localSessionPayment.mp_payment_id);
                    targetEmail = normalizeEmail(localSessionPayment.email);
                    rememberCheckoutSession(sessionId, targetPaymentId, targetEmail);

                    // Se webhook já aprovou no Supabase, ativa/retorna em paralelo sem esperar MP
                    if (
                        localSessionPayment.status === 'approved' &&
                        isPaymentAmountValid(localSessionPayment.amount, localSessionPayment.created_at)
                    ) {
                        const entRes = targetEmail
                            ? await supaRest(`user_entitlements?select=status,user_id&email=eq.${encodeURIComponent(targetEmail)}&limit=1`).catch(() => null)
                            : null;
                        const ent = Array.isArray(entRes?.data) && entRes.data[0];
                        const hasAccount = Boolean(ent?.user_id);
                        if (targetEmail && ent?.status !== 'active') {
                            await activateApprovedPayment(targetPaymentId, targetEmail, hasAccount);
                        } else {
                            markSessionApprovedInMemory(targetPaymentId, targetEmail, hasAccount);
                        }
                        return sendJson(res, 200, {
                            ok: true,
                            approved: true,
                            email: targetEmail,
                            paymentId: targetPaymentId,
                            hasAccount
                        });
                    }

                    // Ainda pending no banco -> consulta MP + user_entitlements em paralelo
                    const [directMp, entRes] = await Promise.all([
                        callMercadoPago('GET', `/v1/payments/${encodeURIComponent(targetPaymentId)}`).catch(() => null),
                        targetEmail
                            ? supaRest(`user_entitlements?select=status,user_id&email=eq.${encodeURIComponent(targetEmail)}&limit=1`).catch(() => null)
                            : Promise.resolve(null)
                    ]);
                    if (directMp && directMp.status === 'approved' && isPaymentAmountValid(directMp.transaction_amount, directMp.date_created)) {
                        const email = normalizeEmail(targetEmail || directMp.metadata?.client_email || directMp.payer?.email);
                        const ent = Array.isArray(entRes?.data) && entRes.data[0];
                        const hasAccount = Boolean(ent?.user_id);
                        await activateApprovedPayment(targetPaymentId, email, hasAccount);
                        return sendJson(res, 200, {
                            ok: true,
                            approved: true,
                            email,
                            paymentId: targetPaymentId,
                            hasAccount
                        });
                    }
                    return sendJson(res, 200, {
                        ok: true,
                        approved: false,
                        email: '',
                        hasAccount: false
                    });
                }

                // 4) Fallback final caso a sessão ainda não tenha linha visível no Supabase
                const searchRes = await callMercadoPago(
                    'GET',
                    `/v1/payments/search?external_reference=${encodeURIComponent(sessionId)}&sort=date_created&criteria=desc&limit=5`
                );
                const results = Array.isArray(searchRes?.results) ? searchRes.results : [];
                const approvedPayment = results.find(
                    p => p && p.status === 'approved' && isPaymentAmountValid(p.transaction_amount, p.date_created)
                );

                if (approvedPayment) {
                    const email = normalizeEmail(approvedPayment.metadata?.client_email || approvedPayment.payer?.email);
                    const mpPaymentId = String(approvedPayment.id);
                    rememberCheckoutSession(sessionId, mpPaymentId, email, { approved: true });
                    const entRes = email
                        ? await supaRest(`user_entitlements?select=status,user_id&email=eq.${encodeURIComponent(email)}&limit=1`).catch(() => null)
                        : null;
                    const ent = Array.isArray(entRes?.data) && entRes.data[0];
                    const hasAccount = Boolean(ent?.user_id);
                    await activateApprovedPayment(mpPaymentId, email, hasAccount);
                    return sendJson(res, 200, {
                        ok: true,
                        approved: true,
                        email,
                        paymentId: mpPaymentId,
                        hasAccount
                    });
                }
            } catch (e) { }

            return sendJson(res, 200, {
                ok: true,
                approved: false,
                email: '',
                hasAccount: false
            });
        }

        // 4. WEBHOOK MERCADO PAGO (POST/GET /api/pix/webhook)
        if (pathname === '/api/pix/webhook') {
            if (req.method === 'GET') {
                const qId = parsedUrl.searchParams.get('data.id') || parsedUrl.searchParams.get('id');
                if (qId) {
                    try {
                        const mpRes = await callMercadoPago('GET', `/v1/payments/${encodeURIComponent(qId)}`);
                        if (mpRes && mpRes.status === 'approved' && isPaymentAmountValid(mpRes.transaction_amount, mpRes.date_created)) {
                            const email = normalizeEmail(mpRes.metadata?.client_email || mpRes.payer?.email);
                            await activateApprovedPayment(String(qId), email);
                        }
                    } catch (e) { }
                }
                return sendJson(res, 200, { ok: true, received: true });
            }
            if (req.method === 'POST') {
                const body = await getRequestBody(req);
                let mpId = (body?.data?.id) || body?.id || parsedUrl.searchParams.get('data.id') || parsedUrl.searchParams.get('id');
                if (!mpId && typeof body?.resource === 'string') {
                    const match = body.resource.match(/\/payments\/(\d+)/);
                    if (match) mpId = match[1];
                }

                if (mpId) {
                    try {
                        const mpRes = await callMercadoPago('GET', `/v1/payments/${encodeURIComponent(mpId)}`);
                        if (mpRes && mpRes.status === 'approved' && isPaymentAmountValid(mpRes.transaction_amount, mpRes.date_created)) {
                            const email = normalizeEmail(mpRes.metadata?.client_email || mpRes.payer?.email);
                            await activateApprovedPayment(String(mpId), email);
                        }
                    } catch (e) { }
                }
                return sendJson(res, 200, { ok: true, received: true });
            }
        }

        // 5. SIMULAR APROVAÇÃO (TESTES DO DONO DO APP - PROTEGIDO COM CHAVE DE ADMIN) (POST /api/pix/simulate-approve)
        if (pathname === '/api/pix/simulate-approve' && req.method === 'POST') {
            const body = await getRequestBody(req);
            const ADMIN_SECRET = String(process.env.ADMIN_SECRET || '').trim();
            const providedSecret = String(req.headers['x-admin-secret'] || body.adminSecret || parsedUrl.searchParams.get('adminSecret') || '').trim();
            if (!ADMIN_SECRET || !providedSecret || providedSecret !== ADMIN_SECRET) {
                return sendJson(res, 403, { ok: false, error: 'Acesso não autorizado para simulação de pagamento.' });
            }

            const paymentId = String(body.paymentId || '').trim();
            const email = normalizeEmail(body.email);

            if (!email) {
                return sendJson(res, 400, { ok: false, error: 'Email é obrigatório.' });
            }

            const now = new Date().toISOString();
            if (paymentId) {
                await supaRest(`pix_payments?mp_payment_id=eq.${encodeURIComponent(paymentId)}`, 'PATCH', {
                    status: 'approved',
                    approved_at: now,
                    updated_at: now
                });
            }
            await supaRest('user_entitlements', 'POST', {
                email,
                plan_id: PLAN_ID,
                amount: PLAN_AMOUNT,
                status: 'active',
                activated_at: now,
                updated_at: now
            }, { 'Prefer': 'resolution=merge-duplicates' });

            return sendJson(res, 200, {
                ok: true,
                paymentId,
                email,
                status: 'approved',
                approved: true
            });
        }

        // 5.5 VERIFICAR STATUS DO GMAIL E DISPOSITIVO NO SUPABASE + MERCADO PAGO (POST /api/auth/check-email)
        if (pathname === '/api/auth/check-email' && req.method === 'POST') {
            const body = await getRequestBody(req);
            const email = normalizeEmail(body.email);
            const paymentId = String(body.paymentId || '').trim() || null;
            const deviceHash = hashDeviceFingerprint(body.deviceId);

            // Se apenas o deviceId foi enviado (consulta de vínculo de aparelho ao abrir o app)
            if (!email && deviceHash) {
                const deviceEnt = await findDeviceTrialEntitlement(deviceHash);
                if (!deviceEnt?.email) {
                    return sendJson(res, 200, {
                        ok: true,
                        email: '',
                        entitlementActive: false,
                        isPaid: false,
                        isTrial: false,
                        isTrialExpired: false,
                        trialExpiresAt: null,
                        trialExpiresAtMs: null,
                        trialDaysRemaining: 0,
                        hasAccount: false,
                        boundTrialEmail: null
                    });
                }
                const boundEmail = normalizeEmail(deviceEnt.email);
                const statusInfo = await verifyPaymentEntitlement(boundEmail, paymentId);
                return sendJson(res, 200, {
                    ok: true,
                    email: boundEmail,
                    entitlementActive: statusInfo.isActive,
                    isPaid: Boolean(statusInfo.isPaid),
                    isTrial: Boolean(statusInfo.isTrial),
                    isTrialExpired: Boolean(statusInfo.isTrialExpired),
                    trialExpiresAt: statusInfo.trialExpiresAt || null,
                    trialExpiresAtMs: statusInfo.trialExpiresAtMs || null,
                    trialDaysRemaining: statusInfo.trialDaysRemaining || 0,
                    hasAccount: statusInfo.hasAccount,
                    boundTrialEmail: boundEmail
                });
            }

            if (!email) {
                return sendJson(res, 400, { ok: false, error: 'Email é obrigatório.' });
            }

            const [statusInfo, deviceEnt] = await Promise.all([
                verifyPaymentEntitlement(email, paymentId),
                deviceHash ? findDeviceTrialEntitlement(deviceHash) : Promise.resolve(null)
            ]);
            const boundTrialEmail = deviceEnt?.email ? normalizeEmail(deviceEnt.email) : null;

            return sendJson(res, 200, {
                ok: true,
                email,
                entitlementActive: statusInfo.isActive,
                isPaid: Boolean(statusInfo.isPaid),
                isTrial: Boolean(statusInfo.isTrial),
                isTrialExpired: Boolean(statusInfo.isTrialExpired),
                trialExpiresAt: statusInfo.trialExpiresAt || null,
                trialExpiresAtMs: statusInfo.trialExpiresAtMs || null,
                trialDaysRemaining: statusInfo.trialDaysRemaining || 0,
                hasAccount: statusInfo.hasAccount,
                boundTrialEmail
            });
        }

        // 6. CADASTRO / CRIAR CONTA (POST /api/auth/register)
        // Regra obrigatória: Cadastra se o Gmail tiver pagamento PIX aprovado OU se for ativação de Teste Grátis (1 por dispositivo)!
        if (pathname === '/api/auth/register' && req.method === 'POST') {
            const body = await getRequestBody(req);
            const email = normalizeEmail(body.email);
            const password = String(body.password || '');
            const name = String(body.name || '').trim() || email.split('@')[0];
            const isTrialRequest = Boolean(body.isTrial);
            const deviceHash = hashDeviceFingerprint(body.deviceId);

            if (!email || !password || password.length < 6) {
                return sendJson(res, 400, { ok: false, error: 'Informe um Gmail válido e senha de pelo menos 6 caracteres.' });
            }

            if (isTrialRequest && !email.endsWith('@gmail.com')) {
                return sendJson(res, 400, {
                    ok: false,
                    code: 'GMAIL_REQUIRED',
                    error: 'Para ativar o Teste Grátis de 20 dias, informe obrigatoriamente uma conta @gmail.com.'
                });
            }

            if (isTrialRequest && !deviceHash) {
                return sendJson(res, 400, {
                    ok: false,
                    code: 'DEVICE_ID_REQUIRED',
                    error: 'Não foi possível validar a segurança do aparelho para o teste grátis. Reinicie o aplicativo.'
                });
            }

            // Consulta status do e-mail e (se for teste grátis ou houver deviceId) o vínculo do aparelho em paralelo
            const [entStatus, deviceEnt] = await Promise.all([
                verifyPaymentEntitlement(email),
                deviceHash ? findDeviceTrialEntitlement(deviceHash) : Promise.resolve(null)
            ]);

            const boundDeviceEmail = deviceEnt?.email ? normalizeEmail(deviceEnt.email) : null;

            // Proteção Anti-Burla e Anti-Inflação do Banco:
            // Se este dispositivo físico já ativou um teste grátis com OUTRO Gmail, bloqueia antes de criar usuário ou linha no banco!
            if (boundDeviceEmail && boundDeviceEmail !== email && !entStatus.isPaid) {
                const boundTrialState = evaluateTrialEntitlement(deviceEnt);
                return sendJson(res, 403, {
                    ok: false,
                    code: 'DEVICE_TRIAL_ALREADY_USED',
                    boundTrialEmail: boundDeviceEmail,
                    isTrialExpired: Boolean(boundTrialState.isTrialExpired && deviceEnt?.status !== 'active'),
                    error: boundTrialState.isTrialExpired && deviceEnt?.status !== 'active'
                        ? `Este aparelho já utilizou os 20 dias de teste grátis com o Gmail ${boundDeviceEmail}. Para continuar assistindo, realize o pagamento único de ${formatBrl(PLAN_AMOUNT)} usando obrigatoriamente o Gmail ${boundDeviceEmail}.`
                        : `Este aparelho já possui um teste grátis vinculado ao Gmail ${boundDeviceEmail}. Não é permitido criar múltiplas contas no mesmo dispositivo — faça login com ${boundDeviceEmail}.`
                });
            }

            // Se o próprio Gmail informado já teve teste grátis e os 20 dias expiraram sem pagamento:
            if (entStatus.isTrialExpired) {
                return sendJson(res, 402, {
                    ok: false,
                    code: 'TRIAL_EXPIRED',
                    boundTrialEmail: email,
                    isTrialExpired: true,
                    error: `Seu teste grátis de 20 dias para ${email} já expirou! Para liberar o acesso definitivo, realize o pagamento único de ${formatBrl(PLAN_AMOUNT)} no site oficial usando este mesmo Gmail (${email}).`
                });
            }

            // Se não for solicitação de teste grátis e ainda não tiver pagamento/teste ativo:
            if (!isTrialRequest && !entStatus.isActive) {
                return sendJson(res, 403, {
                    ok: false,
                    code: 'PAYMENT_REQUIRED',
                    ...(boundDeviceEmail ? { boundTrialEmail: boundDeviceEmail } : {}),
                    error: `Acesso negado: O Gmail ${email} ainda não possui pagamento PIX de ${formatBrl(PLAN_AMOUNT)} aprovado. Por favor, conclua o pagamento primeiro.`
                });
            }

            // Se for solicitação de teste grátis nova (ainda sem pagamento e sem teste anterior):
            const startingNewTrial = isTrialRequest && !entStatus.isActive && !entStatus.isTrialExpired;
            const nowIso = new Date().toISOString();
            const newTrialExpiresMs = Date.now() + TRIAL_DURATION_MS;
            const newTrialExpiresIso = new Date(newTrialExpiresMs).toISOString();

            const userMetadata = startingNewTrial
                ? {
                    name,
                    is_trial: true,
                    trial_started_at: nowIso,
                    trial_expires_at: newTrialExpiresIso,
                    device_hash: deviceHash
                }
                : { name };

            // Cria o usuário no Supabase Auth via Admin API
            const authAdminRes = await httpRequest(`${SUPABASE_URL}/auth/v1/admin/users`, {
                method: 'POST',
                headers: {
                    'apikey': SUPABASE_SERVICE_ROLE_KEY,
                    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                    'Content-Type': 'application/json'
                }
            }, {
                email,
                password,
                email_confirm: true,
                user_metadata: userMetadata
            });

            let userId = authAdminRes.data?.id;

            // Se o usuário já existia no auth, valida a senha informada (sem duplicar registros)
            if (authAdminRes.status === 422 || !userId) {
                const loginRes = await httpRequest(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
                    method: 'POST',
                    headers: {
                        'apikey': SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY,
                        'Content-Type': 'application/json'
                    }
                }, { email, password });

                if (loginRes.data?.access_token) {
                    const existingUserId = loginRes.data.user?.id;
                    if (startingNewTrial) {
                        await supaRest('user_entitlements?on_conflict=email', 'POST', {
                            email,
                            user_id: existingUserId || null,
                            payer_name: name,
                            plan_id: TRIAL_PLAN_ID,
                            amount: 0,
                            status: 'pending',
                            last_mp_payment_id: `${TRIAL_DEVICE_PREFIX}${deviceHash}`,
                            activated_at: nowIso,
                            updated_at: nowIso
                        }, { 'Prefer': 'resolution=merge-duplicates' });
                    } else {
                        markSessionApprovedInMemory(null, email, true);
                        if (existingUserId) {
                            try {
                                await supaRest(`user_entitlements?email=eq.${encodeURIComponent(email)}`, 'PATCH', {
                                    user_id: existingUserId,
                                    updated_at: nowIso
                                });
                            } catch (e) { }
                        }
                    }
                    const effectiveIsTrial = startingNewTrial || Boolean(entStatus.isTrial && !entStatus.isPaid);
                    const effectiveExpiresIso = startingNewTrial ? newTrialExpiresIso : (entStatus.trialExpiresAt || null);
                    const effectiveExpiresMs = startingNewTrial ? newTrialExpiresMs : (entStatus.trialExpiresAtMs || null);
                    const effectiveDaysRemaining = startingNewTrial ? TRIAL_DURATION_DAYS : (entStatus.trialDaysRemaining || 0);
                    return sendJson(res, 200, {
                        ok: true,
                        token: loginRes.data.access_token,
                        refreshToken: loginRes.data.refresh_token || null,
                        expiresIn: loginRes.data.expires_in || 3600,
                        user: {
                            id: existingUserId,
                            email,
                            name,
                            subscriptionActive: true,
                            planId: effectiveIsTrial ? TRIAL_PLAN_ID : PLAN_ID,
                            isTrial: effectiveIsTrial,
                            trialExpiresAt: effectiveExpiresIso,
                            trialExpiresAtMs: effectiveExpiresMs,
                            trialDaysRemaining: effectiveDaysRemaining
                        }
                    });
                }

                return sendJson(res, 409, {
                    ok: false,
                    code: 'ACCOUNT_ALREADY_EXISTS',
                    boundTrialEmail: boundDeviceEmail || (entStatus.isTrial ? email : null),
                    error: 'Este Gmail já possui uma conta criada. Use a opção "Fazer Login" e informe sua senha correta.'
                });
            }

            // Se está iniciando o teste grátis de 20 dias, grava o vínculo único de dispositivo + Gmail em user_entitlements
            if (startingNewTrial) {
                await supaRest('user_entitlements?on_conflict=email', 'POST', {
                    email,
                    user_id: userId,
                    payer_name: name,
                    plan_id: TRIAL_PLAN_ID,
                    amount: 0,
                    status: 'pending',
                    last_mp_payment_id: `${TRIAL_DEVICE_PREFIX}${deviceHash}`,
                    activated_at: nowIso,
                    updated_at: nowIso
                }, { 'Prefer': 'resolution=merge-duplicates' });
            }

            // Faz login para gerar token JWT da sessão
            const sessionRes = await httpRequest(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
                method: 'POST',
                headers: {
                    'apikey': SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY,
                    'Content-Type': 'application/json'
                }
            }, { email, password });

            if (!sessionRes.data?.access_token) {
                return sendJson(res, 500, {
                    ok: false,
                    error: 'Não foi possível iniciar sessão automática. Tente fazer login com seu Gmail e senha.'
                });
            }

            const finalUserId = userId || sessionRes.data.user?.id;
            if (!startingNewTrial) {
                markSessionApprovedInMemory(null, email, true);
                if (finalUserId) {
                    try {
                        await supaRest(`user_entitlements?email=eq.${encodeURIComponent(email)}`, 'PATCH', {
                            user_id: finalUserId,
                            updated_at: nowIso
                        });
                    } catch (e) { }
                }
            }

            const effectiveIsTrial = startingNewTrial || Boolean(entStatus.isTrial && !entStatus.isPaid);
            const effectiveExpiresIso = startingNewTrial ? newTrialExpiresIso : (entStatus.trialExpiresAt || null);
            const effectiveExpiresMs = startingNewTrial ? newTrialExpiresMs : (entStatus.trialExpiresAtMs || null);
            const effectiveDaysRemaining = startingNewTrial ? TRIAL_DURATION_DAYS : (entStatus.trialDaysRemaining || 0);

            return sendJson(res, 200, {
                ok: true,
                token: sessionRes.data.access_token,
                refreshToken: sessionRes.data.refresh_token || null,
                expiresIn: sessionRes.data.expires_in || 3600,
                user: {
                    id: finalUserId,
                    email,
                    name,
                    subscriptionActive: true,
                    planId: effectiveIsTrial ? TRIAL_PLAN_ID : PLAN_ID,
                    isTrial: effectiveIsTrial,
                    trialExpiresAt: effectiveExpiresIso,
                    trialExpiresAtMs: effectiveExpiresMs,
                    trialDaysRemaining: effectiveDaysRemaining
                }
            });
        }

        // 7. LOGIN (POST /api/auth/login)
        if (pathname === '/api/auth/login' && req.method === 'POST') {
            const body = await getRequestBody(req);
            const email = normalizeEmail(body.email);
            const password = String(body.password || '');
            const deviceHash = hashDeviceFingerprint(body.deviceId);

            if (!email || !password) {
                return sendJson(res, 400, { ok: false, error: 'Email e senha são obrigatórios.' });
            }

            const [entStatus, deviceEnt] = await Promise.all([
                verifyPaymentEntitlement(email),
                deviceHash ? findDeviceTrialEntitlement(deviceHash) : Promise.resolve(null)
            ]);
            const { isActive, isPaid, isTrial, isTrialExpired, trialExpiresAt, trialExpiresAtMs, trialDaysRemaining, ent } = entStatus;
            const boundDeviceEmail = deviceEnt?.email ? normalizeEmail(deviceEnt.email) : null;

            // Impede que um aparelho que já usou teste grátis em outro Gmail faça login com uma segunda conta de teste grátis
            if (isTrial && !isPaid && boundDeviceEmail && boundDeviceEmail !== email) {
                return sendJson(res, 403, {
                    ok: false,
                    code: 'DEVICE_TRIAL_ALREADY_USED',
                    boundTrialEmail: boundDeviceEmail,
                    error: `Este aparelho já está vinculado ao teste grátis do Gmail ${boundDeviceEmail}. Não é permitido usar múltiplas contas de teste no mesmo dispositivo.`
                });
            }

            if (!isActive) {
                if (isTrialExpired) {
                    return sendJson(res, 402, {
                        ok: false,
                        code: 'TRIAL_EXPIRED',
                        boundTrialEmail: email,
                        isTrialExpired: true,
                        error: `Seu teste grátis de 20 dias terminou! Para voltar a assistir e consumir conteúdos, realize o pagamento único de ${formatBrl(PLAN_AMOUNT)} no site oficial usando obrigatoriamente o mesmo Gmail do seu teste (${email}).`
                    });
                }
                return sendJson(res, 403, {
                    ok: false,
                    code: 'PAYMENT_EXPIRED_OR_MISSING',
                    ...(boundDeviceEmail ? { boundTrialEmail: boundDeviceEmail } : {}),
                    error: `Acesso negado: O Gmail ${email} não possui pagamento PIX de ${formatBrl(PLAN_AMOUNT)} aprovado. Realize o pagamento no site oficial.`
                });
            }

            // Valida credenciais com Supabase Auth
            const authRes = await httpRequest(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
                method: 'POST',
                headers: {
                    'apikey': SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY,
                    'Content-Type': 'application/json'
                }
            }, { email, password });

            if (authRes.status !== 200 || !authRes.data?.access_token) {
                return sendJson(res, 401, {
                    ok: false,
                    error: 'Gmail ou senha incorretos. Caso ainda não tenha criado sua senha após o PIX, use Criar Conta.'
                });
            }

            const loggedUserId = authRes.data.user?.id;
            if (isPaid) {
                markSessionApprovedInMemory(null, email, true);
            }
            if (loggedUserId && !ent?.user_id) {
                try {
                    await supaRest(`user_entitlements?email=eq.${encodeURIComponent(email)}`, 'PATCH', {
                        user_id: loggedUserId,
                        updated_at: new Date().toISOString()
                    });
                } catch (e) { }
            }

            return sendJson(res, 200, {
                ok: true,
                token: authRes.data.access_token,
                refreshToken: authRes.data.refresh_token || null,
                expiresIn: authRes.data.expires_in || 3600,
                user: {
                    id: loggedUserId,
                    email,
                    name: authRes.data.user.user_metadata?.name || email.split('@')[0],
                    subscriptionActive: true,
                    planId: ent?.plan_id || PLAN_ID,
                    isTrial: Boolean(isTrial && !isPaid),
                    trialExpiresAt: trialExpiresAt || null,
                    trialExpiresAtMs: trialExpiresAtMs || null,
                    trialDaysRemaining: trialDaysRemaining || 0
                }
            });
        }

        // 7.5 RENOVAR SESSÃO (POST /api/auth/refresh)
        if (pathname === '/api/auth/refresh' && req.method === 'POST') {
            const body = await getRequestBody(req);
            const refreshToken = String(body.refreshToken || body.refresh_token || '').trim();
            if (!refreshToken) {
                return sendJson(res, 400, { ok: false, error: 'refreshToken obrigatório.' });
            }

            const refreshRes = await httpRequest(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
                method: 'POST',
                headers: {
                    'apikey': SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY,
                    'Content-Type': 'application/json'
                }
            }, { refresh_token: refreshToken });

            if (refreshRes.status !== 200 || !refreshRes.data?.access_token || !refreshRes.data?.user?.email) {
                return sendJson(res, 401, {
                    ok: false,
                    code: 'SESSION_EXPIRED',
                    error: 'Sessão expirada. Faça login novamente com seu Gmail e senha.'
                });
            }

            const email = normalizeEmail(refreshRes.data.user.email);
            const { isActive, isPaid, isTrial, isTrialExpired, trialExpiresAt, trialExpiresAtMs, trialDaysRemaining, ent } = await verifyPaymentEntitlement(email);
            if (!isActive) {
                if (isTrialExpired) {
                    return sendJson(res, 402, {
                        ok: false,
                        code: 'TRIAL_EXPIRED',
                        boundTrialEmail: email,
                        isTrialExpired: true,
                        error: `Seu teste grátis de 20 dias terminou! Realize o pagamento de ${formatBrl(PLAN_AMOUNT)} no site oficial usando o mesmo Gmail (${email}).`
                    });
                }
                return sendJson(res, 403, {
                    ok: false,
                    code: 'PAYMENT_EXPIRED_OR_MISSING',
                    error: `Acesso negado: O Gmail ${email} não possui pagamento PIX de ${formatBrl(PLAN_AMOUNT)} aprovado.`
                });
            }

            return sendJson(res, 200, {
                ok: true,
                token: refreshRes.data.access_token,
                refreshToken: refreshRes.data.refresh_token || refreshToken,
                expiresIn: refreshRes.data.expires_in || 3600,
                user: {
                    id: refreshRes.data.user.id,
                    email,
                    name: refreshRes.data.user.user_metadata?.name || email.split('@')[0],
                    subscriptionActive: true,
                    planId: ent?.plan_id || PLAN_ID,
                    isTrial: Boolean(isTrial && !isPaid),
                    trialExpiresAt: trialExpiresAt || null,
                    trialExpiresAtMs: trialExpiresAtMs || null,
                    trialDaysRemaining: trialDaysRemaining || 0
                }
            });
        }

        // 8. DADOS DO USUÁRIO LOGADO (GET /api/auth/me)
        if (pathname === '/api/auth/me' && req.method === 'GET') {
            const authHeader = req.headers['authorization'] || '';
            const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

            if (!token) {
                return sendJson(res, 401, { ok: false, error: 'Token ausente.' });
            }

            const meRes = await httpRequest(`${SUPABASE_URL}/auth/v1/user`, {
                headers: {
                    'apikey': SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY,
                    'Authorization': `Bearer ${token}`
                }
            });

            if (meRes.status !== 200 || !meRes.data?.email) {
                return sendJson(res, 401, { ok: false, error: 'Sessão inválida ou expirada.' });
            }

            const email = normalizeEmail(meRes.data.email);
            const { isActive, isPaid, isTrial, isTrialExpired, trialExpiresAt, trialExpiresAtMs, trialDaysRemaining, ent } = await verifyPaymentEntitlement(email);

            return sendJson(res, 200, {
                ok: true,
                user: {
                    id: meRes.data.id,
                    email,
                    name: meRes.data.user_metadata?.name || email.split('@')[0],
                    subscriptionActive: isActive,
                    planId: ent?.plan_id || PLAN_ID,
                    isTrial: Boolean(isTrial && !isPaid),
                    isTrialExpired: Boolean(isTrialExpired),
                    trialExpiresAt: trialExpiresAt || null,
                    trialExpiresAtMs: trialExpiresAtMs || null,
                    trialDaysRemaining: trialDaysRemaining || 0
                }
            });
        }

        // 9. PERFIS MULTIUSUÁRIO DA CONTA HOST (GET / PUT /api/profiles)
        if (pathname === '/api/profiles' && (req.method === 'GET' || req.method === 'PUT' || req.method === 'POST')) {
            const authHeader = req.headers['authorization'] || '';
            const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
            if (!token) {
                return sendJson(res, 401, { ok: false, error: 'Token ausente.' });
            }

            const meRes = await httpRequest(`${SUPABASE_URL}/auth/v1/user`, {
                headers: {
                    'apikey': SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY,
                    'Authorization': `Bearer ${token}`
                }
            });

            if (meRes.status !== 200 || !meRes.data?.id || !meRes.data?.email) {
                return sendJson(res, 401, { ok: false, error: 'Sessão inválida ou expirada.' });
            }

            const email = normalizeEmail(meRes.data.email);
            const { isActive, isTrialExpired } = await verifyPaymentEntitlement(email);
            if (!isActive) {
                return sendJson(res, isTrialExpired ? 402 : 403, {
                    ok: false,
                    code: isTrialExpired ? 'TRIAL_EXPIRED' : 'PAYMENT_REQUIRED',
                    boundTrialEmail: isTrialExpired ? email : null,
                    error: isTrialExpired
                        ? `Seu teste grátis de 20 dias expirou! Realize o pagamento de ${formatBrl(PLAN_AMOUNT)} usando o Gmail ${email}.`
                        : 'Assinatura não ativa para este Gmail.'
                });
            }

            if (req.method === 'GET') {
                const profiles = Array.isArray(meRes.data.user_metadata?.cine_profiles)
                    ? meRes.data.user_metadata.cine_profiles
                    : [];
                return sendJson(res, 200, { ok: true, profiles });
            }

            const body = await getRequestBody(req);
            const rawProfiles = Array.isArray(body.profiles) ? body.profiles.slice(0, 6) : [];
            const sanitized = rawProfiles.map((p, idx) => ({
                profile_index: Number(p.profile_index ?? p.profileIndex ?? (idx + 1)),
                name: String(p.name || '').trim().slice(0, 40) || `Perfil ${idx + 1}`,
                avatar_color_hex: String(p.avatar_color_hex ?? p.avatarColorHex ?? '#1E88E5').trim(),
                avatar_id: p.avatar_id ?? p.avatarId ?? null,
                avatar_url: p.avatar_url ?? p.avatarUrl ?? null,
                profile_background_id: p.profile_background_id ?? p.profileBackgroundId ?? null,
                profile_background_url: p.profile_background_url ?? p.profileBackgroundUrl ?? null,
                uses_primary_addons: Boolean(p.uses_primary_addons ?? p.usesPrimaryAddons ?? false),
                uses_primary_plugins: Boolean(p.uses_primary_plugins ?? p.usesPrimaryPlugins ?? false),
                pin_enabled: Boolean(p.pin_enabled ?? p.pinEnabled ?? false),
                pin_salt: p.pin_salt ?? p.pinSalt ?? null,
                pin_digest: p.pin_digest ?? p.pinDigest ?? null,
            }));

            const updatedMeta = {
                ...(meRes.data.user_metadata || {}),
                cine_profiles: sanitized,
            };
            await httpRequest(`${SUPABASE_URL}/auth/v1/admin/users/${meRes.data.id}`, {
                method: 'PUT',
                headers: {
                    'apikey': SUPABASE_SERVICE_ROLE_KEY,
                    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                    'Content-Type': 'application/json'
                }
            }, { user_metadata: updatedMeta });

            return sendJson(res, 200, { ok: true, profiles: sanitized });
        }

        return sendJson(res, 404, { ok: false, error: `Rota não encontrada: ${req.method} ${pathname}` });
    } catch (err) {
        console.error('API Error:', err);
        return sendJson(res, 500, { ok: false, error: err.message || 'Erro interno no servidor.' });
    }
};
