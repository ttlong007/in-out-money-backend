/**
 * Bearer-token authentication.
 *
 * Populates `c.get('userId')` for every route mounted behind it. A route that is
 * behind this middleware can treat the user id as present without checking.
 */

import type { MiddlewareHandler } from 'hono';

import { ApiError } from '@/lib/errors';
import { verifyAccessToken } from '@/lib/tokens';

export type AuthVariables = {
  userId: string;
  userEmail: string;
};

export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const header = c.req.header('Authorization');

  if (!header?.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing Bearer token');
  }

  const payload = await verifyAccessToken(header.slice('Bearer '.length).trim());

  c.set('userId', payload.sub);
  c.set('userEmail', payload.email);

  await next();
};
