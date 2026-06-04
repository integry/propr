import sharp from 'sharp';
import fs from 'fs-extra';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/connection.js';
import type { Logger } from 'pino';

type ImageOptimizationLogger = {
  debug?: (obj: unknown, msg?: string) => void;
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
};

const STORAGE_ROOT = path.join(process.cwd(), 'storage', 'drafts');
const MAX_TEXT_CHARS = 100000;
const HEAD_CHARS = 5000;
const TAIL_CHARS = 20000;
const MAX_IMAGE_DIMENSION = 1024;
const IMAGE_QUALITY = 80; // WebP quality (0-100)
const DEFAULT_MAX_OPTIMIZED_IMAGE_BYTES = 96 * 1024;
const IMAGE_OPTIMIZATION_STEPS = [
  { dimension: MAX_IMAGE_DIMENSION, quality: IMAGE_QUALITY },
  { dimension: 768, quality: 75 },
  { dimension: 640, quality: 70 },
  { dimension: 512, quality: 65 },
  { dimension: 384, quality: 60 },
  { dimension: 320, quality: 55 }
];

/**
 * Calculate token estimate for an image based on file size.
 * Images are embedded as base64 text, so we calculate:
 * - Base64 encoding increases size by ~33% (4/3 ratio)
 * - Text tokenization: ~4 characters per token
 * - Add 10% buffer for XML wrapper overhead
 */
function calculateImageTokenEstimate(fileSizeBytes: number): number {
  const base64Size = Math.ceil(fileSizeBytes * 4 / 3);
  const tokenEstimate = Math.ceil(base64Size / 4);
  return Math.ceil(tokenEstimate * 1.1); // 10% buffer for XML overhead
}

function getMaxOptimizedImageBytes(): number {
  const configured = Number.parseInt(
    process.env.ATTACHMENT_MAX_OPTIMIZED_IMAGE_BYTES || String(DEFAULT_MAX_OPTIMIZED_IMAGE_BYTES),
    10
  );
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_OPTIMIZED_IMAGE_BYTES;
}

async function optimizeImageForContext(
  input: string | Buffer,
  finalPath: string,
  logger?: ImageOptimizationLogger
): Promise<{ size: number; dimension: number; quality: number; withinLimit: boolean }> {
  const maxBytes = getMaxOptimizedImageBytes();
  let lastResult: { size: number; dimension: number; quality: number; withinLimit: boolean } | null = null;

  for (const step of IMAGE_OPTIMIZATION_STEPS) {
    await sharp(input)
      .resize({
        width: step.dimension,
        height: step.dimension,
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: step.quality })
      .toFile(finalPath);

    const stats = await fs.stat(finalPath);
    lastResult = {
      size: stats.size,
      dimension: step.dimension,
      quality: step.quality,
      withinLimit: stats.size <= maxBytes
    };

    if (lastResult.withinLimit) {
      logger?.debug?.({ ...lastResult, maxBytes }, 'Optimized image attachment within size limit');
      return lastResult;
    }
  }

  logger?.warn?.({ ...lastResult, maxBytes }, 'Optimized image attachment still exceeds size limit at lowest quality');
  return lastResult!;
}

export async function ensureImageFitsContext(
  imagePath: string,
  logger?: ImageOptimizationLogger
): Promise<{ size: number; optimized: boolean }> {
  const maxBytes = getMaxOptimizedImageBytes();
  const stats = await fs.stat(imagePath);
  if (stats.size <= maxBytes) {
    return { size: stats.size, optimized: false };
  }

  const tempPath = `${imagePath}.optimized-${uuidv4()}.webp`;
  const optimization = await optimizeImageForContext(imagePath, tempPath, logger);
  await fs.move(tempPath, imagePath, { overwrite: true });
  logger?.info?.({
    path: imagePath,
    originalSize: stats.size,
    optimizedSize: optimization.size,
    dimension: optimization.dimension,
    quality: optimization.quality
  }, 'Downsized stored image attachment to fit context');

  return { size: optimization.size, optimized: true };
}

const ALLOWED_TEXT_MIMETYPES = [
  'text/plain',
  'text/html',
  'text/css',
  'text/javascript',
  'text/markdown',
  'text/xml',
  'text/csv',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript'
];

