import sharp from 'sharp';
import fs from 'fs-extra';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/postgres.js';

const STORAGE_ROOT = path.join(process.cwd(), 'storage', 'drafts');
const MAX_TEXT_CHARS = 100000;
const HEAD_CHARS = 5000;
const TAIL_CHARS = 20000;
const MAX_IMAGE_DIMENSION = 1024;
const IMAGE_QUALITY = 80;
const IMAGE_TOKEN_ESTIMATE = 1000;

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

    const finalFilename = `${fileId}${isImage ? '.jpg' : ext || '.txt'}`;
    const finalPath = path.join(draftDir, finalFilename);
    let tokenEstimate = 0;
    let fileSize = 0;

    if (isImage) {
      await sharp(file.path)
        .resize({
          width: MAX_IMAGE_DIMENSION,
          height: MAX_IMAGE_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: IMAGE_QUALITY, mozjpeg: true })
        .toFile(finalPath);

      const stats = await fs.stat(finalPath);
      fileSize = stats.size;
      tokenEstimate = IMAGE_TOKEN_ESTIMATE;
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

        content = `${head}\n\n... [TRUNCATED BY GITFIX: REMOVED ${removed} CHARS] ...\n\n${tail}`;
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
      mimeType: isImage ? 'image/jpeg' : 'text/plain',
      size: fileSize,
      tokenEstimate,
      type: isImage ? 'image' : 'text'
    };

    if (db) {
      const draft = await db('task_drafts').where({ draft_id: draftId }).first();
      if (!draft) {
        throw new Error('Draft not found');
      }
      const currentAttachments: Attachment[] = draft.attachments || [];

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

    const attachments: Attachment[] = draft.attachments || [];
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
}
