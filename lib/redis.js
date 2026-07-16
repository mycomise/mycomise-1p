// Upstash Redis（REDIS_URL環境変数）への共有接続
import { Redis } from 'ioredis';

let client;

export function getRedis() {
  if (!client) {
    client = new Redis(process.env.REDIS_URL);
  }
  return client;
}
