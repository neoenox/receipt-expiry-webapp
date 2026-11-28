import { json } from '../shared/http.js';

export async function onRequestGet({ env }) {
  return json({
    supportUrl: env.SUPPORT_URL || 'https://github.com/sponsors/neoenox',
    adsenseClient: env.ADSENSE_CLIENT_ID || '',
    adsenseSlot: env.ADSENSE_SLOT_ID || '',
  });
}
