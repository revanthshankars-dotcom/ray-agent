# J.A.R.V.I.S. Firestore Security Specification

## 1. Data Invariants
1. Every document across `/users/{userId}` and all subcollections (`tasks`, `analyses`, `routines`, `messages`, `handoffs`) MUST belong to the authenticated, email-verified user (`request.auth.uid == userId` and `incoming().userId == request.auth.uid`).
2. Every subcollection write (`create`, `update`) and single-doc read/delete (`get`, `delete`) enforces the Master Gate `exists(/databases/$(database)/documents/users/$(userId))`, guaranteeing sub-resources cannot exist orphaned without a parent owner profile.
3. All `list` queries enforce `resource.data.userId == request.auth.uid` without issuing `get()` or `exists()` reads inside `allow list`.
4. All document IDs (`userId`, `taskId`, `analysisId`, `routineId`, `messageId`, `handoffId`) match `^[a-zA-Z0-9_-]+$` and `size() <= 128`.
5. All `createdAt` and `updatedAt` timestamps strictly require `request.time`, and `createdAt` + `userId` are immutable on update.
6. Every array (`blockers`, `subtasks`, `executableSteps`, `steps`, `toolCalls`, `sources`) is strictly size-bounded and element-type-checked on index 0 when non-empty.
7. Default-deny catch-all `match /{document=**} { allow read, write: if false; }` is enforced at the top of `/databases/{database}/documents`.

## 2. The "Dirty Dozen" Adversarial Payloads (Must All Return PERMISSION_DENIED)
1. **Unauthenticated Write**: Create `/users/u1/tasks/t1` with `auth == null`.
2. **Unverified Email Write**: Create `/users/u1/tasks/t1` with `email_verified: false`.
3. **Identity Spoofing (Cross-User Path)**: Signed in as `u1`, read or write `/users/u2/tasks/t1`.
4. **Identity Spoofing (Payload UID Mismatch)**: Signed in as `u1`, create `/users/u1/tasks/t1` with `userId: "u2"`.
5. **Shadow Field Injection**: Create `/users/u1/tasks/t1` with an extra field `isAdmin: true` or `bypassGate: true`.
6. **Orphaned Subcollection Write**: Create `/users/u1/tasks/t1` before `/users/u1` exists.
7. **Timestamp Forgery (Create)**: Create `/users/u1/tasks/t1` with client-supplied `createdAt` != `request.time`.
8. **Immortal Field Mutation (Update)**: Update `/users/u1/tasks/t1` changing `userId` or `createdAt`.
9. **ID Poisoning**: Create `/users/u1/tasks/bad$id/..` or 200-char task ID.
10. **Denial-of-Wallet String Bloat**: Create `/users/u1/tasks/t1` with 10,000-char `title` (limit 240).
11. **Unbounded Array Flood**: Create `/users/u1/analyses/a1` with 50 items in `subtasks` (limit 15) or wrong element type `[123]`.
12. **PII Blanket Read**: Signed in as `u2`, `get` or `list` `/users/u1` containing `email`.
