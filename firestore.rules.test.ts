/**
 * Firestore Security Rules Verification Matrix (Phase 0 TDD)
 * Validates all 12 Dirty Dozen adversarial vectors against firestore.rules.
 */

export interface DirtyDozenCase {
  id: number;
  name: string;
  path: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  authUid: string | null;
  emailVerified: boolean;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_PAYLOADS: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated Task Create',
    path: '/users/user_ray/tasks/task_01',
    operation: 'create',
    authUid: null,
    emailVerified: false,
    payload: { userId: 'user_ray', title: 'Hijack' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Unverified Email Write',
    path: '/users/user_ray/tasks/task_01',
    operation: 'create',
    authUid: 'user_ray',
    emailVerified: false,
    payload: { userId: 'user_ray', title: 'Unverified task' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Cross-User Path Access',
    path: '/users/user_ray/tasks/task_01',
    operation: 'get',
    authUid: 'user_attacker',
    emailVerified: true,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Payload UserId Spoofing',
    path: '/users/user_attacker/tasks/task_01',
    operation: 'create',
    authUid: 'user_attacker',
    emailVerified: true,
    payload: { userId: 'user_ray', title: 'Spoofed' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Shadow Field Injection',
    path: '/users/user_ray/tasks/task_01',
    operation: 'create',
    authUid: 'user_ray',
    emailVerified: true,
    payload: { userId: 'user_ray', title: 'Legit', isAdmin: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Orphaned Subcollection Write Without Parent User Doc',
    path: '/users/user_orphan/tasks/task_01',
    operation: 'create',
    authUid: 'user_orphan',
    emailVerified: true,
    payload: { userId: 'user_orphan', title: 'Orphan' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Timestamp Forgery on Create',
    path: '/users/user_ray/tasks/task_01',
    operation: 'create',
    authUid: 'user_ray',
    emailVerified: true,
    payload: { userId: 'user_ray', title: 'Backdated', createdAt: '1999-01-01T00:00:00Z' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Immortal Field Mutation on Update',
    path: '/users/user_ray/tasks/task_01',
    operation: 'update',
    authUid: 'user_ray',
    emailVerified: true,
    payload: { userId: 'user_other', title: 'Mutated owner' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'ID Poisoning via Oversized/Invalid Doc ID',
    path: `/users/user_ray/tasks/${'x'.repeat(180)}`,
    operation: 'create',
    authUid: 'user_ray',
    emailVerified: true,
    payload: { userId: 'user_ray', title: 'Poison ID' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'String Bloat Exhaustion',
    path: '/users/user_ray/tasks/task_01',
    operation: 'create',
    authUid: 'user_ray',
    emailVerified: true,
    payload: { userId: 'user_ray', title: 'A'.repeat(2000) },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Array Flood & Invalid Element Type',
    path: '/users/user_ray/analyses/analysis_01',
    operation: 'create',
    authUid: 'user_ray',
    emailVerified: true,
    payload: { userId: 'user_ray', subtasks: [12345] },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'PII Blanket Read on User Profile',
    path: '/users/user_ray',
    operation: 'get',
    authUid: 'user_attacker',
    emailVerified: true,
    expected: 'PERMISSION_DENIED',
  },
];
