// In-process verification of the livecaption_auth cookie for every
// authenticated route (/live/, /subtitles/, /subtitles_recent/, /register).
// Uses the same HMAC-SHA256 cookie scheme as the signer in
// frontend/serve_https.py and the same auth_keys.json membership check,
// so revoking a key in auth_keys.json takes effect immediately here too.

import crypto from 'crypto';
import fs from 'fs';

var AUTH_COOKIE_NAME = 'livecaption_auth';
var AUTH_KEYS_FILE = '/etc/nginx/auth_keys.json';

function authSecret() {
    // Must match the fallback in serve_https.py when AUTH_SECRET is unset.
    return process.env.AUTH_SECRET || 'livecaption-dev-auth-secret';
}

function cookieValue(r) {
    var raw = r.headersIn['Cookie'] || '';
    var parts = raw.split(';');
    for (var i = 0; i < parts.length; i++) {
        var eq = parts[i].indexOf('=');
        if (eq < 0) {
            continue;
        }
        if (parts[i].slice(0, eq).trim() === AUTH_COOKIE_NAME) {
            return parts[i].slice(eq + 1).trim();
        }
    }
    return null;
}

function srcQueryParam(query) {
    var pairs = query.split('&');
    for (var i = 0; i < pairs.length; i++) {
        var eq = pairs[i].indexOf('=');
        if (eq < 0) {
            continue;
        }
        if (pairs[i].slice(0, eq) === 'src') {
            var value = pairs[i].slice(eq + 1).replace(/\+/g, ' ');
            try {
                return decodeURIComponent(value);
            } catch (e) {
                return null;
            }
        }
    }
    return null;
}

function keyFromUri(r) {
    var uri = r.variables.request_uri || '';
    var qmark = uri.indexOf('?');
    var path = qmark < 0 ? uri : uri.slice(0, qmark);
    var query = qmark < 0 ? '' : uri.slice(qmark + 1);
    if (path.startsWith('/live/') ||
        path.startsWith('/subtitles/') ||
        path.startsWith('/subtitles_recent/')) {
        var parts = path.split('/');
        return parts.length > 2 && parts[2] ? parts[2] : null;
    }
    if (path === '/register') {
        return srcQueryParam(query);
    }
    return null;
}

function keyIsRegistered(key) {
    var data = JSON.parse(fs.readFileSync(AUTH_KEYS_FILE));
    var rawKeys = data && data.keys !== undefined ? data.keys : data;
    if (!rawKeys || typeof rawKeys !== 'object') {
        return false;
    }
    return Object.prototype.hasOwnProperty.call(rawKeys, key);
}

function digestsEqual(a, b) {
    // Hash both sides so plain string comparison cannot leak the signature
    // through timing.
    var ha = crypto.createHash('sha256').update(a).digest('hex');
    var hb = crypto.createHash('sha256').update(b).digest('hex');
    return ha === hb;
}

function check(r) {
    var value = cookieValue(r);
    if (!value) {
        return false;
    }
    var dot = value.lastIndexOf('.');
    if (dot < 0) {
        return false;
    }
    var payload = value.slice(0, dot);
    var signature = value.slice(dot + 1);

    var expected = crypto.createHmac('sha256', authSecret())
        .update(payload)
        .digest('base64url');
    if (!digestsEqual(signature, expected)) {
        return false;
    }

    var data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof data.key !== 'string' || typeof data.exp !== 'number') {
        return false;
    }
    if (data.exp < Math.floor(Date.now() / 1000)) {
        return false;
    }

    var requested = keyFromUri(r);
    if (!requested || requested !== data.key) {
        return false;
    }
    return keyIsRegistered(data.key);
}

function verify(r) {
    var ok = false;
    try {
        ok = check(r);
    } catch (e) {
        ok = false;
    }
    r.return(ok ? 204 : 401);
}

export default { verify };
