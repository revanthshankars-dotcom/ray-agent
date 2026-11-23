import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  reauthenticateWithPopup,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Timestamp,
} from 'firebase/firestore';
import {
  auth,
  clearInMemoryGoogleAccessToken,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
  setInMemoryGoogleAccessToken,
} from '../firebase';
import type {
  AppConnector,
  AppConnectorCategory,
  AppConnectorType,
  BrainNote,
  ChatMessage,
  HandoffItem,
  RoutinePlan,
  SharedTask,
  TaskAnalysisResult,
  TaskCategory,
  TaskPriority,
  UserProfile,
  VoicePersona,
} from '../types/relay';

function sanitizeId(raw: string): string {
  const cleaned = (raw || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return cleaned || `id_${Date.now()}`;
}

function toMillis(val: unknown): number {
  if (val && typeof val === 'object' && 'toMillis' in val && typeof (val as Timestamp).toMillis === 'function') {
    return (val as Timestamp).toMillis();
  }
  if (typeof val === 'number') return val;
  return Date.now();
}

const VALID_VOICES: VoicePersona[] = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'];
const VALID_CATEGORIES: TaskCategory[] = ['coding', 'system', 'research', 'personal', 'workflow', 'general'];
const VALID_PRIORITIES: TaskPriority[] = ['critical', 'high', 'medium', 'low'];
const VALID_CONNECTOR_CATS: AppConnectorCategory[] = ['google', 'browser', 'notes', 'social', 'productivity', 'automation'];
const VALID_CONNECTOR_TYPES: AppConnectorType[] = ['notion', 'bridge_app', 'url_template', 'webhook'];

interface FirebaseContextValue {
  user: User | null;
  authReady: boolean;
  profileReady: boolean;
  authError: string | null;
  googleAccessToken: string | null;
  userProfile: UserProfile | null;
  cloudTasks: SharedTask[];
  cloudAnalyses: TaskAnalysisResult[];
  cloudRoutines: RoutinePlan[];
  cloudMessages: ChatMessage[];
  cloudHandoffs: HandoffItem[];
  cloudBrainNotes: BrainNote[];
  cloudConnectors: AppConnector[];
  signInWithGoogle: () => Promise<void>;
  connectGoogleWorkspace: () => Promise<string | null>;
  signOutUser: () => Promise<void>;
  updatePreferences: (prefs: Partial<Pick<UserProfile, 'preferredVoice' | 'wakeEnabled' | 'wakeSensitivity'>>) => Promise<void>;
  saveTaskToCloud: (task: SharedTask) => Promise<void>;
  toggleTaskInCloud: (taskId: string, completed: boolean) => Promise<void>;
  deleteTaskFromCloud: (taskId: string) => Promise<void>;
  saveAnalysisToCloud: (analysis: TaskAnalysisResult) => Promise<void>;
  deleteAnalysisFromCloud: (analysisId: string) => Promise<void>;
  saveRoutineToCloud: (routine: RoutinePlan) => Promise<void>;
  deleteRoutineFromCloud: (routineId: string) => Promise<void>;
  saveMessageToCloud: (roomId: string, msg: ChatMessage) => Promise<void>;
  updateMessageInCloud: (msgId: string, patch: Pick<ChatMessage, 'text' | 'toolCalls' | 'sources'>) => Promise<void>;
  clearMessagesInCloud: () => Promise<void>;
  saveHandoffToCloud: (item: HandoffItem) => Promise<void>;
  deleteHandoffFromCloud: (itemId: string) => Promise<void>;
  saveBrainNoteToCloud: (note: BrainNote) => Promise<void>;
  deleteBrainNoteFromCloud: (noteId: string) => Promise<void>;
  saveConnectorToCloud: (connector: AppConnector) => Promise<void>;
  deleteConnectorFromCloud: (connectorId: string) => Promise<void>;
}

const FirebaseContext = createContext<FirebaseContextValue | null>(null);

export const FirebaseProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [profileReady, setProfileReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);

  const [cloudTasks, setCloudTasks] = useState<SharedTask[]>([]);
  const [cloudAnalyses, setCloudAnalyses] = useState<TaskAnalysisResult[]>([]);
  const [cloudRoutines, setCloudRoutines] = useState<RoutinePlan[]>([]);
  const [cloudMessages, setCloudMessages] = useState<ChatMessage[]>([]);
  const [cloudHandoffs, setCloudHandoffs] = useState<HandoffItem[]>([]);
  const [cloudBrainNotes, setCloudBrainNotes] = useState<BrainNote[]>([]);
  const [cloudConnectors, setCloudConnectors] = useState<AppConnector[]>([]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      setAuthError(null);

      if (!nextUser) {
        clearInMemoryGoogleAccessToken();
        setGoogleAccessToken(null);
        setProfileReady(false);
        setUserProfile(null);
        setCloudTasks([]);
        setCloudAnalyses([]);
        setCloudRoutines([]);
        setCloudMessages([]);
        setCloudHandoffs([]);
        setCloudBrainNotes([]);
        setCloudConnectors([]);
        return;
      }

      if (!nextUser.emailVerified) {
        setAuthError('Google account email verification is required for cloud persistence.');
        setProfileReady(false);
        return;
      }

      const profilePath = `users/${nextUser.uid}`;
      try {
        const ref = doc(db, 'users', nextUser.uid);
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          const initialProfile = {
            userId: nextUser.uid,
            email: (nextUser.email || '').slice(0, 254),
            displayName: (nextUser.displayName || 'Ray').slice(0, 120),
            photoURL: (nextUser.photoURL || '').slice(0, 500),
            preferredVoice: 'Fenrir' as VoicePersona,
            wakeEnabled: false,
            wakeSensitivity: 0.75,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          };
          await setDoc(ref, initialProfile);
          setUserProfile({
            userId: initialProfile.userId,
            email: initialProfile.email,
            displayName: initialProfile.displayName,
            photoURL: initialProfile.photoURL,
            preferredVoice: initialProfile.preferredVoice,
            wakeEnabled: initialProfile.wakeEnabled,
            wakeSensitivity: initialProfile.wakeSensitivity,
          });
        } else {
          const d = snap.data();
          setUserProfile({
            userId: String(d.userId || nextUser.uid),
            email: String(d.email || ''),
            displayName: String(d.displayName || 'Ray'),
            photoURL: String(d.photoURL || ''),
            preferredVoice: VALID_VOICES.includes(d.preferredVoice) ? (d.preferredVoice as VoicePersona) : 'Fenrir',
            wakeEnabled: Boolean(d.wakeEnabled),
            wakeSensitivity: typeof d.wakeSensitivity === 'number' ? d.wakeSensitivity : 0.75,
          });
        }
        setProfileReady(true);
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, profilePath);
      }
    });

    return () => unsub();
  }, []);

  useEffect(() => {
    if (!authReady || !profileReady || !user || !user.emailVerified) return;
    const uid = user.uid;

    const tasksPath = `users/${uid}/tasks`;
    const analysesPath = `users/${uid}/analyses`;
    const routinesPath = `users/${uid}/routines`;
    const messagesPath = `users/${uid}/messages`;
    const handoffsPath = `users/${uid}/handoffs`;
    const brainPath = `users/${uid}/brainNotes`;
    const connectorsPath = `users/${uid}/connectors`;

    const unsubTasks = onSnapshot(
      query(collection(db, tasksPath), where('userId', '==', uid), orderBy('createdAt', 'desc'), limit(100)),
      (snap) => {
        setCloudTasks(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              title: String(data.title || ''),
              completed: Boolean(data.completed),
              assignedDevice: String(data.assignedDevice || 'All Devices'),
              category: VALID_CATEGORIES.includes(data.category) ? (data.category as TaskCategory) : 'general',
              priority: VALID_PRIORITIES.includes(data.priority) ? (data.priority as TaskPriority) : 'medium',
              effortMinutes: typeof data.effortMinutes === 'number' ? data.effortMinutes : undefined,
              analysisId: typeof data.analysisId === 'string' && data.analysisId ? data.analysisId : undefined,
              createdAt: toMillis(data.createdAt),
            };
          })
        );
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, tasksPath);
      }
    );

    const unsubAnalyses = onSnapshot(
      query(collection(db, analysesPath), where('userId', '==', uid), orderBy('createdAt', 'desc'), limit(30)),
      (snap) => {
        setCloudAnalyses(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              goal: String(data.goal || ''),
              category: VALID_CATEGORIES.includes(data.category) ? (data.category as TaskCategory) : 'general',
              priority: VALID_PRIORITIES.includes(data.priority) ? (data.priority as TaskPriority) : 'medium',
              effortMinutes: typeof data.effortMinutes === 'number' ? data.effortMinutes : 15,
              recommendedDevice: String(data.recommendedDevice || 'All Devices'),
              safetyLevel: (data.safetyLevel as TaskAnalysisResult['safetyLevel']) || 'safe',
              summary: String(data.summary || ''),
              blockers: Array.isArray(data.blockers) ? (data.blockers as string[]) : [],
              subtasks: Array.isArray(data.subtasks) ? (data.subtasks as string[]) : [],
              executableSteps: Array.isArray(data.executableSteps)
                ? (data.executableSteps as TaskAnalysisResult['executableSteps'])
                : [],
              createdAt: toMillis(data.createdAt),
            };
          })
        );
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, analysesPath);
      }
    );

    const unsubRoutines = onSnapshot(
      query(collection(db, routinesPath), where('userId', '==', uid), orderBy('createdAt', 'desc'), limit(40)),
      (snap) => {
        setCloudRoutines(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              title: String(data.title || ''),
              goal: String(data.goal || ''),
              steps: Array.isArray(data.steps) ? (data.steps as RoutinePlan['steps']) : [],
              createdAt: toMillis(data.createdAt),
            };
          })
        );
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, routinesPath);
      }
    );

    const unsubMessages = onSnapshot(
      query(collection(db, messagesPath), where('userId', '==', uid), orderBy('createdAt', 'asc'), limit(80)),
      (snap) => {
        setCloudMessages(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              role: data.role === 'user' ? 'user' : 'assistant',
              text: String(data.text || ''),
              thinkingMode: data.thinkingMode === 'deep' ? 'deep' : 'fast',
              toolCalls: Array.isArray(data.toolCalls) ? (data.toolCalls as ChatMessage['toolCalls']) : [],
              sources: Array.isArray(data.sources) ? (data.sources as ChatMessage['sources']) : [],
              createdAt: toMillis(data.createdAt),
            };
          })
        );
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, messagesPath);
      }
    );

    const unsubHandoffs = onSnapshot(
      query(collection(db, handoffsPath), where('userId', '==', uid), orderBy('createdAt', 'desc'), limit(40)),
      (snap) => {
        setCloudHandoffs(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              label: String(data.label || 'Shared Note'),
              content: String(data.content || ''),
              kind: (data.kind as HandoffItem['kind']) || 'text',
              sourceDevice: String(data.sourceDevice || 'Device'),
              targetDevice: String(data.targetDevice || 'all'),
              createdAt: toMillis(data.createdAt),
            };
          })
        );
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, handoffsPath);
      }
    );

    const unsubBrain = onSnapshot(
      query(collection(db, brainPath), where('userId', '==', uid), orderBy('updatedAt', 'desc'), limit(150)),
      (snap) => {
        setCloudBrainNotes(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              title: String(data.title || 'Untitled Note'),
              slug: String(data.slug || d.id),
              folder: String(data.folder || 'General'),
              content: String(data.content || ''),
              tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
              links: Array.isArray(data.links) ? (data.links as string[]) : [],
              source:
                data.source === 'jarvis' || data.source === 'obsidian_local' ? data.source : 'user',
              createdAt: toMillis(data.createdAt),
              updatedAt: toMillis(data.updatedAt),
            };
          })
        );
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, brainPath);
      }
    );

    const unsubConnectors = onSnapshot(
      query(collection(db, connectorsPath), where('userId', '==', uid), orderBy('createdAt', 'desc'), limit(60)),
      (snap) => {
        setCloudConnectors(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              name: String(data.name || 'App'),
              category: VALID_CONNECTOR_CATS.includes(data.category)
                ? (data.category as AppConnectorCategory)
                : 'automation',
              connectorType: VALID_CONNECTOR_TYPES.includes(data.connectorType)
                ? (data.connectorType as AppConnectorType)
                : 'url_template',
              endpointOrTarget: String(data.endpointOrTarget || ''),
              method: (['GET', 'POST', 'PUT', 'PATCH', 'LAUNCH'].includes(data.method)
                ? data.method
                : 'LAUNCH') as AppConnector['method'],
              description: String(data.description || ''),
              headersJson: String(data.headersJson || '{}'),
              enabled: Boolean(data.enabled),
              requiresConfirmation: Boolean(data.requiresConfirmation),
              createdAt: toMillis(data.createdAt),
              updatedAt: toMillis(data.updatedAt),
            };
          })
        );
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, connectorsPath);
      }
    );

    return () => {
      unsubTasks();
      unsubAnalyses();
      unsubRoutines();
      unsubMessages();
      unsubHandoffs();
      unsubBrain();
      unsubConnectors();
    };
  }, [authReady, profileReady, user]);

  const signInWithGoogle = useCallback(async () => {
    setAuthError(null);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const cred = GoogleAuthProvider.credentialFromResult(result);
      if (cred?.accessToken) {
        setInMemoryGoogleAccessToken(cred.accessToken);
        setGoogleAccessToken(cred.accessToken);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Google Sign-In failed';
      if (!msg.includes('popup-closed-by-user')) {
        setAuthError(msg);
      }
    }
  }, []);

  const connectGoogleWorkspace = useCallback(async (): Promise<string | null> => {
    setAuthError(null);
    try {
      const result = auth.currentUser
        ? await reauthenticateWithPopup(auth.currentUser, googleProvider)
        : await signInWithPopup(auth, googleProvider);
      const cred = GoogleAuthProvider.credentialFromResult(result);
      const token = cred?.accessToken || null;
      if (token) {
        setInMemoryGoogleAccessToken(token);
        setGoogleAccessToken(token);
      }
      return token;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Workspace OAuth authorization failed';
      if (!msg.includes('popup-closed-by-user')) {
        setAuthError(msg);
      }
      return null;
    }
  }, []);

  const signOutUser = useCallback(async () => {
    clearInMemoryGoogleAccessToken();
    setGoogleAccessToken(null);
    await signOut(auth);
  }, []);

  const updatePreferences = useCallback(
    async (prefs: Partial<Pick<UserProfile, 'preferredVoice' | 'wakeEnabled' | 'wakeSensitivity'>>) => {
      if (!user || !profileReady) return;
      const path = `users/${user.uid}`;
      try {
        const nextPrefs = {
          ...(prefs.preferredVoice && VALID_VOICES.includes(prefs.preferredVoice)
            ? { preferredVoice: prefs.preferredVoice }
            : {}),
          ...(typeof prefs.wakeEnabled === 'boolean' ? { wakeEnabled: prefs.wakeEnabled } : {}),
          ...(typeof prefs.wakeSensitivity === 'number'
            ? { wakeSensitivity: Math.max(0, Math.min(1, prefs.wakeSensitivity)) }
            : {}),
          updatedAt: serverTimestamp(),
        };
        await updateDoc(doc(db, 'users', user.uid), nextPrefs);
        setUserProfile((prev) => (prev ? { ...prev, ...prefs } : prev));
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, path);
      }
    },
    [user, profileReady]
  );

  const saveTaskToCloud = useCallback(
    async (task: SharedTask) => {
      if (!user || !profileReady) return;
      const id = sanitizeId(task.id);
      const path = `users/${user.uid}/tasks/${id}`;
      try {
        await setDoc(doc(db, 'users', user.uid, 'tasks', id), {
          userId: user.uid,
          title: (task.title || 'Untitled Task').trim().slice(0, 240),
          completed: Boolean(task.completed),
          assignedDevice: (task.assignedDevice || 'All Devices').slice(0, 100),
          category: task.category && VALID_CATEGORIES.includes(task.category) ? task.category : 'general',
          priority: task.priority && VALID_PRIORITIES.includes(task.priority) ? task.priority : 'medium',
          effortMinutes: Math.max(0, Math.min(10000, Number(task.effortMinutes ?? 15))),
          analysisId: (task.analysisId || '').slice(0, 128),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    },
    [user, profileReady]
  );

  const toggleTaskInCloud = useCallback(
    async (taskId: string, completed: boolean) => {
      if (!user || !profileReady) return;
      const id = sanitizeId(taskId);
      const path = `users/${user.uid}/tasks/${id}`;
      try {
        await updateDoc(doc(db, 'users', user.uid, 'tasks', id), {
          completed,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, path);
      }
    },
    [user, profileReady]
  );

  const deleteTaskFromCloud = useCallback(
    async (taskId: string) => {
      if (!user || !profileReady) return;
      const id = sanitizeId(taskId);
      const path = `users/${user.uid}/tasks/${id}`;
      try {
        await deleteDoc(doc(db, 'users', user.uid, 'tasks', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, path);
      }
    },
    [user, profileReady]
  );

  const saveAnalysisToCloud = useCallback(
    async (analysis: TaskAnalysisResult) => {
      if (!user || !profileReady) return;
      const id = sanitizeId(analysis.id);
      const path = `users/${user.uid}/analyses/${id}`;
      try {
        await setDoc(doc(db, 'users', user.uid, 'analyses', id), {
          userId: user.uid,
          goal: (analysis.goal || 'Task Analysis').trim().slice(0, 600),
          category: VALID_CATEGORIES.includes(analysis.category) ? analysis.category : 'general',
          priority: VALID_PRIORITIES.includes(analysis.priority) ? analysis.priority : 'medium',
          effortMinutes: Math.max(0, Math.min(10000, Number(analysis.effortMinutes || 15))),
          recommendedDevice: (analysis.recommendedDevice || 'All Devices').slice(0, 100),
          safetyLevel: ['safe', 'moderate', 'sensitive'].includes(analysis.safetyLevel)
            ? analysis.safetyLevel
            : 'safe',
          summary: (analysis.summary || 'Analysis completed.').slice(0, 1500),
          blockers: (analysis.blockers || []).slice(0, 12).map((b) => String(b).slice(0, 300)),
          subtasks: (analysis.subtasks || []).slice(0, 15).map((s) => String(s).slice(0, 240)),
          executableSteps: (analysis.executableSteps || []).slice(0, 10),
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    },
    [user, profileReady]
  );

  const deleteAnalysisFromCloud = useCallback(
    async (analysisId: string) => {
      if (!user || !profileReady) return;
      const id = sanitizeId(analysisId);
      const path = `users/${user.uid}/analyses/${id}`;
      try {
        await deleteDoc(doc(db, 'users', user.uid, 'analyses', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, path);
      }
    },
    [user, profileReady]
  );

  const saveRoutineToCloud = useCallback(
    async (routine: RoutinePlan) => {
      if (!user || !profileReady) return;
      const id = sanitizeId(routine.id);
      const path = `users/${user.uid}/routines/${id}`;
      try {
        await setDoc(doc(db, 'users', user.uid, 'routines', id), {
          userId: user.uid,
          title: (routine.title || 'Custom Routine').slice(0, 160),
          goal: (routine.goal || routine.title || 'Automation').slice(0, 500),
          steps: (routine.steps || []).slice(0, 15),
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    },
    [user, profileReady]
  );

  const deleteRoutineFromCloud = useCallback(
    async (routineId: string) => {
      if (!user || !profileReady) return;
      const id = sanitizeId(routineId);
      const path = `users/${user.uid}/routines/${id}`;
      try {
        await deleteDoc(doc(db, 'users', user.uid, 'routines', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, path);
      }
    },
    [user, profileReady]
  );

  const inflightMessageWritesRef = React.useRef<Map<string, Promise<void>>>(new Map());

  const saveMessageToCloud = useCallback(
    async (roomId: string, msg: ChatMessage) => {
      if (!user || !profileReady) return;
      const id = sanitizeId(msg.id);
      const path = `users/${user.uid}/messages/${id}`;
      const normalizedRoom = (roomId || 'RLY-HOME').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24) || 'RLY-HOME';
      const writePromise = (async () => {
        try {
          await setDoc(doc(db, 'users', user.uid, 'messages', id), {
            userId: user.uid,
            roomId: normalizedRoom.length >= 3 ? normalizedRoom : 'RLY-HOME',
            role: msg.role === 'user' ? 'user' : 'assistant',
            text: (msg.text || '').slice(0, 20000),
            thinkingMode: msg.thinkingMode === 'deep' ? 'deep' : 'fast',
            toolCalls: (msg.toolCalls || []).slice(0, 20).map((tc) => ({
              id: tc.id,
              name: tc.name,
              args: tc.args || {},
              status: tc.status,
              result: (tc.result || '').slice(0, 800),
            })),
            sources: (msg.sources || []).slice(0, 20),
            createdAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, path);
        }
      })();
      inflightMessageWritesRef.current.set(id, writePromise);
      try {
        await writePromise;
      } finally {
        if (inflightMessageWritesRef.current.get(id) === writePromise) {
          inflightMessageWritesRef.current.delete(id);
        }
      }
    },
    [user, profileReady]
  );

  const updateMessageInCloud = useCallback(
    async (msgId: string, patch: Pick<ChatMessage, 'text' | 'toolCalls' | 'sources'>) => {
      if (!user || !profileReady) return;
      const id = sanitizeId(msgId);
      const pending = inflightMessageWritesRef.current.get(id);
      if (pending) {
        await pending.catch(() => {});
      }
      const path = `users/${user.uid}/messages/${id}`;
      try {
        await updateDoc(doc(db, 'users', user.uid, 'messages', id), {
          text: (patch.text || '').slice(0, 20000),
          toolCalls: (patch.toolCalls || []).slice(0, 20).map((tc) => ({
            id: tc.id,
            name: tc.name,
            args: tc.args || {},
            status: tc.status,
            result: (tc.result || '').slice(0, 800),
          })),
          sources: (patch.sources || []).slice(0, 20),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, path);
      }
    },
    [user, profileReady]
  );

  const clearMessagesInCloud = useCallback(async () => {
    if (!user || !profileReady || cloudMessages.length === 0) return;
    const path = `users/${user.uid}/messages`;
    try {
      const batch = writeBatch(db);
      for (const m of cloudMessages) {
        batch.delete(doc(db, 'users', user.uid, 'messages', sanitizeId(m.id)));
      }
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  }, [user, profileReady, cloudMessages]);

  const saveHandoffToCloud = useCallback(
    async (item: HandoffItem) => {
      if (!user || !profileReady) return;
      if (item.content.length > 440000) return;
      const id = sanitizeId(item.id);
      const path = `users/${user.uid}/handoffs/${id}`;
      try {
        await setDoc(doc(db, 'users', user.uid, 'handoffs', id), {
          userId: user.uid,
          label: (item.label || 'Shared Note').slice(0, 140),
          content: item.content.slice(0, 440000),
          kind: ['text', 'link', 'code', 'image'].includes(item.kind) ? item.kind : 'text',
          sourceDevice: (item.sourceDevice || 'Device').slice(0, 120),
          targetDevice: (item.targetDevice || 'all').slice(0, 120),
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    },
    [user, profileReady]
  );

  const deleteHandoffFromCloud = useCallback(
    async (itemId: string) => {
      if (!user || !profileReady) return;
      const id = sanitizeId(itemId);
      const path = `users/${user.uid}/handoffs/${id}`;
      try {
        await deleteDoc(doc(db, 'users', user.uid, 'handoffs', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, path);
      }
    },
    [user, profileReady]
  );

  const saveBrainNoteToCloud = useCallback(
    async (note: BrainNote) => {
      if (!user || !profileReady) return;
      const id = sanitizeId(note.id);
      const path = `users/${user.uid}/brainNotes/${id}`;
      try {
        await setDoc(doc(db, 'users', user.uid, 'brainNotes', id), {
          userId: user.uid,
          title: (note.title || 'Untitled Note').slice(0, 140),
          slug: (note.slug || id).slice(0, 160),
          folder: (note.folder || 'General').slice(0, 80),
          content: (note.content || '').slice(0, 120000),
          tags: (note.tags || []).slice(0, 30).map((t) => String(t).slice(0, 40)),
          links: (note.links || []).slice(0, 50).map((l) => String(l).slice(0, 140)),
          source: ['user', 'jarvis', 'obsidian_local'].includes(note.source) ? note.source : 'user',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    },
    [user, profileReady]
  );

  const deleteBrainNoteFromCloud = useCallback(
    async (noteId: string) => {
      if (!user || !profileReady) return;
      const id = sanitizeId(noteId);
      const path = `users/${user.uid}/brainNotes/${id}`;
      try {
        await deleteDoc(doc(db, 'users', user.uid, 'brainNotes', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, path);
      }
    },
    [user, profileReady]
  );

  const saveConnectorToCloud = useCallback(
    async (connector: AppConnector) => {
      if (!user || !profileReady) return;
      const id = sanitizeId(connector.id);
      const path = `users/${user.uid}/connectors/${id}`;
      try {
        await setDoc(doc(db, 'users', user.uid, 'connectors', id), {
          userId: user.uid,
          name: (connector.name || 'App').slice(0, 80),
          category: VALID_CONNECTOR_CATS.includes(connector.category) ? connector.category : 'automation',
          connectorType: VALID_CONNECTOR_TYPES.includes(connector.connectorType)
            ? connector.connectorType
            : 'url_template',
          endpointOrTarget: (connector.endpointOrTarget || '').slice(0, 600),
          method: ['GET', 'POST', 'PUT', 'PATCH', 'LAUNCH'].includes(connector.method)
            ? connector.method
            : 'LAUNCH',
          description: (connector.description || '').slice(0, 300),
          headersJson: (connector.headersJson || '{}').slice(0, 2000),
          enabled: Boolean(connector.enabled),
          requiresConfirmation: Boolean(connector.requiresConfirmation),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    },
    [user, profileReady]
  );

  const deleteConnectorFromCloud = useCallback(
    async (connectorId: string) => {
      if (!user || !profileReady) return;
      const id = sanitizeId(connectorId);
      const path = `users/${user.uid}/connectors/${id}`;
      try {
        await deleteDoc(doc(db, 'users', user.uid, 'connectors', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, path);
      }
    },
    [user, profileReady]
  );

  return (
    <FirebaseContext.Provider
      value={{
        user,
        authReady,
        profileReady,
        authError,
        googleAccessToken,
        userProfile,
        cloudTasks,
        cloudAnalyses,
        cloudRoutines,
        cloudMessages,
        cloudHandoffs,
        cloudBrainNotes,
        cloudConnectors,
        signInWithGoogle,
        connectGoogleWorkspace,
        signOutUser,
        updatePreferences,
        saveTaskToCloud,
        toggleTaskInCloud,
        deleteTaskFromCloud,
        saveAnalysisToCloud,
        deleteAnalysisFromCloud,
        saveRoutineToCloud,
        deleteRoutineFromCloud,
        saveMessageToCloud,
        updateMessageInCloud,
        clearMessagesInCloud,
        saveHandoffToCloud,
        deleteHandoffFromCloud,
        saveBrainNoteToCloud,
        deleteBrainNoteFromCloud,
        saveConnectorToCloud,
        deleteConnectorFromCloud,
      }}
    >
      {children}
    </FirebaseContext.Provider>
  );
};

export function useFirebase(): FirebaseContextValue {
  const ctx = useContext(FirebaseContext);
  if (!ctx) {
    throw new Error('useFirebase must be used inside FirebaseProvider');
  }
  return ctx;
}
