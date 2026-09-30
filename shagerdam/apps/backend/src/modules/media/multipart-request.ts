/**
 * Structural types for a Fastify request extended by `@fastify/multipart`.
 *
 * `@fastify/multipart` ships its own types, but they are bound to its copy of
 * `fastify`; declaring only the members the media module uses keeps the controller
 * decoupled from the plugin version and makes the request easy to fake in tests.
 *
 * Everything from a multipart body is untrusted: the filename and content type are
 * client-supplied hints, and only the bytes decide what a file is.
 */

export interface MultipartFileStream {
  /** Set by the plugin when the configured file-size limit was hit. */
  truncated: boolean;
  /** Bytes actually received; useful in an error message. */
  bytesRead: number;
}

export interface MultipartFilePart {
  type: 'file';
  /** Field name from `Content-Disposition`, e.g. `file`. */
  fieldname: string;
  /** Client-supplied filename (sanitized before it is stored). */
  filename: string;
  /** Client-supplied content type (never trusted — magic bytes decide). */
  mimetype: string;
  /** Buffers the part; rejects when the transport limit was exceeded. */
  toBuffer: () => Promise<Buffer>;
  file: MultipartFileStream;
}

export interface MultipartFieldPart {
  type: 'field';
  fieldname: string;
  /** String for plain fields; other shapes only appear with nested form data. */
  value: unknown;
}

export type MultipartPart = MultipartFilePart | MultipartFieldPart;

export interface MultipartRequest {
  /** `false` when the request is not `multipart/form-data`. */
  isMultipart?: () => boolean;
  /**
   * Async iterator over the parts **in the order the client sent them**.
   *
   * This is the only reliable way to read fields: `request.body` is a guess about
   * ordering, and a client that sends `file` before `purpose` would silently lose
   * the field. Iterating the stream once collects both.
   */
  parts?: (options?: { limits?: { fileSize?: number; fields?: number; fieldSize?: number } }) => AsyncIterable<MultipartPart>;
}
