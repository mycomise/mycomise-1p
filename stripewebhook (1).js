// Vercel Serverless Function: /api/stripe-webhook
// Stripeの決済完了(checkout.session.completed)を受け取り、
// アクセスコードを発行してVercel KVに保存し、購入者にメールで送信する。
//
// 必要な環境変数（Vercelプロジェクトの Settings > Environment Variables で設定）:
//   STRIPE_SECRET_KEY       … Stripeダッシュボードの秘密鍵 (sk_live_... / sk_test_...)
//   STRIPE_WEBHOOK_SECRET   … StripeのWebhookエンドポイント作成時に発行される署名シークレット (whsec_...)
//   RESEND_API_KEY          … Resendダッシュボードで発行したAPIキー
//   MAIL_FROM               … 送信元メールアドレス（Resendで検証済みのドメインが必要。例: noreply@mycomise.com）
//   REDIS_URL               … Upstash Redis接続文字列（プロジェクトに接続すると自動で追加される）

import Stripe from 'stripe';
import { getRedis } from '../lib/redis.js';

export const config = {
  api: {
    bodyParser: false, // Stripe署名検証には生のボディが必要
  },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function generateCode() {
  // 読み間違えにくい文字だけを使った8桁コード（例: 7F3K-9QRT）
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function sendCodeEmail(toEmail, code) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM,
      to: toEmail,
      subject: '【mycomise】ご購入ありがとうございます（アクセスコードのご案内）',
      html: `
        <p>ご購入ありがとうございます。</p>
        <p>下記のアクセスコードをアプリ起動時に入力してください。</p>
        <p style="font-size:24px;font-weight:bold;letter-spacing:2px;">${code}</p>
        <p>アプリURL: <a href="https://mycomise.com/v5.html">https://mycomise.com/v5.html</a></p>
        <p>このコードは大切に保管してください。</p>
      `,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend送信失敗: ${res.status} ${errText}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  const rawBody = await readRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook署名検証エラー:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;

    if (!email) {
      console.error('メールアドレスが取得できませんでした', session.id);
      return res.status(200).json({ received: true, warning: 'no email' });
    }

    const code = generateCode();
    const subscriptionId = session.subscription || null; // サブスクの場合はサブスク番号が入る

    // Redisに保存: code -> { email, active, createdAt, subscriptionId }（JSON文字列で保存）
    const redis = getRedis();
    await redis.set(`code:${code}`, JSON.stringify({
      email,
      active: true,
      stripeSessionId: session.id,
      subscriptionId,
      createdAt: Date.now(),
    }));

    // 解約時に逆引きできるよう、サブスク番号 -> コード の対応も保存
    if (subscriptionId) {
      await redis.set(`sub:${subscriptionId}`, code);
    }

    try {
      await sendCodeEmail(email, code);
    } catch (mailErr) {
      console.error('メール送信エラー:', mailErr.message);
      // メール失敗してもコード自体はKVに残るので、後から手動で伝えることも可能
    }
  }

  // サブスク解約時にコードを無効化
  if (event.type === 'customer.subscription.deleted') {
    const subscriptionId = event.data.object.id;
    const redis = getRedis();
    const code = await redis.get(`sub:${subscriptionId}`);
    if (code) {
      const raw = await redis.get(`code:${code}`);
      if (raw) {
        const record = JSON.parse(raw);
        record.active = false; // 無効化
        record.canceledAt = Date.now();
        await redis.set(`code:${code}`, JSON.stringify(record));
        console.log('サブスク解約によりコードを無効化:', code);
      }
    } else {
      console.log('解約イベント受信（対応コードなし）:', subscriptionId);
    }
  }

  return res.status(200).json({ received: true });
}
