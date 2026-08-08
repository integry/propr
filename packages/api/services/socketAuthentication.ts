import { IncomingMessage, ServerResponse } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Server as SocketIOServer, Socket } from 'socket.io';
import {
  SocketAuthenticationError,
  type SocketPrincipal,
} from '../auth.js';

export interface SocketAuthenticationOptions {
  engineMiddleware: RequestHandler[];
  authenticate: (request: Request) => Promise<SocketPrincipal>;
  revalidationIntervalMs?: number;
}

type SocketAuthenticationRevalidator = () => Promise<boolean>;

interface RevalidatingSocketData {
  principal?: SocketPrincipal;
  revalidateAuthentication?: SocketAuthenticationRevalidator;
}

interface PassportSessionData {
  passport?: { user?: Request['user'] };
}

const DEFAULT_REVALIDATION_INTERVAL_MS = 60_000;

interface SocketAuthenticationFailure extends Error {
  data?: { code: string };
}

function socketAuthenticationFailure(error: unknown): SocketAuthenticationFailure {
  const failure = new Error('WebSocket authentication failed') as SocketAuthenticationFailure;
  failure.data = {
    code: error instanceof SocketAuthenticationError ? error.code : 'AUTHENTICATION_FAILED',
  };
  return failure;
}

async function reloadPassportSession(request: Request): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    request.session.reload(error => {
      if (error) {
        reject(error);
        return;
      }

      const sessionUser = (request.session as typeof request.session & PassportSessionData)
        .passport?.user;
      if (!sessionUser) {
        delete request.user;
        reject(new SocketAuthenticationError(
          'AUTHENTICATION_REQUIRED',
          'Session is no longer authenticated',
        ));
        return;
      }

      request.user = sessionUser;
      resolve();
    });
  });
}

function revalidationInterval(options: SocketAuthenticationOptions): number {
  const configured = options.revalidationIntervalMs;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_REVALIDATION_INTERVAL_MS;
}

function hasSameEffectiveAuthorization(
  current: SocketPrincipal['authorization'],
  next: SocketPrincipal['authorization'],
): boolean {
  if (current.role !== next.role) return false;
  const currentPermissions = new Set(current.permissions);
  const nextPermissions = new Set(next.permissions);
  return currentPermissions.size === nextPermissions.size
    && [...currentPermissions].every(permission => nextPermissions.has(permission));
}

export async function revalidateSocketAuthentication(socket: Socket): Promise<boolean> {
  const revalidate = (socket.data as RevalidatingSocketData).revalidateAuthentication;
  if (!revalidate) {
    console.error(`[SocketAuthentication] Socket ${socket.id} is missing its revalidation gate`);
    socket.disconnect(true);
    return false;
  }

  try {
    return await revalidate();
  } catch (error) {
    console.error(`[SocketAuthentication] Revalidation gate failed for socket ${socket.id}:`, error);
    socket.disconnect(true);
    return false;
  }
}

/** Attach the HTTP session/Passport middleware and a mandatory identity gate. */
export function configureSocketAuthentication(
  io: SocketIOServer,
  options: SocketAuthenticationOptions,
): void {
  for (const middleware of options.engineMiddleware) {
    io.engine.use((
      request: IncomingMessage,
      response: ServerResponse,
      next: (error?: Error) => void,
    ) => {
      middleware(
        request as unknown as Request,
        response as unknown as Response,
        next as NextFunction,
      );
    });
  }

  io.use(async (socket, next) => {
    const request = socket.request as unknown as Request;
    const usesPassportSession = Boolean(request.isAuthenticated?.() && request.user);
    try {
      const initialPrincipal = await options.authenticate(request);
      const data = socket.data as RevalidatingSocketData;
      data.principal = initialPrincipal;

      let pendingRevalidation: Promise<boolean> | undefined;
      data.revalidateAuthentication = () => {
        if (pendingRevalidation) return pendingRevalidation;

        pendingRevalidation = (async () => {
          try {
            if (usesPassportSession) await reloadPassportSession(request);
            const principal = await options.authenticate(request);
            if (principal.user.id !== initialPrincipal.user.id) {
              throw new SocketAuthenticationError(
                'AUTHENTICATION_IDENTITY_CHANGED',
                'Socket identity changed during revalidation',
              );
            }
            if (!hasSameEffectiveAuthorization(initialPrincipal.authorization, principal.authorization)) {
              throw new SocketAuthenticationError(
                'AUTHORIZATION_CHANGED',
                'Socket authorization changed during revalidation',
              );
            }
            data.principal = principal;
            return true;
          } catch (error) {
            const code = error instanceof SocketAuthenticationError
              ? error.code
              : 'AUTHENTICATION_FAILED';
            console.warn(
              `[SocketAuthentication] Disconnecting socket ${socket.id} after revalidation failed (${code})`,
            );
            delete data.principal;
            socket.disconnect(true);
            return false;
          }
        })().finally(() => {
          pendingRevalidation = undefined;
        });
        return pendingRevalidation;
      };

      const timer = setInterval(() => {
        void data.revalidateAuthentication?.();
      }, revalidationInterval(options));
      timer.unref();
      socket.once('disconnect', () => clearInterval(timer));
      next();
    } catch (error) {
      next(socketAuthenticationFailure(error));
    }
  });
}
