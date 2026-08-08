// Vercel Serverless Function: /api/stripe-webhook
// Stripeの決済完了(checkout.session.completed)を受け取り、
// アクセスコードを発行してVercel KVに保存し、購入者にメールで送信する。
// あわせてサブスクの状態変化(customer.subscription.updated / deleted)で
// コードの有効・無効を切り替え、支払い失敗(invoice.payment_failed)を購入者に通知する。
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

// サブスクの状態 → アクセス可否の対応表。
// past_due は「あえて」有効のままにしている。これはStripeがカードに再請求を試みている
// 最中の状態で、多くはカードの期限切れ。1回の失敗で発注業務を止める方が店にとって痛手なので、
// Stripeが諦めて unpaid / canceled に移った時点で失効させる。ここを false にしないこと。
const ACCESS_BY_STATUS = {
  active: true,
  trialing: true,
  past_due: true,
  unpaid: false,
  canceled: false,
  incomplete: false,
  incomplete_expired: false,
  paused: false,
};

// code:{CODE} を読み出してJSONに戻す。無い/壊れている場合は null。
async function readCodeRecord(redis, code) {
  const raw = await redis.get(`code:${code}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (parseErr) {
    console.error('コードレコードのJSON解析に失敗:', code, parseErr.message);
    return null;
  }
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
        <p style="font-size:13px;color:#666;">解約をご希望の場合、およびご不明な点は <a href="mailto:mycomise@gmail.com">mycomise@gmail.com</a> までご連絡ください。</p>
      `,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend送信失敗: ${res.status} ${errText}`);
  }
}

async function sendPaymentFailedEmail(toEmail, invoiceUrl) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM,
      to: toEmail,
      subject: '【mycomise】お支払いを確認できませんでした（カード情報のご確認のお願い）',
      html: `
        <p>いつもmycomiseをご利用いただきありがとうございます。</p>
        <p>今回のご請求について、お支払いを確認できませんでした。カードの有効期限切れや限度額などが原因のことが多いです。</p>
        <p>お手数ですが、下記よりお支払い方法のご確認・更新をお願いいたします。</p>
        ${invoiceUrl ? `<p><a href="${invoiceUrl}">お支払いページを開く</a></p>` : ''}
        <p>しばらくは今までどおりアプリをご利用いただけますが、お支払いが確認できないままですと、アクセスコードが使えなくなりご利用を停止させていただきます。</p>
        <p>お心当たりのない場合や、ご不明な点がございましたら、このメールにご返信ください。</p>
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
      const record = await readCodeRecord(redis, code);
      if (record) {
        record.active = false; // 無効化
        record.canceledAt = Date.now();
        await redis.set(`code:${code}`, JSON.stringify(record));
        console.log('サブスク解約によりコードを無効化:', code);
      }
    } else {
      console.log('解約イベント受信（対応コードなし）:', subscriptionId);
    }
  }

  // サブスクの状態変化に追随してコードの有効・無効を切り替える
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;
    const status = subscription.status;
    const eventAt = (event.created || Math.floor(Date.now() / 1000)) * 1000;

    const redis = getRedis();
    const code = await redis.get(`sub:${subscription.id}`);
    if (!code) {
      // この仕組みより前のサブスクや、ダッシュボードで手動作成したサブスクはここに来る
      console.log('サブスク更新イベント受信（対応コードなし）:', subscription.id, status);
      return res.status(200).json({ received: true, warning: 'no code for subscription' });
    }

    const record = await readCodeRecord(redis, code);
    if (!record) {
      console.error('サブスク更新イベント受信（コードレコードなし）:', code, subscription.id);
      return res.status(200).json({ received: true, warning: 'no code record' });
    }

    const known = Object.prototype.hasOwnProperty.call(ACCESS_BY_STATUS, status);
    if (!known) console.warn('未知のサブスク状態のため無効化:', status, subscription.id);
    const shouldBeActive = known ? ACCESS_BY_STATUS[status] : false;

    // 再送・順序逆転への備え: すでに適用した分より古いイベントは捨てる
    const lastAppliedAt = Math.max(record.statusEventAt || 0, record.canceledAt || 0);
    if (eventAt < lastAppliedAt) {
      console.log('古いサブスク更新イベントのため無視:', subscription.id, status);
      return res.status(200).json({ received: true, ignored: 'stale event' });
    }

    // 既存フィールド(email/stripeSessionId/createdAtなど)はそのまま残す。
    // 同じイベントが再送されても書き込む内容は変わらない。
    const wasActive = record.active === true;
    record.active = shouldBeActive;
    record.subscriptionStatus = status;
    record.statusEventAt = eventAt;
    if (wasActive !== shouldBeActive) record.statusChangedAt = Date.now();
    await redis.set(`code:${code}`, JSON.stringify(record));
    console.log('サブスク状態を反映:', code, status, shouldBeActive ? '有効' : '無効');
  }

  // 支払い失敗の通知（ここではアクセスを止めない。失効は上の状態遷移に任せる）
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const rawSub = invoice.subscription || invoice.parent?.subscription_details?.subscription;
    const subscriptionId = typeof rawSub === 'string' ? rawSub : rawSub?.id || null;

    if (!subscriptionId) {
      console.log('支払い失敗イベント受信（サブスク以外）:', invoice.id);
      return res.status(200).json({ received: true, warning: 'no subscription' });
    }

    const redis = getRedis();
    const code = await redis.get(`sub:${subscriptionId}`);
    if (!code) {
      console.log('支払い失敗イベント受信（対応コードなし）:', subscriptionId);
      return res.status(200).json({ received: true, warning: 'no code for subscription' });
    }

    const record = await readCodeRecord(redis, code);
    if (!record?.email) {
      console.error('支払い失敗イベント受信（宛先メール不明）:', code, subscriptionId);
      return res.status(200).json({ received: true, warning: 'no email' });
    }

    try {
      await sendPaymentFailedEmail(record.email, invoice.hosted_invoice_url);
      console.log('支払い失敗を通知:', code);
    } catch (mailErr) {
      console.error('支払い失敗通知メールの送信エラー:', mailErr.message);
      // メール失敗でStripeに再送させると無限リトライになるため、投げずに握りつぶす
    }
  }

  return res.status(200).json({ received: true });
}
