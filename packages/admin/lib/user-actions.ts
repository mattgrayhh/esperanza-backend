'use server';

// =============================================================================
// packages/admin — User management server actions (admin-only).
//
// CRUD for admin_users. All mutations are gated on role === 'admin'. Reads
// (listAdminUsers) are also admin-gated because the user list (emails + roles)
// is sensitive. Passwords are never returned except when freshly generated
// (createAdminUser / resetAdminUserPassword return the cleartext once for
// display — the caller must show it and discard it).
// =============================================================================

import { revalidatePath } from 'next/cache';
import { eq, sql } from 'drizzle-orm';
import { adminUsers, type AdminUser } from '@esperanza/db';
import { getDb } from './db';
import { getCurrentUserOrNull, isAdmin } from './auth';
import { hashPassword, generatePassword } from './password';

const SETTINGS_PATH = '/settings/users';

// =============================================================================
// List
// =============================================================================

/** All admin_users, ordered by created_at ascending. Admin-gated. */
export async function listAdminUsers(): Promise<AdminUser[]> {
  if (!(await isAdmin())) return [];
  const { db } = getDb();
  return db
    .select()
    .from(adminUsers)
    .orderBy(sql`coalesce(${adminUsers.createdAt}, '') asc`);
}

// =============================================================================
// Create
// =============================================================================

export interface CreateUserResult {
  error?: string;
  /** Cleartext password — shown once. Null on error. */
  password?: string;
}

/**
 * Insert a new admin_users row. The password is auto-generated (URL-safe base64,
 * ~20 bytes entropy) and returned in plaintext — the caller displays it once.
 */
export async function createAdminUser(data: {
  email: string;
  name?: string;
  role: string;
}): Promise<CreateUserResult> {
  if (!(await isAdmin())) return { error: 'Forbidden: admin role required.' };

  const email = data.email.trim().toLowerCase();
  if (!email || !email.includes('@')) return { error: 'A valid email is required.' };

  const role = data.role === 'admin' ? 'admin' : 'editor';
  const name = data.name?.trim() || email.split('@')[0]!;
  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  const { db } = getDb();
  try {
    await db.insert(adminUsers).values({
      email,
      name,
      passwordHash,
      role,
      createdAt: now,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('primary key')) {
      return { error: `A user with email ${email} already exists.` };
    }
    return { error: 'Failed to create user. Please try again.' };
  }

  revalidatePath(SETTINGS_PATH);
  return { password };
}

// =============================================================================
// Update (name + role only — email is the PK and cannot change)
// =============================================================================

export interface UpdateUserResult {
  error?: string;
}

export async function updateAdminUser(
  email: string,
  data: { name?: string; role?: string }
): Promise<UpdateUserResult> {
  if (!(await isAdmin())) return { error: 'Forbidden: admin role required.' };

  const normalEmail = email.trim().toLowerCase();
  if (!normalEmail) return { error: 'Email is required.' };

  const patch: Partial<AdminUser> = {};
  if (data.name !== undefined) patch.name = data.name.trim() || normalEmail.split('@')[0]!;
  if (data.role !== undefined) patch.role = data.role === 'admin' ? 'admin' : 'editor';

  if (Object.keys(patch).length === 0) return {};

  const { db } = getDb();
  const updated = await db
    .update(adminUsers)
    .set(patch)
    .where(eq(sql`lower(${adminUsers.email})`, normalEmail))
    .returning({ email: adminUsers.email });

  if (updated.length === 0) return { error: 'User not found.' };

  revalidatePath(SETTINGS_PATH);
  return {};
}

// =============================================================================
// Reset password
// =============================================================================

export interface ResetPasswordResult {
  error?: string;
  password?: string;
}

/** Generate + store a new random password. Returns the cleartext once. */
export async function resetAdminUserPassword(email: string): Promise<ResetPasswordResult> {
  if (!(await isAdmin())) return { error: 'Forbidden: admin role required.' };

  const normalEmail = email.trim().toLowerCase();
  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  const { db } = getDb();
  const updated = await db
    .update(adminUsers)
    .set({ passwordHash })
    .where(eq(sql`lower(${adminUsers.email})`, normalEmail))
    .returning({ email: adminUsers.email });

  if (updated.length === 0) return { error: 'User not found.' };

  revalidatePath(SETTINGS_PATH);
  return { password };
}

// =============================================================================
// Delete
// =============================================================================

export interface DeleteUserResult {
  error?: string;
}

/** Delete a user. Blocks self-deletion. */
export async function deleteAdminUser(email: string): Promise<DeleteUserResult> {
  if (!(await isAdmin())) return { error: 'Forbidden: admin role required.' };

  const normalEmail = email.trim().toLowerCase();
  const currentEmail = await getCurrentUserOrNull();
  if (currentEmail && currentEmail.toLowerCase() === normalEmail) {
    return { error: 'You cannot delete your own account.' };
  }

  const { db } = getDb();
  await db
    .delete(adminUsers)
    .where(eq(sql`lower(${adminUsers.email})`, normalEmail));

  revalidatePath(SETTINGS_PATH);
  return {};
}
