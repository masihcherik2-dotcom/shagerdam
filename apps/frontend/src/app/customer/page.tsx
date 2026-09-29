import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { homeForRole } from '@/lib/auth/access';
import { ACCESS_COOKIE, readAccessClaims } from '@/lib/auth/session-core';

/** /customer itself has no content: send the user to their role's landing page (middleware already enforced access). */
export default async function CustomerIndexPage() {
  const claims = readAccessClaims((await cookies()).get(ACCESS_COOKIE)?.value);
  redirect(claims ? homeForRole(claims.role) : '/login');
}
