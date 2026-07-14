// Vercel Serverless Function: /api/verify-code
// アプリ(v5.html)からコード照合のために呼び出される。
// POST { code: "XXXX-XXXX" } を受け取り、有効なら { valid: true } を返す。

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ valid: false, error: 'Method Not Allowed' });
  }

  const { code } = req.body || {};
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ valid: false, error: 'コードが必要です' });
  }

  const normalized = code.trim().toUpperCase();
  const record = await kv.get(`code:${normalized}`);

  if (!record || record.active !== true) {
    return res.status(200).json({ valid: false });
  }

  return res.status(200).json({ valid: true });
}
