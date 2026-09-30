import { GLOBAL_API_PREFIX } from '../../common/constants';

/**
 * URLs of the media module that other modules have to agree on.
 *
 * Kept in their own file so a module that only needs to *recognise* a media URL
 * (vendor KYC validation, for example) does not import the media service, and so
 * the pattern and the builder can never drift apart.
 */

/** Canonical URL of a private document: the authenticated download route. */
export function documentDownloadUrl(assetId: string): string {
  return `/${GLOBAL_API_PREFIX}/media/documents/${assetId}/download`;
}

/**
 * The exact shape produced by {@link documentDownloadUrl}.
 *
 * Any other value — a hand-written URL, a link to an external host, a public file
 * — is rejected before the ownership check even runs, so a vendor cannot attach a
 * document that the platform does not control.
 */
export const DOCUMENT_URL_PATTERN = new RegExp(
  `^/${GLOBAL_API_PREFIX}/media/documents/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/download$`,
);

/** Explanation reused by the DTO message and the service-level ownership check. */
export const DOCUMENT_URL_HINT = 'POST /media/upload/document';
