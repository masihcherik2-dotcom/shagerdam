import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'shopino:isPublic';

/**
 * Marks a route as reachable without a JWT. `JwtAuthGuard` is registered
 * globally, so authentication is opt-out and every new endpoint is protected by
 * default — a forgotten decorator can only ever make a route *stricter*, never
 * accidentally open.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
