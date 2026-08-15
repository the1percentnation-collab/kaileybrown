'use server';

import { revalidatePath } from 'next/cache';

import { getSessionUser } from '@/lib/auth/session';
import { saveSiteContent } from '@/lib/content';
import type { SiteContent } from '@/lib/types';

export interface SaveResult {
  ok: boolean;
  message: string;
}

/**
 * Server actions are public HTTP endpoints, so the admin check is repeated
 * here. Never rely on the layout gate alone to protect a mutation.
 */
export async function updateSiteContent(patch: Partial<SiteContent>): Promise<SaveResult> {
  const user = await getSessionUser();

  if (!user) return { ok: false, message: 'Your session expired. Sign in again.' };
  if (user.role !== 'admin') return { ok: false, message: 'You do not have access to this.' };

  try {
    await saveSiteContent(patch, user.email ?? user.uid);
  } catch (error) {
    console.error('Failed to save site content', error);
    return { ok: false, message: 'Could not save. Please try again.' };
  }

  // Refresh the public site and the editor so both show the saved copy.
  revalidatePath('/');
  revalidatePath('/admin');

  return { ok: true, message: 'Saved.' };
}
