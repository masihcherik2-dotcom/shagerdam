import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { UploadedFile } from './media.service';
import type { MultipartRequest } from './multipart-request';

/**
 * Reads a multipart upload in a single pass over the request stream.
 *
 * Why one pass matters: a client may send the file before the fields (or the other
 * way round). Iterating `parts()` yields them in the order they arrived, so
 * `purpose` is always available once the file has been buffered — reading
 * `request.body` beforehand is a race that silently falls back to the default.
 *
 * Field names are checked against the ones the endpoint's contract defines
 * (`file` plus `allowedFields`, default `purpose`) and anything else is rejected, mirroring the strictness of the global validation
 * pipe: an unexpected field is a client bug the caller should see, not something to
 * ignore silently.
 */
const FILE_FIELD_NAME = 'file';

export async function readMultipartUpload(
  request: MultipartRequest,
  allowedFields: readonly string[] = ['purpose'],
): Promise<{ file: UploadedFile; fields: Record<string, string> }> {
  const ALLOWED_FIELD_NAMES: ReadonlySet<string> = new Set([FILE_FIELD_NAME, ...allowedFields]);
  if (typeof request.parts !== 'function' || request.isMultipart?.() === false) {
    throw new BadRequestException(
      'Expected multipart/form-data: send the file in a field named "file" (curl -F "file=@…")',
    );
  }

  const fields: Record<string, string> = {};
  let file: UploadedFile | null = null;

  try {
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        if (!ALLOWED_FIELD_NAMES.has(part.fieldname)) {
          throw new BadRequestException(
            `Unexpected field "${part.fieldname}". Allowed fields: ${[...ALLOWED_FIELD_NAMES].join(', ')}`,
          );
        }
        if (part.fieldname === FILE_FIELD_NAME) {
          throw new BadRequestException(`Field "${FILE_FIELD_NAME}" must carry the file, not a value`);
        }
        // `value` is typed as unknown by the multipart types; only a string is a
        // legal form field, so anything else is a malformed request.
        if (typeof part.value !== 'string') {
          throw new BadRequestException(`Field "${part.fieldname}" must be a text value`);
        }
        fields[part.fieldname] = part.value;
        continue;
      }

      if (file !== null) {
        throw new BadRequestException('Only one file per request is supported');
      }
      if (part.fieldname !== FILE_FIELD_NAME) {
        throw new BadRequestException(
          `The file must be sent in a field named "${FILE_FIELD_NAME}", received "${part.fieldname}"`,
        );
      }

      const buffer = await part.toBuffer();
      if (part.file.truncated) {
        throw new PayloadTooLargeException(
          `The uploaded file exceeds the transport limit of ${Math.round(maxRequestFileBytes() / 1024 / 1024)} MB`,
        );
      }
      file = { originalName: part.filename, declaredMimeType: part.mimetype, buffer };
    }
  } catch (error) {
    throw toUploadError(error);
  }

  if (file === null) {
    throw new BadRequestException('No file was uploaded: expected a multipart part named "file"');
  }
  return { file, fields };
}

/**
 * Turns the multipart plugin's size-limit error into a 413 the client can act on.
 *
 * The distinction matters: `400` means "this file is wrong" (unsupported type, over
 * the per-kind budget, unreadable image), `413` means "this upload is too large to
 * receive at all". Anything else is rethrown untouched so real bugs stay visible.
 */
function toUploadError(error: unknown): unknown {
  if (error instanceof BadRequestException || error instanceof PayloadTooLargeException) {
    return error;
  }
  if (error instanceof Error && /too large|filesize|file size/i.test(error.message)) {
    return new PayloadTooLargeException(
      `The uploaded file exceeds the transport limit of ${Math.round(maxRequestFileBytes() / 1024 / 1024)} MB`,
    );
  }
  if (error instanceof Error && /multipart/i.test(error.message)) {
    return new BadRequestException('Expected a valid multipart/form-data request');
  }
  return error;
}

/** Transport ceiling, mirroring the value `registerMultipart` configures. */
function maxRequestFileBytes(): number {
  return Number(process.env['MEDIA_MAX_DOCUMENT_BYTES'] ?? 10_485_760);
}