const ALLOWED_CODE_EXTENSIONS = [
  '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.swift', '.kt', '.scala',
  '.sh', '.bash', '.zsh', '.yaml', '.yml', '.toml', '.json', '.xml',
  '.html', '.css', '.scss', '.sass', '.less', '.md', '.txt', '.log',
  '.sql', '.graphql', '.vue', '.svelte'
];

const BINARY_MIMETYPES = [
  'application/octet-stream',
  'application/zip',
  'application/x-rar-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-7z-compressed',
  'application/x-executable',
  'application/x-sharedlib',
  'application/x-mach-binary',
  'application/vnd.microsoft.portable-executable'
];

export interface Attachment {
  id: string;
  originalName: string;
  storedPath: string;
  mimeType: string;
  size: number;
  tokenEstimate: number;
  type: 'image' | 'text';
}

export interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  destination: string;
  filename: string;
  path: string;
  buffer?: Buffer;
}

function isImageType(mimetype: string, ext: string): boolean {
  return mimetype.startsWith('image/') ||
    ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff'].includes(ext);
}

function isTextType(mimetype: string, ext: string): boolean {
  return ALLOWED_TEXT_MIMETYPES.some(t => mimetype.startsWith(t.split('/')[0] + '/')) ||
    mimetype.startsWith('text/') ||
    ALLOWED_CODE_EXTENSIONS.includes(ext);
}

function isBinaryType(mimetype: string, ext: string): boolean {
  if (BINARY_MIMETYPES.includes(mimetype)) {
    return true;
  }
  const binaryExtensions = ['.exe', '.dll', '.so', '.dylib', '.bin', '.zip', '.tar', '.gz', '.rar', '.7z'];
  return binaryExtensions.includes(ext);
}

export class AttachmentService {
  static async processUpload(
    file: MulterFile,
    draftId: string
  ): Promise<Attachment> {
    const draftDir = path.join(STORAGE_ROOT, draftId);
    await fs.ensureDir(draftDir);

    const fileId = uuidv4();
    const ext = path.extname(file.originalname).toLowerCase();

    if (isBinaryType(file.mimetype, ext)) {
      await fs.remove(file.path);
      throw new Error('Binary files are not supported. Please upload images or text files only.');
    }

    const isImage = isImageType(file.mimetype, ext);
    const isText = isTextType(file.mimetype, ext);

    if (!isImage && !isText) {
      await fs.remove(file.path);
      throw new Error(`Unsupported file type: ${file.mimetype}. Please upload images or text files.`);
    }

    const finalFilename = `${fileId}${isImage ? '.webp' : ext || '.txt'}`;
    const finalPath = path.join(draftDir, finalFilename);
    let tokenEstimate = 0;
    let fileSize = 0;

    if (isImage) {
      const optimization = await optimizeImageForContext(file.path, finalPath);
      fileSize = optimization.size;
      tokenEstimate = calculateImageTokenEstimate(fileSize);
    } else {
      let content = await fs.readFile(file.path, 'utf-8');

      if (content.includes('\0')) {
        await fs.remove(file.path);
        throw new Error('Binary files are not supported. The file appears to contain binary data.');
      }

      if (content.length > MAX_TEXT_CHARS) {
        const head = content.slice(0, HEAD_CHARS);
        const tail = content.slice(content.length - TAIL_CHARS);
        const removed = content.length - (HEAD_CHARS + TAIL_CHARS);

        content = `${head}\n\n... [TRUNCATED BY PROPR: REMOVED ${removed} CHARS] ...\n\n${tail}`;
      }

      await fs.writeFile(finalPath, content, 'utf-8');
      const stats = await fs.stat(finalPath);
      fileSize = stats.size;
      tokenEstimate = Math.ceil(content.length / 4);
    }

    await fs.remove(file.path);

    const attachment: Attachment = {
      id: fileId,
      originalName: file.originalname,
      storedPath: path.relative(process.cwd(), finalPath),
      mimeType: isImage ? 'image/webp' : 'text/plain',
      size: fileSize,
      tokenEstimate,
      type: isImage ? 'image' : 'text'
    };

    if (db) {
      const draft = await db('task_drafts').where({ draft_id: draftId }).first();
      if (!draft) {
        throw new Error('Draft not found');
      }
      let currentAttachments: Attachment[] = [];
      if (typeof draft.attachments === 'string') {
        try { currentAttachments = JSON.parse(draft.attachments); } catch { currentAttachments = []; }
      } else if (Array.isArray(draft.attachments)) {
        currentAttachments = draft.attachments;
      }

      await db('task_drafts')
        .where({ draft_id: draftId })
        .update({
          attachments: JSON.stringify([...currentAttachments, attachment]),
          updated_at: db.fn.now()
        });
    }

    return attachment;
  }

