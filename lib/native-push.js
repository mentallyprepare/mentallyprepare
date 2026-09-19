'use strict';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_TOKEN_RE = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/;

function isExpoPushToken(value) {
  return typeof value === 'string' && EXPO_TOKEN_RE.test(value);
}

function normalizePlatform(value) {
  return value === 'ios' || value === 'android' ? value : null;
}

async function sendExpoPush({
  fetchImpl = globalThis.fetch,
  token,
  title,
  body,
  data,
}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, terminal: false, reason: 'fetch_unavailable' };
  }
  if (!isExpoPushToken(token)) {
    return { ok: false, terminal: true, reason: 'invalid_token' };
  }

  let response;
  try {
    response = await fetchImpl(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: token,
        title: String(title || 'Mentally Prepare').slice(0, 60),
        body: String(body || 'Something is ready.').slice(0, 140),
        data: data && typeof data === 'object' ? data : {},
        sound: null,
        priority: 'default',
        channelId: 'ritual',
      }),
    });
  } catch {
    return { ok: false, terminal: false, reason: 'network_error' };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, terminal: false, reason: 'invalid_response' };
  }

  const ticket = Array.isArray(payload && payload.data)
    ? payload.data[0]
    : payload && payload.data;
  if (response.ok && ticket && ticket.status === 'ok') {
    return { ok: true, terminal: false, ticketId: ticket.id || null };
  }

  const expoError = ticket && ticket.details && ticket.details.error;
  return {
    ok: false,
    terminal: expoError === 'DeviceNotRegistered',
    reason: expoError || 'rejected',
  };
}

module.exports = {
  EXPO_PUSH_URL,
  isExpoPushToken,
  normalizePlatform,
  sendExpoPush,
};

