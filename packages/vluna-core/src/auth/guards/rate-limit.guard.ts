import { CanActivate, ExecutionContext, Injectable, HttpException } from "@nestjs/common";
import type { AppRequest } from "../../types/app-request.js";

@Injectable()
export class RateLimitGuard implements CanActivate {
  private static hits = new Map<string, { count: number; resetAt: number }>();
  private static WINDOW_MS = Number(process.env.RATELIMIT_WINDOW_MS || 60_000);
  private static LIMIT = Number(process.env.RATELIMIT_LIMIT || 120);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const sub = String(req?.ctx?.sub || 'anon');
    const path = (req?.url as string | undefined) || '';
    const key = `${sub}:${req?.method}:${path}`;
    const now = Date.now();
    const entry = RateLimitGuard.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      RateLimitGuard.hits.set(key, { count: 1, resetAt: now + RateLimitGuard.WINDOW_MS });
      return true;
    }
    if (entry.count >= RateLimitGuard.LIMIT) {
      throw new HttpException('rate_limited', 429);
    }
    entry.count += 1;
    return true;
  }
}
