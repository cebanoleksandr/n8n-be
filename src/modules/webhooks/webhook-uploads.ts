import { PayloadTooLargeException } from '@nestjs/common';
import type { Request, Response } from 'express';
import multer from 'multer';

export interface UploadedFile {
  field: string;
  data: Buffer;
  fileName?: string;
  mimeType: string;
}

const MAX_FILES = 20;

/**
 * Files sent to a webhook:
 * - multipart/form-data: every file part (text fields stay in req.body);
 * - any other non-JSON, non-form body (PDF, image, octet-stream...): the raw
 *   body as one file named "data".
 */
export async function receiveFiles(
  req: Request,
  res: Response,
  maxBytes: number,
): Promise<UploadedFile[]> {
  const type = req.headers['content-type'] ?? '';
  if (type.startsWith('multipart/form-data')) {
    return receiveMultipart(req, res, maxBytes);
  }
  const parsedByExpress =
    type.startsWith('application/json') ||
    type.startsWith('application/x-www-form-urlencoded');
  if (parsedByExpress || !hasBody(req)) return [];

  const data = await readRaw(req, maxBytes);
  if (data.length === 0) return [];
  return [
    {
      field: 'data',
      data,
      mimeType: type.split(';')[0].trim() || 'application/octet-stream',
    },
  ];
}

function hasBody(req: Request): boolean {
  return (
    req.headers['transfer-encoding'] !== undefined ||
    Number(req.headers['content-length'] ?? 0) > 0
  );
}

async function receiveMultipart(
  req: Request,
  res: Response,
  maxBytes: number,
): Promise<UploadedFile[]> {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: MAX_FILES },
  }).any();
  await new Promise<void>((resolve, reject) =>
    upload(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code.startsWith('LIMIT_')) {
        reject(new PayloadTooLargeException(`Upload rejected: ${err.message}`));
      } else if (err) {
        reject(err as Error);
      } else {
        resolve();
      }
    }),
  );

  // Repeated field names get a suffix: file, file_1, file_2...
  const seen = new Map<string, number>();
  return ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => {
    const count = seen.get(f.fieldname) ?? 0;
    seen.set(f.fieldname, count + 1);
    return {
      field: count === 0 ? f.fieldname : `${f.fieldname}_${count}`,
      data: f.buffer,
      fileName: f.originalname || undefined,
      mimeType: f.mimetype || 'application/octet-stream',
    };
  });
}

async function readRaw(req: Request, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      throw new PayloadTooLargeException(`Body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
