import { json } from '../../shared/http.js';

export async function onRequestGet({ env }) {
  return json({ publicKey: env.VAPID_PUBLIC_KEY || '' });
}
