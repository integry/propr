import type { Response } from 'express';

const JSON_HTML_SIGNIFICANT_CHARACTERS = /[<>&]/g;

const JSON_HTML_ESCAPES: Readonly<Record<string, string>> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
};

/** Send JSON whose wire representation is safe to embed in an HTML context. */
export function sendSafeJson(res: Response, value: unknown): Response {
  const json = JSON.stringify(value);
  const serialized = json?.replace(
    JSON_HTML_SIGNIFICANT_CHARACTERS,
    character => JSON_HTML_ESCAPES[character],
  );
  return res.type('application/json').send(serialized);
}
