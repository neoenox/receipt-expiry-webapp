export async function onRequestGet({ env }) {
  return new Response(JSON.stringify({
    supportUrl: env.SUPPORT_URL || 'https://github.com/sponsors/neoenox',
    adsenseClient: env.ADSENSE_CLIENT_ID || '',
    adsenseSlot: env.ADSENSE_SLOT_ID || '',
  }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