  static async deleteAttachment(draftId: string, attachmentId: string): Promise<void> {
    if (!db) {
      throw new Error('Database not available');
    }

    const draft = await db('task_drafts').where({ draft_id: draftId }).first();
    if (!draft) {
      throw new Error('Draft not found');
    }

    let attachments: Attachment[] = [];
    if (typeof draft.attachments === 'string') {
      try { attachments = JSON.parse(draft.attachments); } catch { attachments = []; }
    } else if (Array.isArray(draft.attachments)) {
      attachments = draft.attachments;
    }
    const attachment = attachments.find(a => a.id === attachmentId);

    if (!attachment) {
      throw new Error('Attachment not found');
    }

    const filePath = path.join(process.cwd(), attachment.storedPath);
    await fs.remove(filePath);

    const updatedAttachments = attachments.filter(a => a.id !== attachmentId);
    await db('task_drafts')
      .where({ draft_id: draftId })
      .update({
        attachments: JSON.stringify(updatedAttachments),
        updated_at: db.fn.now()
      });
  }

  static async getAttachmentContent(storedPath: string): Promise<Buffer> {
    const filePath = path.join(process.cwd(), storedPath);
    return fs.readFile(filePath);
  }

  /**
   * Downloads a remote image from a URL and saves it to the target directory.
   * The image is optimized (resized and compressed) before saving.
   *
   * @param url - The URL of the image to download
   * @param targetDir - The directory to save the image to
   * @param logger - Optional logger for debugging/warnings
   * @param authToken - Optional authentication token for GitHub URLs
   * @returns The absolute path to the saved file
   */
  static async downloadRemoteImage(url: string, targetDir: string, logger?: Logger, authToken?: string): Promise<string> {
    await fs.ensureDir(targetDir);

    // Generate a unique filename with UUID
    const fileId = uuidv4();
    const finalFilename = `${fileId}.webp`;
    const finalPath = path.join(targetDir, finalFilename);

    try {
      // Build headers - add auth for GitHub URLs
      const headers: Record<string, string> = {
        'User-Agent': 'ProPR-Bot/1.0 (https://github.com/integry/gitfix)'
      };

      // GitHub user-attachments require authentication
      const isGitHubUrl = url.includes('github.com') || url.includes('githubusercontent.com');
      logger?.debug?.({ url, isGitHubUrl, hasAuthToken: !!authToken }, 'Attempting to download remote image');
      if (isGitHubUrl && authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
        headers['Accept'] = 'application/octet-stream';
        logger?.debug?.({ url }, 'Using GitHub auth token for image download');
      }

      // Fetch the image from the remote URL
      const response = await fetch(url, { headers });

      if (!response.ok) {
        logger?.warn?.({
          url,
          status: response.status,
          statusText: response.statusText,
          hasAuthToken: !!authToken,
          tokenPrefix: authToken ? authToken.substring(0, 4) : 'none',
          redirected: response.redirected,
          finalUrl: response.url
        }, 'Image fetch failed');
        throw new Error(`Failed to fetch image: HTTP ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        throw new Error(`URL does not point to an image: content-type is ${contentType}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Process and optimize the image using sharp
      const optimization = await optimizeImageForContext(buffer, finalPath, logger);

      logger?.debug?.({ url, savedTo: finalPath, imageSize: optimization.size }, 'Successfully downloaded and optimized remote image');

      return finalPath;
    } catch (error) {
      logger?.warn?.({ url, error: (error as Error).message }, 'Failed to download remote image');
      throw error;
    }
  }
}
