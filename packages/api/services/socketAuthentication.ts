import { IncomingMessage, ServerResponse } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import {
  SocketAuthenticationError,
  type SocketPrincipal,
} from '../auth.js';

export interface SocketAuthenticationOptions {
  engineMiddleware: RequestHandler[];
  authenticate: (request: Request) => Promise<SocketPrincipal>;
}

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
    try {
      socket.data.principal = await options.authenticate(socket.request as unknown as Request);
      next();
    } catch (error) {
      next(socketAuthenticationFailure(error));
    }
  });
}
